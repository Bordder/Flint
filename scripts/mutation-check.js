// Mutation harness: for each fix, break the source in a scratch copy of the
// repo and confirm the suite FAILS. A test that stays green on broken source is
// worse than no test, because it is trusted.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = require('path').join(__dirname, '..');
const WORK = path.join(os.tmpdir(), 'flint-mutate');

const MUTANTS = [
  { id: 'C1  refuse to encrypt an empty journal over live copies', file: 'store.js',
    from: 'const rescue = await recoverableCopiesExist();', to: 'const rescue = 0;' },
  { id: 'H-1 start-with-Windows pinned before the tray changes', file: 'store.js',
    from: 'if (s.startWithWindows === undefined) s.startWithWindows = s.runInBackground === true;', to: '' },
  { id: 'H-2 openVault drops a key that cannot open the file', file: 'store.js',
    from: "clearSessionDk();\n    sessionVault = null;\n    return { locked: true, warning: 'Your journal could not be decrypted",
    to: "return { locked: true, warning: 'Your journal could not be decrypted" },
  { id: 'H-5 disable path deletes its plaintext sidecars', file: 'store.js',
    occurrence: 2, from: 'await mediaSidecarAbort(prepared);\n', to: '' },
  { id: 'H-7 securityStatus never downgrades a live session', file: 'store.js',
    from: 'if (!(encryptedOnDisk && sessionDk)) {', to: 'if (true) {' },
  { id: 'L-1 startedOn is never overwritten', file: 'store.js',
    from: 'if (s.onboarded && !s.startedOn) s.startedOn = localDay();',
    to: 'if (s.onboarded) s.startedOn = localDay();' },
  { id: 'L-3 getMedia refuses while locked', file: 'store.js',
    from: "if (!sessionDk) return { ok: false, error: 'Your journal is locked.' };", to: '' },
  { id: 'M-1 picker respects the day', file: 'shared/prompts.js',
    from: 'return Math.floor(t / 86400000);', to: 'return 0;' },
  { id: 'M-1 picker respects the offset', file: 'shared/prompts.js',
    from: 'const base = dayNumber(iso) + (Number(offset) || 0);', to: 'const base = dayNumber(iso);' },
  { id: 'M-1 picker indexes the FILTERED pool', file: 'shared/prompts.js',
    from: 'const pool = lib.filter((p) => !avoid.has(p.cat));\n  const from = pool.length ? pool : lib;',
    to: 'const from = lib;' },
  { id: 'U5  note is reserved as a prompt key', file: 'store.js',
    from: "return isReservedKey(key) || key === 'note';", to: 'return isReservedKey(key);' }
];

function freshCopy() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  for (const f of ['store.js', 'crypto.js', 'package.json']) fs.copyFileSync(path.join(REPO, f), path.join(WORK, f));
  for (const d of ['shared', 'tests']) fs.cpSync(path.join(REPO, d), path.join(WORK, d), { recursive: true });
}

function runSuite() {
  try {
    execFileSync(process.execPath, ['tests/store.test.js'], { cwd: WORK, encoding: 'utf8', stdio: 'pipe' });
    return true;
  } catch { return false; }
}

function applyMutant(raw, m) {
  // The working tree is CRLF, so any pattern spanning a newline fails to match
  // unless both sides are normalised. The scratch copy is disposable, so
  // rewriting its line endings costs nothing.
  const src = raw.split('\r\n').join('\n');
  if (!src.includes(m.from)) return null;
  if (!m.occurrence) return src.replace(m.from, m.to);
  let seen = 0, out = src, idx = 0;
  while (true) {
    const at = out.indexOf(m.from, idx);
    if (at < 0) break;
    seen++;
    if (seen === m.occurrence) return out.slice(0, at) + m.to + out.slice(at + m.from.length);
    idx = at + m.from.length;
  }
  return null;
}

freshCopy();
if (!runSuite()) { console.error('  BASELINE IS RED. Fix the suite before mutating.'); process.exit(2); }
console.log('  baseline: green\n');

let bad = 0;
for (const m of MUTANTS) {
  freshCopy();
  const p = path.join(WORK, m.file);
  const out = applyMutant(fs.readFileSync(p, 'utf8'), m);
  if (out === null) { console.log(`  SKIP     ${m.id}  (pattern not found)`); bad++; continue; }
  fs.writeFileSync(p, out);
  const green = runSuite();
  console.log(`  ${green ? 'SURVIVED' : 'killed  '} ${m.id}`);
  if (green) bad++;
}
fs.rmSync(WORK, { recursive: true, force: true });
console.log(bad ? `\n  ${bad} mutant(s) survived or could not be applied.\n`
                : `\n  all ${MUTANTS.length} mutants killed: these fixes are genuinely protected.\n`);
process.exit(bad ? 1 : 0);
