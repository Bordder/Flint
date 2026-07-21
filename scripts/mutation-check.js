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
  // Anchored on the comment above it, NOT on an occurrence index. This mutant was
  // written as `occurrence: 2` and silently drifted onto a different branch the
  // moment M-2 added abort calls earlier in the same function, so it went on
  // reporting "killed" while no longer touching the sidecar sweep at all. An
  // index into a file that keeps changing is not an anchor.
  { id: 'H-5 disable path deletes its plaintext sidecars', file: 'store.js',
    from: 'sitting beside an encrypted journal with nothing to ever remove them.\n      await mediaSidecarAbort(prepared);\n',
    to: 'sitting beside an encrypted journal with nothing to ever remove them.\n' },
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
    from: "return isReservedKey(key) || key === 'note';", to: 'return isReservedKey(key);' },
  // The traversal test asserted the journal was untouched, but its payload had one
  // '..' too many and landed above the data folder, so the assertion could not
  // fail. These two mutants are the proof it can now.
  { id: 'L-2 getMedia rejects a path as an id', file: 'store.js',
    from: "if (!isSafeMediaId(id)) return { ok: false, error: 'Unknown attachment.' };", to: '' },
  { id: 'L-2 removeMedia rejects a path as an id', file: 'store.js',
    from: 'if (!isSafeMediaId(id)) return { ok: false };', to: '' },
  { id: 'M-2 damaged photos block a decrypt rather than being skipped', file: 'store.js',
    occurrence: 1, from: 'if (damaged.length && !opts.skipDamaged) {', to: 'if (false) {' },
  { id: 'M-4 a photo-only day still counts as written', file: 'store.js',
    from: 'entryMediaCount(entry) > 0 ||', to: 'false ||' },
  { id: 'L-7 addMedia checks the bytes, not the extension', file: 'store.js',
    from: 'if (!looksLikeType(bytes, type)) {', to: 'if (false) {' }
  // NOT listed: the stat-size check in addMedia. Removing it leaves behaviour
  // identical, because the post-read check refuses the same file: what it costs
  // is reading a huge file into memory first. That is a real property but not an
  // observable one, so a mutant for it would sit here permanently "SURVIVED" and
  // train whoever reads this output to ignore survivors. The redundancy is
  // deliberate and is commented at the call site.
];

function freshCopy() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  for (const f of ['store.js', 'crypto.js', 'package.json']) fs.copyFileSync(path.join(REPO, f), path.join(WORK, f));
  // renderer/ comes too: the PIN-meter test lifts wordlistGuesses and crackSeconds
  // out of app.js rather than reimplementing them, so without it the baseline is
  // red for a reason that has nothing to do with any mutant.
  for (const d of ['shared', 'tests', 'renderer']) fs.cpSync(path.join(REPO, d), path.join(WORK, d), { recursive: true });
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
  if (!m.occurrence) {
    // A pattern meant to be unique that has quietly become ambiguous would mutate
    // the first hit, which may not be the guarded one. Say so rather than pass.
    const hits = src.split(m.from).length - 1;
    if (hits > 1) { console.log(`  AMBIGUOUS pattern matches ${hits}x, add an occurrence: ${m.id}`); return null; }
    return src.replace(m.from, m.to);
  }
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

// The red-baseline path below exits early and used to walk away from the whole
// scratch tree. One fixed path, so it was self-healing on the next run rather
// than unbounded, but leaving a copy of the journal code lying in temp after a
// failure is the wrong default.
process.on('exit', () => {
  try { fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  catch { /* best effort: never fail a run over a temp folder */ }
});

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
