# mend

mend applies an edit that an AI model wrote to a tree of text files, in four
formats: a unified diff, SEARCH/REPLACE blocks, the V4A patch format, and JSON
text-editor tool calls. It finds the lines each edit names at the first of
three matching tiers, and writes every change or none (all-or-nothing).

Run it as `node main.ts [options] [PATCH]` from the root of the tree.
`SPEC.md` in the kit is the whole specification.

## Entry

- Repo: ngkaz-prog-hidden-spec-cli-01
- Owner: ngkaz-prog
- Referral: https://make.fun/r/44s381bx
