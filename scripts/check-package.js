// Inspects what actually went into the built app and fails if anything private
// or unexpected is in there. Run AFTER "npm run dist", before publishing:
//   node scripts/check-package.js
//
// This exists because 1.5.0 shipped with the developer's .claude folder inside
// app.asar, leaking a Windows username, a local temp path and two session ids.
// The privacy check before that release was run against the git diff, which
// could never have caught it: .claude is gitignored, so it is invisible to git
// and visible to electron-builder, whose "files" setting is a DENYLIST starting
// from **/*. Anything new in the project root ships unless someone remembers to
// exclude it. Remembering is not a control. This is.
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const ASAR = path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar');

let failed = 0;
const fail = (m) => { console.error(`  FAIL  ${m}`); failed++; };
const ok = (m) => console.log(`  ok    ${m}`);

if (!fs.existsSync(ASAR)) {
  console.error(`\n  No packaged app found at ${ASAR}\n  Run "npm run dist" first.\n`);
  process.exit(2);
}

// 1. Nothing private or dev-only may be present at all.
let listing = '';
try {
  listing = execFileSync('npx', ['asar', 'list', ASAR], { encoding: 'utf8', shell: true });
} catch (err) {
  console.error('  Could not list the asar: ' + err.message);
  process.exit(2);
}
const entries = listing.split('\n').map((s) => s.trim()).filter(Boolean);
// Match a path SEGMENT, anchored at a separator or at the start of the entry.
// asar list prints entries with a leading separator, but the directory entry
// itself can arrive bare, so both shapes have to be covered. Node modules are
// left alone: dependencies legitimately ship their own tests and markdown, and
// flagging those would bury the one line that matters.
const seg = (name) => new RegExp(`(^|[\\\\/])${name}([\\\\/]|$)`, 'i');
const forbidden = [
  seg('\\.claude'), seg('\\.hallmark'), seg('\\.git'), seg('\\.vscode'), seg('\\.idea'),
  seg('tests?'), seg('scripts'), seg('harness'), /\.lock$/i, /(^|[\\/])\.env/i
];
const bad = entries
  .filter((e) => !/(^|[\\/])node_modules([\\/]|$)/i.test(e))
  .filter((e) => forbidden.some((r) => r.test(e)) || /\.md$/i.test(e));
if (bad.length) bad.slice(0, 20).forEach((b) => fail(`private or dev-only file shipped: ${b}`));
else ok(`no private or dev-only files in the package (${entries.length} entries)`);

// 2. No personal strings anywhere in the packaged bytes. The username is taken
// from the machine running the build rather than hardcoded, so this keeps
// working on someone else's computer.
const user = os.userInfo().username;
const needles = [
  { label: 'Windows username', value: `\\Users\\${user}\\` },
  { label: 'Windows username (forward slashes)', value: `/Users/${user}/` },
  { label: 'Claude temp path', value: 'AppData\\Local\\Temp\\claude' },
  { label: 'home directory', value: os.homedir() }
];
const blob = fs.readFileSync(ASAR, 'latin1');
let leaked = 0;
for (const n of needles) {
  if (n.value && blob.includes(n.value)) { fail(`${n.label} appears in app.asar: ${n.value}`); leaked++; }
}
// A session id is a uuid, so look for the shape rather than a specific value.
// Two well-known constants are expected and are not session ids: the nil uuid,
// and the RFC 4122 namespace uuids that a dependency parses at load. A check
// that cries wolf gets ignored, which is worse than not having it.
const KNOWN_UUIDS = new Set([
  '00000000-0000-0000-0000-000000000000',
  '6ba7b810-9dad-11d1-80b4-00c04fd430c8', '6ba7b811-9dad-11d1-80b4-00c04fd430c8',
  '6ba7b812-9dad-11d1-80b4-00c04fd430c8', '6ba7b814-9dad-11d1-80b4-00c04fd430c8'
]);
const uuids = [...new Set(blob.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || [])]
  .filter((u) => !KNOWN_UUIDS.has(u.toLowerCase()));
if (uuids.length) { fail(`unexpected uuid(s) in app.asar, usually a session id: ${uuids.slice(0, 3).join(', ')}`); leaked++; }
if (!leaked) ok('no usernames, home paths or session ids in the packaged bytes');

// 3. The version in the package must match package.json, so a stale build is
// never published against fresh release notes.
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const installer = path.join(ROOT, 'dist', `Flint-Setup-${pkg.version}.exe`);
if (fs.existsSync(installer)) ok(`installer matches package.json version (${pkg.version})`);
else fail(`no installer for version ${pkg.version}; dist holds a different build`);

// 4. latest.yml must exist and name that installer, or auto-update breaks for
// every existing user.
const yml = path.join(ROOT, 'dist', 'latest.yml');
if (!fs.existsSync(yml)) fail('latest.yml is missing; publishing without it breaks auto-update for everyone');
else {
  const y = fs.readFileSync(yml, 'utf8');
  if (y.includes(`Flint-Setup-${pkg.version}.exe`)) ok('latest.yml names the built installer');
  else fail('latest.yml does not name this version\'s installer');
}

console.log(failed ? `\n  ${failed} problem(s). Do NOT publish this build.\n` : '\n  Package is clean and safe to publish.\n');
process.exit(failed ? 1 : 0);
