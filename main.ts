// mend: apply an edit an AI model wrote to a tree of text files.
//
// One command-line tool, Node 22 and its standard library alone. It reads a
// patch in one of four formats — a unified diff, SEARCH/REPLACE blocks, the
// V4A patch format, or JSON text-editor tool calls — finds the lines each
// edit names at the first of three matching tiers, and writes every change
// or none at all. Run it as `node main.ts [options] [PATCH]` from the root
// of the tree. The whole contract is SPEC.md in the kit.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const KNOWN_FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 condition: the single line to print. */
class ParseProblem {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

/** One edit that failed: its code and the path it concerns. */
class EditProblem {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';
const trailWs = (s: string): string => s.replace(/[ \t]+$/, '');
const edgeWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** A patch's lines: split at \n, one trailing \r removed each, no empty piece after a final \n. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

/** A path is safe when it is not empty, not absolute, holds no backslash, and no segment is empty, . or ... */
function pathIsSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** Compare two paths in UTF-8 byte order. */
function pathOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * One file, as lines: its break (CRLF when its first line feed follows a
 * carriage return, LF otherwise), its lines, and whether it ends with a break.
 */
class Doc {
  readonly br: string;
  readonly lines: string[];
  readonly fin: boolean;
  constructor(br: string, lines: string[], fin: boolean) {
    this.br = br;
    this.lines = lines;
    this.fin = fin;
  }
  text(): string {
    if (this.lines.length === 0) return '';
    return this.lines.join(this.br) + (this.fin ? this.br : '');
  }
}

function docFromText(text: string): Doc {
  if (text === '') return new Doc('\n', [], false);
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return new Doc(br, parts, fin);
}

const emptyDoc = (): Doc => new Doc('\n', [], false);

/**
 * The tree as the edits leave it. `current` holds paths an edit changed
 * (null: deleted); anything else is read from disk on demand and remembered
 * in `seen`, so the output can tell what changed.
 */
class WorkTree {
  private readonly seen = new Map<string, Doc | null>();
  readonly current = new Map<string, Doc | null>();
  readonly moves: { from: string; to: string }[] = [];
  disk(p: string): Doc | null {
    if (!this.seen.has(p)) {
      let d: Doc | null = null;
      try {
        if (statSync(p).isFile()) d = docFromText(readFileSync(p, 'utf8'));
      } catch {
        d = null;
      }
      this.seen.set(p, d);
    }
    return this.seen.get(p) ?? null;
  }
  at(p: string): Doc | null {
    return this.current.has(p) ? this.current.get(p) ?? null : this.disk(p);
  }
  put(p: string, d: Doc | null): void {
    this.current.set(p, d);
  }
}

type EditFn = (tree: WorkTree) => void;

function needSafe(p: string): void {
  if (!pathIsSafe(p)) throw new EditProblem('unsafe', p);
}

/** The file at p must exist; its Doc, else a missing failure. */
function needFile(tree: WorkTree, p: string): Doc {
  needSafe(p);
  const d = tree.at(p);
  if (d === null) throw new EditProblem('missing', p);
  return d;
}

// ---------------------------------------------------------------------------
// Matching lines (SPEC.md section 5)
// ---------------------------------------------------------------------------

/** Do two lines match at a tier: 0 every line equal, 1 trailing spaces and tabs removed, 2 both edges removed. */
function linesMatch(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trailWs(a) === trailWs(b);
  return edgeWs(a) === edgeWs(b);
}

/** Every position at or after `from` where `old` occurs in `file` at a tier. */
function occurrences(file: string[], old: string[], tier: number, from: number): number[] {
  const hits: number[] = [];
  if (old.length === 0) return hits;
  for (let i = Math.max(0, from); i + old.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < old.length; j++) {
      if (!linesMatch(file[i + j]!, old[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits;
}

/** The first tier at which `old` occurs at or after `from`, with its positions, or null. */
function firstTier(file: string[], old: string[], from: number): { tier: number; at: number[] } | null {
  for (let tier = 0; tier <= 2; tier++) {
    const at = occurrences(file, old, tier, from);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** One line of a chunk: a context line, a line taken out, or a line put in. */
interface ChunkLine {
  kind: 'ctx' | 'del' | 'add';
  text: string;
}

/** The old lines of a chunk (context and taken-out lines), in order. */
function chunkOld(ops: ChunkLine[]): string[] {
  return ops.filter((o) => o.kind !== 'add').map((o) => o.text);
}

/**
 * The new lines of a chunk: each context line paired with the file line it
 * stands for, each added line on its own. `oldPos` is the context line's
 * index inside the old lines, so it can be swapped for the file's own line.
 */
function chunkNew(ops: ChunkLine[]): { text: string; oldPos: number }[] {
  const out: { text: string; oldPos: number }[] = [];
  let oldPos = 0;
  for (const o of ops) {
    if (o.kind === 'del') {
      oldPos++;
    } else if (o.kind === 'ctx') {
      out.push({ text: o.text, oldPos });
      oldPos++;
    } else {
      out.push({ text: o.text, oldPos: -1 });
    }
  }
  return out;
}

/**
 * Build the lines that replace a matched run. Context lines come from the
 * file itself, never the patch. At tier 2 every other (added) line is
 * re-indented: P is the leading spaces and tabs of the old lines' first
 * line, F those of the file's first matched line; an added line that is not
 * empty or only whitespace and starts with P has that P replaced by F.
 */
function buildReplacement(
  file: string[],
  pos: number,
  tier: number,
  ops: ChunkLine[],
): string[] {
  const old = chunkOld(ops);
  const fresh = chunkNew(ops);
  let reindent: ((s: string) => string) | null = null;
  if (tier === 2 && old.length > 0) {
    const p = leadWs(old[0]!);
    const f = leadWs(file[pos]!);
    reindent = (s: string): string => {
      if (s === '' || s.trim() === '' || !s.startsWith(p)) return s;
      return f + s.slice(p.length);
    };
  }
  return fresh.map((e) => {
    if (e.oldPos >= 0) return file[pos + e.oldPos]!;
    return reindent === null ? e.text : reindent(e.text);
  });
}

/**
 * Replace the run of `old` at `pos` in `doc` with the chunk's new lines,
 * keeping the doc's break. The final break is decided by the caller.
 */
function spliceChunk(doc: Doc, pos: number, tier: number, ops: ChunkLine[]): string[] {
  const old = chunkOld(ops);
  const region = buildReplacement(doc.lines, pos, tier, ops);
  return [...doc.lines.slice(0, pos), ...region, ...doc.lines.slice(pos + old.length)];
}

// ---------------------------------------------------------------------------
// Detecting the format (SPEC.md section 4)
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

/** A hunk: its old line number, its body lines, and whether a \ line follows its last context or + line. */
interface Hunk {
  at: number;
  ops: ChunkLine[];
  noBreak: boolean;
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` or `+++ `: up to the first tab, surrounding spaces removed, a leading a/ or b/ removed. */
function headerPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)\s*$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** A body line starts a hunk body, or is empty (an empty context line). */
function isBodyLine(l: string): boolean {
  return l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\';
}

/**
 * Parse one hunk at `head` (its @@ line). Returns the hunk and the index
 * after its body. A body ends at the first other line, a diff --git line, a
 * --- line followed by a +++ line, or the end of the patch; empty lines at
 * the end of a body are not part of it.
 */
function readHunk(lines: string[], head: number): { hunk: Hunk; next: number } {
  const m = HUNK_HEAD.exec(lines[head]!);
  if (m === null) throw new ParseProblem(`error: parse ${head + 1}`);
  const items: ({ op: ChunkLine } | { mark: true })[] = [];
  let i = head + 1;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (!isBodyLine(l)) break;
    if (l === '') items.push({ op: { kind: 'ctx', text: '' } });
    else if (l[0] === ' ') items.push({ op: { kind: 'ctx', text: l.slice(1) } });
    else if (l[0] === '-') items.push({ op: { kind: 'del', text: l.slice(1) } });
    else if (l[0] === '+') items.push({ op: { kind: 'add', text: l.slice(1) } });
    else items.push({ mark: true });
    i++;
  }
  // Empty lines at the end of a body are not part of it.
  while (items.length > 0) {
    const last = items[items.length - 1]!;
    if ('op' in last && last.op.kind === 'ctx' && last.op.text === '') items.pop();
    else break;
  }
  const ops: ChunkLine[] = [];
  for (const it of items) if ('op' in it) ops.push(it.op);
  // A \ line follows the hunk's last context or + line.
  let noBreak = false;
  for (let k = items.length - 1; k >= 0; k--) {
    const it = items[k]!;
    if ('op' in it && it.op.kind !== 'del') {
      if (k + 1 < items.length && 'mark' in items[k + 1]!) noBreak = true;
      break;
    }
  }
  return { hunk: { at: Number(m[1]), ops, noBreak }, next: i };
}

/**
 * Parse a section's header, starting at `i`: the ---/+++ pair, rename
 * lines, new/deleted file mode, and the lines it ignores. Returns the index
 * of the first hunk header, the next section, or the end of the patch.
 */
function readSectionHead(lines: string[], i: number, sec: Section): number {
  let sawPaths = false;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('@@')) return i;
    if (l.startsWith('diff --git ')) return i;
    if (l.startsWith('--- ')) {
      if (sawPaths) return i;
      if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new ParseProblem(`error: parse ${i + 2}`);
      sec.oldPath = headerPath(l);
      sec.newPath = headerPath(lines[i + 1]!);
      sawPaths = true;
      i += 2;
      continue;
    }
    if (l.startsWith('rename from ')) {
      sec.oldPath = l.slice('rename from '.length).trim();
      i++;
      continue;
    }
    if (l.startsWith('rename to ')) {
      sec.newPath = l.slice('rename to '.length).trim();
      i++;
      continue;
    }
    if (l.startsWith('new file mode')) {
      sec.create = true;
      i++;
      continue;
    }
    if (l.startsWith('deleted file mode')) {
      sec.remove = true;
      i++;
      continue;
    }
    i++;
  }
  return i;
}

/** Read a section's hunks from `i` until a line that is not a hunk header. */
function readSectionHunks(lines: string[], i: number, sec: Section): number {
  while (i < lines.length) {
    const l = lines[i]!;
    if (!l.startsWith('@@')) return i;
    const { hunk, next } = readHunk(lines, i);
    sec.hunks.push(hunk);
    i = next;
  }
  return i;
}

function parseUnified(lines: string[], strict: boolean): EditFn[] {
  const edits: EditFn[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(l);
      if (m === null) throw new ParseProblem(`error: parse ${i + 1}`);
      const sec: Section = { oldPath: m[1]!, newPath: m[2]!, create: false, remove: false, hunks: [] };
      i++;
      i = readSectionHead(lines, i, sec);
      i = readSectionHunks(lines, i, sec);
      edits.push(unifiedEdit(sec, strict));
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: Section = { oldPath: null, newPath: null, create: false, remove: false, hunks: [] };
      i = readSectionHead(lines, i, sec);
      i = readSectionHunks(lines, i, sec);
      edits.push(unifiedEdit(sec, strict));
    } else if (l.startsWith('@@')) {
      throw new ParseProblem(`error: parse ${i + 1}`);
    } else {
      i++;
    }
  }
  if (edits.length === 0) throw new ParseProblem('error: parse 1');
  return edits;
}

/**
 * Apply one hunk to a doc. `d` is the section's line-count drift so far, and
 * the hunk returns its own drift. A hunk whose old lines are not found fails
 * the section; an empty old block is inserted after the first A + d lines.
 */
function applyHunk(doc: Doc, hunk: Hunk, d: number, strict: boolean, path: string): { doc: Doc; drift: number } {
  const old = chunkOld(hunk.ops);
  const fresh = chunkNew(hunk.ops);
  if (old.length === 0) {
    const at = Math.min(hunk.at + d, doc.lines.length);
    const lines = [...doc.lines.slice(0, at), ...fresh.map((e) => e.text), ...doc.lines.slice(at)];
    const fin = at === doc.lines.length ? !hunk.noBreak : doc.fin;
    return { doc: new Doc(doc.br, lines, fin), drift: fresh.length };
  }
  const found = strict
    ? (() => {
        const at = occurrences(doc.lines, old, 0, 0);
        return at.length > 0 ? { tier: 0, at } : null;
      })()
    : firstTier(doc.lines, old, 0);
  if (found === null) throw new EditProblem('no-match', path);
  const target = hunk.at - 1 + d;
  let pos = found.at[0]!;
  for (const p of found.at) {
    if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
  }
  const lines = spliceChunk(doc, pos, found.tier, hunk.ops);
  const runsToEnd = pos + old.length === doc.lines.length;
  const fin = runsToEnd ? !hunk.noBreak : doc.fin;
  return { doc: new Doc(doc.br, lines, fin), drift: fresh.length - old.length };
}

/** One unified section as an edit. */
function unifiedEdit(sec: Section, strict: boolean): EditFn {
  const isCreate = sec.create || sec.oldPath === null;
  const isDelete = !isCreate && (sec.remove || sec.newPath === null);
  const isMove = !isCreate && !isDelete && sec.oldPath !== null && sec.newPath !== null && sec.oldPath !== sec.newPath;
  if (isCreate) {
    const path = sec.newPath!;
    return (tree) => {
      needSafe(path);
      if (tree.at(path) !== null) throw new EditProblem('exists', path);
      const plus: string[] = [];
      for (const h of sec.hunks) {
        for (const o of h.ops) if (o.kind === 'add') plus.push(o.text);
      }
      let fin = plus.length > 0;
      if (fin) {
        const lastHunk = sec.hunks[sec.hunks.length - 1];
        if (lastHunk !== undefined && lastHunk.noBreak) fin = false;
      }
      tree.put(path, new Doc('\n', plus, fin));
    };
  }
  if (isDelete) {
    const path = sec.oldPath!;
    return (tree) => {
      needSafe(path);
      if (tree.at(path) === null) throw new EditProblem('missing', path);
      tree.put(path, null);
    };
  }
  if (isMove) {
    const from = sec.oldPath!;
    const to = sec.newPath!;
    return (tree) => {
      needSafe(from);
      needSafe(to);
      const src = tree.at(from);
      if (src === null) throw new EditProblem('missing', from);
      if (tree.at(to) !== null) throw new EditProblem('exists', to);
      let doc = src;
      let d = 0;
      for (const h of sec.hunks) {
        const r = applyHunk(doc, h, d, strict, from);
        doc = r.doc;
        d += r.drift;
      }
      tree.put(from, null);
      tree.put(to, doc);
      tree.moves.push({ from, to });
    };
  }
  const path = sec.oldPath!;
  return (tree) => {
    const src = needFile(tree, path);
    let doc = src;
    let d = 0;
    for (const h of sec.hunks) {
      const r = applyHunk(doc, h, d, strict, path);
      doc = r.doc;
      d += r.drift;
    }
    tree.put(path, doc);
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): EditFn {
  if (oldLines.length === 0) {
    return (tree) => {
      needSafe(path);
      if (tree.at(path) !== null) throw new EditProblem('exists', path);
      tree.put(path, new Doc('\n', newLines, newLines.length > 0));
    };
  }
  const ops: ChunkLine[] = [
    ...oldLines.map((t): ChunkLine => ({ kind: 'del' as const, text: t })),
    ...newLines.map((t): ChunkLine => ({ kind: 'add' as const, text: t })),
  ];
  return (tree) => {
    const src = needFile(tree, path);
    const found = strict
      ? (() => {
          const at = occurrences(src.lines, oldLines, 0, 0);
          return at.length > 0 ? { tier: 0, at } : null;
        })()
      : firstTier(src.lines, oldLines, 0);
    if (found === null) throw new EditProblem('no-match', path);
    if (found.at.length > 1) throw new EditProblem('ambiguous', path);
    const lines = spliceChunk(src, found.at[0]!, found.tier, ops);
    tree.put(path, new Doc(src.br, lines, src.fin));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): EditFn[] {
  const edits: EditFn[] = [];
  let i = 0;
  let prevEnd = 0;
  let prevPath: string | null = null;
  while (i < lines.length) {
    let sIdx = -1;
    for (let j = i; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        sIdx = j;
        break;
      }
    }
    if (sIdx < 0) break;
    let path: string | null = null;
    for (let j = sIdx - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (isBlank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new ParseProblem(`error: parse ${sIdx + 1}`);
    }
    let eqIdx = -1;
    for (let j = sIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eqIdx = j;
        break;
      }
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
    }
    if (eqIdx < 0) throw new ParseProblem(`error: parse ${sIdx + 1}`);
    let repIdx = -1;
    for (let j = eqIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        repIdx = j;
        break;
      }
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
    }
    if (repIdx < 0) throw new ParseProblem(`error: parse ${sIdx + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(sIdx + 1, eqIdx), lines.slice(eqIdx + 1, repIdx), strict));
    prevPath = path;
    prevEnd = repIdx + 1;
    i = repIdx + 1;
  }
  if (edits.length === 0) throw new ParseProblem('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

/** One chunk of an Update File section: its anchor, its body lines, and whether it is anchored to the end of the file. */
interface VChunk {
  anchor: string | null;
  ops: ChunkLine[];
  eof: boolean;
}

const V4A_SECTION = /^\*\*\* (Add File|Delete File|Update File): (.*)$/;

/**
 * Read the chunks of an Update File section from `start` until a section
 * start or `end` (the index of the last non-blank line, *** End Patch).
 * A chunk starts at an @@ line, or, for the first chunk, at a body line.
 */
function readV4AChunks(lines: string[], start: number, end: number): { chunks: VChunk[]; next: number } {
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  let first = true;
  let i = start;
  const flush = (): void => {
    if (cur !== null) {
      chunks.push(cur);
      cur = null;
    }
  };
  while (i < end) {
    const l = lines[i]!;
    if (V4A_SECTION.test(l)) break;
    if (l === '*** End of File') {
      if (cur === null) throw new ParseProblem(`error: parse ${i + 1}`);
      cur.eof = true;
      flush();
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      flush();
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, ops: [], eof: false };
      first = false;
      i++;
      continue;
    }
    if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
      if (cur === null) {
        // A blank line after a chunk ended is a separator, not a body line:
        // blank lines at the end of a section are not part of it. A blank
        // line before any chunk, though, opens the first chunk as an empty
        // context line, since a body line may be empty.
        if (l === '' && !first) {
          i++;
          continue;
        }
        if (!first) throw new ParseProblem(`error: parse ${i + 1}`);
        cur = { anchor: null, ops: [], eof: false };
        first = false;
      }
      if (l === '') cur.ops.push({ kind: 'ctx', text: '' });
      else if (l[0] === ' ') cur.ops.push({ kind: 'ctx', text: l.slice(1) });
      else if (l[0] === '-') cur.ops.push({ kind: 'del', text: l.slice(1) });
      else cur.ops.push({ kind: 'add', text: l.slice(1) });
      i++;
      continue;
    }
    throw new ParseProblem(`error: parse ${i + 1}`);
  }
  flush();
  // Blank lines at the end of a section are not part of it.
  const last = chunks[chunks.length - 1];
  if (last !== undefined && !last.eof) {
    while (last.ops.length > 0) {
      const o = last.ops[last.ops.length - 1]!;
      if (o.kind === 'ctx' && o.text === '') last.ops.pop();
      else break;
    }
  }
  return { chunks, next: i };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): EditFn {
  return (tree) => {
    if (moveTo !== null) needSafe(moveTo);
    const src = needFile(tree, path);
    if (moveTo !== null && tree.at(moveTo) !== null) throw new EditProblem('exists', moveTo);
    let lines = [...src.lines];
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const hit = strict
          ? occurrences(lines, [ch.anchor], 0, cursor)
          : (() => {
              for (let t = 0; t <= 2; t++) {
                const at = occurrences(lines, [ch.anchor], t, cursor);
                if (at.length > 0) return at;
              }
              return [];
            })();
        if (hit.length === 0) throw new EditProblem('no-match', path);
        cursor = hit[0]! + 1;
      }
      const old = chunkOld(ch.ops);
      if (old.length === 0) {
        const at = ch.eof ? lines.length : cursor;
        const fresh = chunkNew(ch.ops).map((e) => e.text);
        lines = [...lines.slice(0, at), ...fresh, ...lines.slice(at)];
        cursor = at + fresh.length;
        continue;
      }
      const tiers = strict ? [0] : [0, 1, 2];
      let found: { tier: number; at: number[] } | null = null;
      for (const t of tiers) {
        let at = occurrences(lines, old, t, cursor);
        if (ch.eof) at = at.filter((p) => p + old.length === lines.length);
        if (at.length > 0) {
          found = { tier: t, at };
          break;
        }
      }
      if (found === null) throw new EditProblem('no-match', path);
      const pos = found.at[0]!;
      const region = buildReplacement(lines, pos, found.tier, ch.ops);
      lines = [...lines.slice(0, pos), ...region, ...lines.slice(pos + old.length)];
      cursor = pos + region.length;
    }
    const out = new Doc(src.br, lines, src.fin);
    if (moveTo !== null) {
      tree.put(path, null);
      tree.put(moveTo, out);
      tree.moves.push({ from: path, to: moveTo });
    } else {
      tree.put(path, out);
    }
  };
}

function parseV4A(lines: string[], strict: boolean): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseProblem('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseProblem(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && isBlank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new ParseProblem(`error: parse ${lines.length + 1}`);
  const edits: EditFn[] = [];
  let i = first + 1;
  while (i < last) {
    while (i < last && isBlank(lines[i]!)) i++;
    if (i >= last) break;
    const m = V4A_SECTION.exec(lines[i]!);
    if (m === null) throw new ParseProblem(`error: parse ${i + 1}`);
    const kind = m[1]!;
    const path = m[2]!.trim();
    i++;
    if (kind === 'Add File') {
      const fileLines: string[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (V4A_SECTION.test(l)) break;
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new ParseProblem(`error: parse ${i + 1}`);
        i++;
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      edits.push((tree) => {
        needSafe(path);
        if (tree.at(path) !== null) throw new EditProblem('exists', path);
        tree.put(path, new Doc('\n', fileLines, fileLines.length > 0));
      });
    } else if (kind === 'Delete File') {
      while (i < last) {
        const l = lines[i]!;
        if (V4A_SECTION.test(l)) break;
        if (isBlank(l)) {
          i++;
          continue;
        }
        throw new ParseProblem(`error: parse ${i + 1}`);
      }
      edits.push((tree) => {
        needSafe(path);
        if (tree.at(path) === null) throw new EditProblem('missing', path);
        tree.put(path, null);
      });
    } else {
      const updateLine = i - 1;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const { chunks, next } = readV4AChunks(lines, i, last);
      i = next;
      if (chunks.length === 0 && moveTo === null) throw new ParseProblem(`error: parse ${updateLine + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
    }
  }
  if (edits.length === 0) throw new ParseProblem('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): EditFn | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      needSafe(p);
      if (tree.at(p) !== null) throw new EditProblem('exists', p);
      tree.put(p, docFromText(text));
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = needFile(tree, p);
      const text = before.text();
      const crlf = before.br === '\r\n';
      const flat = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = flat(text);
      const old = flat(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count++;
      if (count === 0) throw new EditProblem('no-match', p);
      if (count > 1) throw new EditProblem('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + flat(newStr) + t.slice(at + old.length);
      tree.put(p, docFromText(crlf ? out.replaceAll('\n', '\r\n') : out));
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = splitPatch(o.new_str);
    return (tree) => {
      const before = needFile(tree, p);
      if (line < 0 || line > before.lines.length) throw new EditProblem('no-match', p);
      const lines = [...before.lines];
      lines.splice(line, 0, ...add);
      tree.put(p, new Doc(before.br, lines, before.fin));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseProblem('error: parse 1');
  const edits: EditFn[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseProblem(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new ParseProblem(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new ParseProblem(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: EditFn | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseProblem(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Invocation, output and the write (SPEC.md sections 1, 2, 3 and 10)
// ---------------------------------------------------------------------------

function parseEdits(kind: string, text: string, lines: string[], strict: boolean): EditFn[] {
  if (kind === 'json') return parseJson(text, lines);
  if (kind === 'unified') return parseUnified(lines, strict);
  if (kind === 'search-replace') return parseSearchReplace(lines, strict);
  return parseV4A(lines, strict);
}

/** The change lines for exit 0, in byte order of the paths (a move sorts by its new path). */
function changeLines(tree: WorkTree): string[] {
  type Row = { key: string; line: string };
  const rows: Row[] = [];
  const covered = new Set<string>();
  for (const mv of tree.moves) {
    const wasFrom = tree.disk(mv.from);
    const nowFrom = tree.at(mv.from);
    const wasTo = tree.disk(mv.to);
    const nowTo = tree.at(mv.to);
    if (wasFrom !== null && nowFrom === null && wasTo === null && nowTo !== null) {
      rows.push({ key: mv.to, line: `R ${mv.from} -> ${mv.to}` });
      covered.add(mv.from);
      covered.add(mv.to);
    }
  }
  for (const p of [...tree.current.keys()].sort(pathOrder)) {
    if (covered.has(p)) continue;
    const was = tree.disk(p);
    const now = tree.current.get(p) ?? null;
    const wasText = was === null ? null : was.text();
    const nowText = now === null ? null : now.text();
    if (wasText === nowText) continue;
    const line = wasText === null ? `A ${p}` : nowText === null ? `D ${p}` : `M ${p}`;
    rows.push({ key: p, line });
  }
  rows.sort((a, b) => pathOrder(a.key, b.key));
  return rows.map((r) => r.line);
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && KNOWN_FORMATS.includes(a.slice(9))) {
        format = a.slice(9);
      } else if (a === '--check' && !check) {
        check = true;
      } else if (a === '--strict' && !strict) {
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: EditFn[];
  try {
    edits = parseEdits(kind, text, lines, strict);
  } catch (e) {
    if (e instanceof ParseProblem) return { code: 2, out: [e.text] };
    throw e;
  }
  const tree = new WorkTree();
  const fails: EditProblem[] = [];
  for (const edit of edits) {
    const snapNow = new Map(tree.current);
    const snapMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditProblem)) throw e;
      tree.current.clear();
      for (const [k, v] of snapNow) tree.current.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...snapMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  const rows = changeLines(tree);
  if (!check) {
    for (const p of [...tree.current.keys()].sort(pathOrder)) {
      const was = tree.disk(p);
      const now = tree.current.get(p) ?? null;
      const wasText = was === null ? null : was.text();
      const nowText = now === null ? null : now.text();
      if (wasText === nowText) continue;
      if (now === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now.text());
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
