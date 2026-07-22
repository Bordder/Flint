# Working on Flint

Flint is a private, fully-offline Windows journal (Electron, vanilla JS, no
bundler). Someone's diary is the data, so the bar for anything touching
`store.js` or `crypto.js` is higher than the code size suggests.

## Search with the Grep tool, not `grep` through Bash

Use the built-in **Grep** and **Glob** tools rather than shelling out to `grep`,
`find`, `cat`, `head`, `tail` or `rg`. This is not a style preference:

- Shelling out runs `C:\Program Files\Git\usr\bin\grep.exe`, a Unix binary in an
  unusual location, spawned by a non-interactive parent, and often with a long
  escaped alternation pattern. On 2026-07-22 that combination set off this
  machine's endpoint protection. The pattern searched function names in
  `store.js` and did nothing else, but it read to a heuristic as credential or
  settings enumeration.
- The Grep tool uses ripgrep in-process, spawns nothing, and does not trip it.

This applies to subagents too. If you launch a Workflow or Agent that will search
the codebase, say so in its prompt: agents default to Bash otherwise.

Use Bash for what it is actually for: `git`, `npm`, `node`, builds, and running
the test suites.

## Verifying changes

- `npm test` is the data-layer suite. Green is necessary, not sufficient.
- `npm run check:mutation` breaks each guarded behaviour in a scratch copy and
  requires the suite to FAIL. Several tests in this repo once passed on
  deliberately broken source. If you add a guard, add a mutant for it.
- Anchor mutants on unique surrounding text, not on an `occurrence:` index. An
  index silently drifts onto a different branch when the file changes, and goes
  on reporting "killed" while testing nothing.
- The renderer can be exercised in a browser harness. It is worth doing: it is
  how the PIN-strength wordlist was confirmed to actually reach `app.js` at
  runtime, which no Node test could show.

## Things that have bitten before

- **The working tree is CRLF.** Any multi-line search or replace pattern written
  with `\n` will silently fail to match. Normalise first.
- **`build.files` is an allowlist.** A file the app needs at runtime must be
  named there or it will not ship. It used to be a denylist from `**/*`, which is
  how four releases shipped a `.claude` folder.
- **Commit the version bump before building a release**, so the tag names the
  tree the installer came from. See `MAINTAINING.md`.
- **Never return defaults for a failed read.** The settings getters used to
  answer an unreadable file with the built-in defaults, indistinguishable from
  "you have none", and the setters load-modify-save. That is one unlucky moment
  away from writing defaults over someone's real prompts and templates.

## House style

- No em dashes.
- Never describe the app in medical, clinical or diagnostic terms, in code,
  comments, UI copy or release notes. It is a diary.
- Release notes go in `dist/release-notes/Flint-<version>.md`, never the repo
  root.
- Comments should say why, especially where the reason is a past failure. Most
  of the odd-looking code here is odd for a reason worth recording.
