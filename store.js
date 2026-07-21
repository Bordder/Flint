// Data layer for Flint.
//
// Everything lives in plain files under one folder so the whole journal can
// be found, read, backed up and moved by hand:
//
//   <root>/data/entries.json, every entry, keyed by date (YYYY-MM-DD)
//   <root>/data/backups/, rolling timestamped copies, newest 30 kept
//   <root>/data/settings.json, the user's own prompts, the last known prompt
//                                  titles (so removed prompts' answers can
//                                  still be labelled), the light/dark theme
//                                  choice, and the legacy window PIN.
//
// The journal can optionally be encrypted at rest (see crypto.js). When it is,
// entries.json is an encrypted "vault" instead of plain JSON, backups are
// encrypted copies of it, and the data key exists only in memory while the app
// is unlocked with the PIN or the recovery code. When encryption is off,
// entries.json is plain JSON that can be read and moved by hand.
//
// Saves are atomic: write to a temp file, flush to disk, then rename over
// the real file. A crash mid-save leaves the previous file untouched.
//
// Within an entry, keys beginning with "__" and the key "updatedAt" are
// reserved by the app (day marker, tags, save time). Every other key holds the
// answer to a prompt. Answers whose prompt has since been removed are still
// kept, shown and exported, the app never drops a word the user wrote.

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const { DEFAULT_QUESTIONS, DAY_MARKERS, TRAJECTORY_MARKERS, REPORT_ACTIVITIES } = require('./shared/questions');
const { DEFAULT_TEMPLATES } = require('./shared/templates');
const { DEFAULT_ACTIVITIES } = require('./shared/activities');
const vaultCrypto = require('./crypto');

// Encryption session state. When the journal is encrypted, `entries.json` is a
// vault; the data key lives only in this process's memory while unlocked, and
// is dropped on lock or quit. It is never written to disk in the clear.
let sessionDk = null;        // the data key (Buffer) while unlocked; else null
let sessionVault = null;     // the on-disk vault object, reused when re-sealing
let encryptedOnDisk = false; // whether entries.json is currently a vault
// Sticky for the process: set the moment we ever see a vault, cleared only by a
// deliberate disableEncryption or a full reset. It exists so that a file going
// missing or turning to plaintext underneath us can never be mistaken for the
// user having switched encryption off. See the plaintext branch of doSaveData.
let encryptedEverThisSession = false;

// The data key is a Buffer, so wipe it rather than only dropping the reference.
// A locked session should not leave the key lying in process memory.
function setSessionDk(dk) {
  if (sessionDk && sessionDk !== dk) sessionDk.fill(0);
  sessionDk = dk;
}
function clearSessionDk() {
  if (sessionDk) sessionDk.fill(0);
  sessionDk = null;
}

const BACKUPS_TO_KEEP = 30;
const MAX_QUESTIONS = 40;
const MAX_TITLE = 200;
const MAX_HINT = 1000;

let P = null;

function init(rootDir) {
  P = {
    root: rootDir, dataDir: path.join(rootDir, 'data'), dataFile: path.join(rootDir, 'data', 'entries.json'), backupsDir: path.join(rootDir, 'data', 'backups'), mediaDir: path.join(rootDir, 'data', 'media'), settingsFile: path.join(rootDir, 'data', 'settings.json')
  };
  fs.mkdirSync(P.backupsDir, { recursive: true });
  invalidateSettingsCache(); // a new root means the cached settings belong to the old one
  // A different data root is a different journal, so nothing we learned about the
  // last one applies to it. Carrying a data key, a cached vault or an "encrypted"
  // belief across the switch is how a save ends up resealing one journal with
  // another journal's key. In the app this runs once at startup and changes
  // nothing; it matters wherever a root is swapped.
  clearSessionDk();
  sessionVault = null;
  encryptedOnDisk = false;
  encryptedEverThisSession = false;
  return { ...P };
}

function paths() {
  return { ...P };
}

// ----------------------------------------------------------------- media
//
// Attachments live as one file each, next to the entries, and are referenced
// from an entry by id under __media. When the journal is encrypted the bytes are
// encrypted with the same data key, so a photo is no more readable than the
// words are. An encrypted attachment starts with MEDIA_MAGIC; a plain one is
// just the raw image. Keeping that marker inside the file (rather than in the
// name) means ids never change when encryption is switched on or off.

const MEDIA_MAGIC = Buffer.from('FLINTMED1');
const MEDIA_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
const MEDIA_ID = /^[a-f0-9]{24}\.(jpg|jpeg|png|gif|webp)$/i;
const MEDIA_MAX_BYTES = 20 * 1024 * 1024;

// Ids come back from the renderer, so never trust one as a path: only an exact
// id shape is allowed anywhere near the filesystem.
function isSafeMediaId(id) { return typeof id === 'string' && MEDIA_ID.test(id); }
function mediaPath(id) { return path.join(P.mediaDir, id); }
function isEncryptedBlob(buf) { return buf.length > MEDIA_MAGIC.length && buf.subarray(0, MEDIA_MAGIC.length).equals(MEDIA_MAGIC); }

async function writeFileAtomicRaw(filePath, buf) {
  const tmp = filePath + '.tmp';
  const fh = await fsp.open(tmp, 'w');
  try {
    await fh.writeFile(buf);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, filePath);
}

async function addMedia(sourcePath) {
  const ext = path.extname(String(sourcePath)).toLowerCase();
  const type = MEDIA_TYPES[ext];
  if (!type) return { ok: false, error: 'That kind of file cannot be attached.' };
  if (encryptedOnDisk && !sessionDk) return { ok: false, error: 'Your journal is locked.' };
  const bytes = await fsp.readFile(sourcePath);
  if (bytes.length > MEDIA_MAX_BYTES) return { ok: false, error: 'That image is bigger than 20 MB.' };
  // About to write a photo in the clear? Check the disk first, exactly as
  // doSaveData does before writing plaintext words. If the in-memory flag has
  // drifted and the journal on disk is really a vault, refuse rather than drop a
  // readable image next to the encrypted words.
  if (!encryptedOnDisk) {
    const s = await peekVaultState();
    if (s.state === 'vault') {
      encryptedOnDisk = encryptedEverThisSession = true;
      sessionVault = s.vault;
      return { ok: false, error: 'Your journal is encrypted, but Flint lost track of the key, so this photo was NOT saved and nothing on disk was touched. Close and reopen Flint, unlock it, and try again.' };
    }
    if (s.state === 'unknown') {
      return { ok: false, error: `Your journal file could not be checked (${s.error}), so this photo was not saved. Please try again.` };
    }
  }
  await fsp.mkdir(P.mediaDir, { recursive: true });
  const id = crypto.randomBytes(12).toString('hex') + ext;
  const blob = encryptedOnDisk ? Buffer.concat([MEDIA_MAGIC, vaultCrypto.encryptBuffer(sessionDk, bytes)]) : bytes;
  await writeFileAtomicRaw(mediaPath(id), blob);
  return { ok: true, id, name: path.basename(String(sourcePath)), type };
}

// Returns the image as a data: URL, which the renderer's CSP allows for images.
async function getMedia(id) {
  if (!isSafeMediaId(id)) return { ok: false, error: 'Unknown attachment.' };
  let blob;
  try { blob = await fsp.readFile(mediaPath(id)); } catch { return { ok: false, error: 'That attachment is missing.' }; }
  if (isEncryptedBlob(blob)) {
    if (!sessionDk) return { ok: false, error: 'Your journal is locked.' };
    try { blob = vaultCrypto.decryptBuffer(sessionDk, blob.subarray(MEDIA_MAGIC.length)); }
    catch { return { ok: false, error: 'That attachment could not be decrypted.' }; }
  }
  const type = MEDIA_TYPES[path.extname(id).toLowerCase()] || 'application/octet-stream';
  return { ok: true, dataUrl: `data:${type};base64,${blob.toString('base64')}` };
}

async function removeMedia(id) {
  if (!isSafeMediaId(id)) return { ok: false };
  await fsp.unlink(mediaPath(id)).catch(() => {});
  return { ok: true };
}

// Rewrites every attachment to match the journal's encryption state. Without
// this, turning encryption on would scramble the words while leaving the photos
// sitting in the clear beside them.
// Returns the names it could NOT convert. Callers must not report success while
// this list is non-empty: a photo left in the clear beside an encrypted journal
// breaks the promise, and one left encrypted after the key is gone is lost.
// Two phases, for the same reason as the rekey: converting in place meant a
// failure partway left some photos already converted while the caller reported
// "Nothing was changed". Phase one writes sidecars and touches no original, so
// giving up really is a no-op. Callers commit only once they are ready.
async function rewriteMediaPrepare(dk, encrypt) {
  const prepared = [];
  const failed = [];
  let names;
  try { names = await fsp.readdir(P.mediaDir); } catch { return { prepared, failed }; }
  // Sweep any half-written .tmp leftovers first: they hold raw image bytes and
  // match no id pattern, so nothing else would ever encrypt or remove them.
  for (const name of names.filter((n) => n.endsWith('.tmp'))) {
    await fsp.unlink(path.join(P.mediaDir, name)).catch(() => {});
  }
  for (const name of names.filter(isSafeMediaId)) {
    const file = mediaPath(name);
    const sidecar = `${file}.rekey`;
    try {
      const blob = await fsp.readFile(file);
      const already = isEncryptedBlob(blob);
      if (encrypt === already) continue; // already in the state we want
      const out = encrypt
        ? Buffer.concat([MEDIA_MAGIC, vaultCrypto.encryptBuffer(dk, blob)])
        : vaultCrypto.decryptBuffer(dk, blob.subarray(MEDIA_MAGIC.length));
      await writeFileAtomicRaw(sidecar, out);
      prepared.push({ file, sidecar });
    } catch {
      failed.push(name);
    }
  }
  return { prepared, failed };
}

function emptyData() {
  return { version: 1, entries: {} };
}

// UTC on purpose. Backup names are sorted as text to find the newest, and local
// time repeats an hour when the clocks go back: names would collide and the
// ordering would invert, so "newest backup" could quietly mean an older one.
function stamp(d = new Date()) {
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}` +
    `-${p(d.getUTCMilliseconds(), 3)}`
  );
}

function isReservedKey(key) {
  return key === 'updatedAt' || key.startsWith('__');
}

function isValidData(d) {
  return (
    d !== null &&
    typeof d === 'object' &&
    !Array.isArray(d) &&
    d.entries !== null &&
    typeof d.entries === 'object' &&
    !Array.isArray(d.entries)
  );
}

async function writeFileAtomic(filePath, text) {
  const tmp = filePath + '.tmp';
  const fh = await fsp.open(tmp, 'w');
  try {
    await fh.writeFile(text, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, filePath);
}

// ---------------------------------------------------------------- entries

// Decrypts a vault with the in-memory data key. Returns the data object, or a
// { locked } result if we don't hold the key yet. Never quarantines the file.
function openVault(vault) {
  encryptedOnDisk = encryptedEverThisSession = true;
  if (!sessionDk) { sessionVault = vault; return { locked: true }; }
  try {
    const data = vaultCrypto.openWithDk(vault, sessionDk);
    sessionVault = vault; // only adopt a vault the held key actually opens
    return { data, encrypted: true };
  } catch {
    // The key does not belong to this file. Keeping it would let the next save
    // reseal a new body under wraps from a different key, and the result opens
    // for neither the PIN nor the recovery code, permanently. Drop the key and
    // ask again, exactly as securityStatus does on the same mismatch.
    clearSessionDk();
    sessionVault = null;
    return { locked: true, warning: 'Your journal could not be decrypted with the current key. Please unlock it again.' };
  }
}

async function loadData() {
  let raw;
  try {
    raw = await fsp.readFile(P.dataFile, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      encryptedOnDisk = false;
      return { data: emptyData() };
    }
    throw new Error(
      `Your journal file could not be read (${err.code || err.message}). ` +
      `It is at: ${P.dataFile}`
    );
  }

  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }

  if (vaultCrypto.isVault(parsed)) {
    return openVault(parsed); // encrypted journal: decrypt if unlocked, else { locked }
  }
  if (isValidData(parsed)) {
    encryptedOnDisk = false;
    return { data: parsed };
  }

  // The file exists but cannot be read as journal data. Never overwrite it,
  // set it aside and fall back to the newest readable backup.
  const corruptPath = `${P.dataFile}.corrupt-${stamp()}`;
  let setAside = true;
  try {
    await fsp.rename(P.dataFile, corruptPath);
  } catch {
    try { await fsp.copyFile(P.dataFile, corruptPath); } catch { setAside = false; }
  }
  const keptNote = setAside
    ? `The unreadable file was kept, unchanged, at: ${corruptPath}`
    : `The unreadable file could not be copied aside (it may be locked ` +
      `by another program); it is still at ${P.dataFile} and will be ` +
      `replaced the next time you save.`;
  const backup = await newestValidBackup();
  if (backup) {
    const note =
      `Your main journal file could not be read, so the most recent ` +
      `backup (${backup.name}) was loaded instead. Nothing you save ` +
      `from now on is affected. ${keptNote}`;
    if (vaultCrypto.isVault(backup.parsed)) {
      const opened = openVault(backup.parsed);
      return { ...opened, warning: opened.warning ? `${note} ${opened.warning}` : note };
    }
    encryptedOnDisk = false;
    return { data: backup.parsed, warning: note };
  }
  encryptedOnDisk = false;
  return {
    data: emptyData(), warning:
      `Your journal file could not be read and no backup was found, so ` +
      `Flint is starting empty. ${keptNote}`
  };
}

async function newestValidBackup() {
  let names;
  try {
    names = await fsp.readdir(P.backupsDir);
  } catch {
    return null;
  }
  const candidates = names
    .filter((n) => /^entries-.*\.json$/.test(n))
    .sort()
    .reverse();
  for (const name of candidates) {
    try {
      const parsed = JSON.parse(await fsp.readFile(path.join(P.backupsDir, name), 'utf8'));
      if (isValidData(parsed) || vaultCrypto.isVault(parsed)) return { name, parsed };
    } catch {
      // Skip unreadable backups and keep looking.
    }
  }
  return null;
}

// Saves the full data object. Throws with a clear message if the main save
// fails. A backup failure does not fail the save (the words are on disk);
// it is returned as a warning instead.
//
// Saves are serialised through a chain so two saves in flight (double
// Ctrl+S, save racing the close dialog) can never interleave writes to the
// same temp file.
let saveChain = Promise.resolve();

function saveData(data, opts) {
  return runExclusive(() => doSaveData(data, opts));
}

// Runs work after any in-flight save (or earlier exclusive op) has finished,
// so writes to entries.json never interleave. Used for saves and for the
// encryption operations, which also rewrite entries.json.
function runExclusive(fn) {
  const run = saveChain.then(fn, fn);
  saveChain = run.catch(() => {});
  return run;
}

async function doSaveData(data, opts = {}) {
  opts = opts || {}; // tolerate an explicit null, not just a missing argument
  if (!isValidData(data)) {
    throw new Error('Flint was asked to save something that does not look like journal data. Nothing was written.');
  }

  let json;
  if (encryptedOnDisk) {
    // The journal is encrypted. We must hold the data key to re-seal it;
    // refuse rather than ever write the words to disk in the clear.
    if (!sessionDk || !sessionVault) {
      throw new Error(
        'Your journal is locked, so this change was not saved. Unlock it ' +
        'with your PIN (or recovery code) and try again.'
      );
    }
    sessionVault = vaultCrypto.resealBody(sessionVault, sessionDk, data);
    json = JSON.stringify(sessionVault, null, 2);
  } else {
    // About to write plaintext. Check the disk first: if it holds a vault, our
    // in-memory state has drifted (a locked file, a stale flag) and writing now
    // would overwrite an encrypted journal in the clear. Refuse instead.
    const s = await peekVaultState();
    if (s.state === 'vault') {
      encryptedOnDisk = encryptedEverThisSession = true;
      sessionVault = s.vault;
      throw new Error(
        'Your journal is encrypted, but Flint lost track of the key, so this change was NOT saved ' +
        'and nothing on disk was touched. Close and reopen Flint, unlock it, and your words are safe.'
      );
    }
    if (s.state === 'unknown') {
      throw new Error(
        `Your journal file could not be checked (${s.error}), so nothing was written. ` +
        'Your words are still on the page. Please try saving again.'
      );
    }
    // Belt and braces for the same drift: if encryption was ever on in this
    // session, an 'absent' or 'plain' file means something outside Flint moved
    // or replaced it. Writing plaintext here would silently undo encryption the
    // user still believes is on, so refuse and keep the words on the page.
    if (encryptedEverThisSession) {
      throw new Error(
        'Your journal is encrypted, but the file on disk is missing or is no longer encrypted, ' +
        'so this change was NOT saved and nothing on disk was touched. Close and reopen Flint, ' +
        'unlock it, and check your journal folder. Your words are still on the page.'
      );
    }
    json = JSON.stringify(data, null, 2);
  }
  JSON.parse(json); // sanity check: never write unparseable text

  try {
    await writeFileAtomic(P.dataFile, json);
  } catch (err) {
    throw new Error(
      `Your words could NOT be saved to disk (${err.code || err.message}). ` +
      `They are still in the app, so please try saving again. ` +
      `File: ${P.dataFile}`
    );
  }

  // Autosave ticks pass { backup: false }: the main file is already safely on
  // disk (atomic temp+rename above), and skipping the backup keeps the 30-copy
  // ring holding genuine checkpoints (manual save, day-switch, lock, close,
  // export) instead of being churned away every few seconds of typing.
  if (opts.backup === false) return {};

  try {
    await writeBackup(json);
    return {};
  } catch (err) {
    return {
      backupWarning:
        `Your entry was saved, but a backup copy could not be written ` +
        `(${err.code || err.message}). Backups folder: ${P.backupsDir}`
    };
  }
}

// Writes the given bytes as the main file and, best effort, one backup. Used by
// the encryption operations (enable, disable, change PIN) which each replace
// entries.json wholesale.
async function writeMainAndBackup(json) {
  await writeFileAtomic(P.dataFile, json);
  try { await writeBackup(json); } catch { /* main is written; backup is best effort */ }
}

async function writeBackup(json) {
  await fsp.mkdir(P.backupsDir, { recursive: true });
  const name = `entries-${stamp()}.json`;
  // Atomic for the same reason as the main file: a crash mid-write must not
  // leave a truncated file as the "newest backup".
  await writeFileAtomic(path.join(P.backupsDir, name), json);
  await pruneBackups();
}

async function pruneBackups() {
  const names = (await fsp.readdir(P.backupsDir))
    .filter((n) => /^entries-.*\.json$/.test(n))
    .sort()
    .reverse();
  for (const name of names.slice(BACKUPS_TO_KEEP)) {
    await fsp.unlink(path.join(P.backupsDir, name)).catch(() => {});
  }
}

// ------------------------------------------------------ prompts (questions)

function looksLikeQuestion(q) {
  return q && typeof q === 'object' && typeof q.title === 'string' && q.title.trim();
}

// Normalises a user-supplied prompt list: trims, caps lengths, drops blanks,
// gives every prompt a stable non-reserved key, and de-duplicates keys.
function normaliseQuestions(list) {
  if (!Array.isArray(list)) return null;
  const cleaned = [];
  const usedKeys = new Set();
  for (const q of list.slice(0, MAX_QUESTIONS)) {
    if (!looksLikeQuestion(q)) continue;
    let key = typeof q.key === 'string' ? q.key.trim() : '';
    if (!key || isReservedKey(key) || usedKeys.has(key)) {
      do {
        key = 'p' + crypto.randomBytes(6).toString('hex');
      } while (usedKeys.has(key) || isReservedKey(key));
    }
    usedKeys.add(key);
    cleaned.push({
      key, title: q.title.trim().slice(0, MAX_TITLE), hint: (typeof q.hint === 'string' ? q.hint.trim() : '').slice(0, MAX_HINT)
    });
  }
  return cleaned.length ? cleaned : null;
}

// The prompts to actually show: the user's saved set, or the built-in default.
async function loadQuestions() {
  const s = await loadSettingsOrDefault();
  const saved = normaliseQuestions(s.questions);
  return saved || DEFAULT_QUESTIONS.map((q) => ({ ...q }));
}

// A key→title map used to label answers whose prompt has since been removed.
// The built-in defaults are always included, so their answers never fall back
// to a generic label even if the user has never explicitly saved a prompt set.
async function knownTitles() {
  const s = await loadSettingsOrDefault();
  const base = {};
  for (const q of DEFAULT_QUESTIONS) base[q.key] = q.title;
  const saved = s.knownTitles && typeof s.knownTitles === 'object' ? s.knownTitles : {};
  return { ...base, ...saved };
}

// Keep a title only while something still needs it: a prompt currently in use,
// a built-in default, or an answer somewhere in the journal that would otherwise
// export with no label. Everything else is a private phrase the user deleted and
// has no reason to leave lying in a plaintext file. If the journal cannot be
// read right now (locked, or a bad moment on disk) nothing is pruned, because
// dropping a title whose answers we simply could not see would lose a label.
async function pruneKnownTitles(titles, currentQuestions) {
  const keep = new Set(DEFAULT_QUESTIONS.map((q) => q.key));
  for (const q of currentQuestions || []) keep.add(q.key);
  let data = null;
  try {
    const res = await loadData();
    if (res && res.data && isValidData(res.data)) data = res.data;
  } catch { data = null; }
  if (!data) return titles; // cannot prove a title is unused, so keep it
  for (const entry of Object.values(data.entries || {})) {
    for (const k of Object.keys(entry || {})) {
      if (String(entry[k] || '').trim()) keep.add(k);
    }
  }
  const out = {};
  for (const k of Object.keys(titles)) if (keep.has(k)) out[k] = titles[k];
  return out;
}

// Saves a new prompt set. Records the titles of both the outgoing prompts and
// the new ones in `knownTitles`, so answers to a prompt the user deletes can
// still be labelled in the list and the export, and prunes the ones nothing
// refers to any more (see pruneKnownTitles).
async function saveQuestions(list) {
  const cleaned = normaliseQuestions(list);
  if (!cleaned) {
    throw new Error('You need at least one prompt with a title.');
  }
  const s = await loadSettings();
  const titles = s.knownTitles && typeof s.knownTitles === 'object' ? s.knownTitles : {};
  const outgoing = normaliseQuestions(s.questions) || DEFAULT_QUESTIONS;
  for (const q of outgoing) if (!titles[q.key]) titles[q.key] = q.title;
  for (const q of cleaned) titles[q.key] = q.title;
  s.questions = cleaned;
  // settings.json is always plain JSON, even when the journal is encrypted, and
  // these titles are the user's own words. Keeping every title ever typed meant
  // deleting a prompt called something private left it readable beside the
  // encrypted journal forever. A title is only needed while an answer still
  // uses its key, so drop the ones nothing refers to any more.
  s.knownTitles = await pruneKnownTitles(titles, cleaned);
  await saveSettings(s);
  return cleaned;
}

// ---------------------------------------------------------------- templates

function normaliseTemplates(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const t of list.slice(0, 30)) {
    if (!t || typeof t.name !== 'string' || !t.name.trim()) continue;
    out.push({
      name: t.name.trim().slice(0, 80),
      body: typeof t.body === 'string' ? t.body.slice(0, 4000) : ''
    });
  }
  return out.length ? out : null;
}

async function loadTemplates() {
  const s = await loadSettingsOrDefault();
  return normaliseTemplates(s.templates) || DEFAULT_TEMPLATES.map((t) => ({ ...t }));
}

async function saveTemplates(list) {
  const cleaned = normaliseTemplates(list);
  if (!cleaned) throw new Error('You need at least one template with a name.');
  const s = await loadSettings();
  s.templates = cleaned;
  await saveSettings(s);
  return cleaned;
}

// --------------------------------------------------------------- activities

// The optional activity picker's own list, editable by the user (one label per
// line). Stored as plain strings; a day records the chosen labels as strings,
// so editing this list never disturbs days already written.
function normaliseActivities(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  const seen = new Set();
  for (const a of list.slice(0, 60)) {
    if (typeof a !== 'string') continue;
    const label = a.trim().slice(0, 60);
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out.length ? out : null;
}

async function loadActivities() {
  const s = await loadSettingsOrDefault();
  return normaliseActivities(s.activities) || DEFAULT_ACTIVITIES.slice();
}

async function saveActivities(list) {
  const cleaned = normaliseActivities(list);
  if (!cleaned) throw new Error('You need at least one activity.');
  const s = await loadSettings();
  s.activities = cleaned;
  await saveSettings(s);
  return cleaned;
}

// -------------------------------------------------------------------- theme

// Theme preference: 'system' follows the OS (resolved to light or dark at
// display time); the rest are full palettes the renderer applies directly.
const THEME_CHOICES = ['light', 'dark', 'system', 'true-black', 'sepia', 'rose-pine-dawn', 'solarized-light', 'catppuccin-latte', 'nord', 'everforest', 'rose-pine', 'catppuccin-mocha', 'tokyo-night', 'gruvbox', 'custom'];
function normaliseTheme(t) {
  return THEME_CHOICES.includes(t) ? t : 'light';
}

async function getTheme() {
  const s = await loadSettingsOrDefault();
  return normaliseTheme(s.theme);
}

async function setTheme(theme) {
  const s = await loadSettings();
  s.theme = normaliseTheme(theme);
  await saveSettings(s);
  return s.theme;
}

// The custom theme: a light or dark base plus two chosen colours, and any
// number of saved named presets. Colours are validated as #rrggbb.
const HEX6 = /^#[0-9a-fA-F]{6}$/;
function normaliseCustom(c) {
  c = c && typeof c === 'object' ? c : {};
  return {
    base: ['dark', 'black'].includes(c.base) ? c.base : 'light',
    primary: HEX6.test(c.primary) ? c.primary : '#7aa2f7',
    accent: HEX6.test(c.accent) ? c.accent : '#bb9af7'
  };
}
function normaliseThemePresets(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const p of list.slice(0, 12)) {
    if (!p || typeof p.name !== 'string' || !p.name.trim()) continue;
    out.push({
      name: p.name.trim().slice(0, 30),
      base: ['dark', 'black'].includes(p.base) ? p.base : 'light',
      primary: HEX6.test(p.primary) ? p.primary : '#888888',
      accent: HEX6.test(p.accent) ? p.accent : '#888888'
    });
  }
  return out;
}
async function getCustomTheme() {
  const s = await loadSettingsOrDefault();
  return { custom: normaliseCustom(s.customTheme), presets: normaliseThemePresets(s.themePresets) };
}
async function setCustomTheme(custom) {
  const s = await loadSettings();
  s.customTheme = normaliseCustom(custom);
  await saveSettings(s);
  return s.customTheme;
}
async function setThemePresets(list) {
  const s = await loadSettings();
  s.themePresets = normaliseThemePresets(list);
  await saveSettings(s);
  return s.themePresets;
}

// Whether Flint keeps running in the tray (and starts with Windows) so daily
// reminders can reach the user when the window is closed. Off by default.
async function getRunInBackground() {
  const s = await loadSettingsOrDefault();
  return s.runInBackground === true;
}
async function setRunInBackground(on) {
  const s = await loadSettings();
  // Pin down startWithWindows BEFORE changing the value it used to be inferred
  // from. Without this, the upgrade fallback below reads the value we are about
  // to write, so ticking "keep Flint running" silently adds a Windows startup
  // entry that the setting beside it promises it will never add.
  if (s.startWithWindows === undefined) s.startWithWindows = s.runInBackground === true;
  s.runInBackground = Boolean(on);
  await saveSettings(s);
  return s.runInBackground;
}

// Starting with Windows used to be welded to the tray toggle, so turning on
// "keep running" silently added a startup entry the user never asked for. They
// are separate settings now. The fallback is not optional: without it, anyone
// upgrading with runInBackground on would quietly lose their startup entry and
// their reminders would stop arriving after the next reboot, with no error.
async function getStartWithWindows() {
  // This getter also writes, so it must not run on a fallback: materialising
  // from an empty object after a failed read would flatten the settings file.
  let s;
  try { s = await loadSettings(); } catch { return false; }
  if (s.startWithWindows === undefined) {
    // Upgrade path, and it runs exactly once. Write the inherited answer down so
    // the fallback can never be consulted again: leaving it implicit is what let
    // a later change to runInBackground be read as a decision about startup.
    const inherited = s.runInBackground === true;
    s.startWithWindows = inherited;
    try { await saveSettings(s); } catch { /* the value below is still correct */ }
    return inherited;
  }
  return s.startWithWindows === true;
}
async function setStartWithWindows(on) {
  const s = await loadSettings();
  s.startWithWindows = Boolean(on);
  await saveSettings(s);
  return s.startWithWindows;
}

// The one-time "keep Flint in the tray?" question, and the one-time "it is
// still here" notification. Both are asked once in the app's life; a dismissed
// question counts as an answer, so these are set on every exit path.
async function getTrayAsked() {
  const s = await loadSettingsOrDefault();
  return s.trayAsked === true;
}
async function setTrayAsked(on) {
  const s = await loadSettings();
  s.trayAsked = Boolean(on);
  await saveSettings(s);
  return s.trayAsked;
}
async function getTrayNoticeShown() {
  const s = await loadSettingsOrDefault();
  return s.trayNoticeShown === true;
}
async function setTrayNoticeShown(on) {
  const s = await loadSettings();
  s.trayNoticeShown = Boolean(on);
  await saveSettings(s);
  return s.trayNoticeShown;
}

// On by default. Read synchronously at startup (see readStartupFlagsSync),
// because Electron only honours disableHardwareAcceleration before app ready.
async function getHardwareAcceleration() {
  const s = await loadSettingsOrDefault();
  return s.hardwareAcceleration !== false;
}
async function setHardwareAcceleration(on) {
  const s = await loadSettings();
  s.hardwareAcceleration = Boolean(on);
  await saveSettings(s);
  return s.hardwareAcceleration;
}

// An optional local nudge to write, off by default. The time is 24 hour HH:MM.
// This is an OS notification raised on this computer; nothing leaves it.
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

async function getReminder() {
  const s = await loadSettingsOrDefault();
  const r = s.reminder && typeof s.reminder === 'object' ? s.reminder : {};
  return { enabled: r.enabled === true, time: TIME_PATTERN.test(r.time) ? r.time : '20:00' };
}

async function setReminder(next) {
  const s = await loadSettings();
  const time = next && TIME_PATTERN.test(next.time) ? next.time : '20:00';
  s.reminder = { enabled: Boolean(next && next.enabled), time };
  await saveSettings(s);
  return s.reminder;
}

// Weekdays (0 = Sunday) the user does not plan to write on. A day off never
// breaks a streak; it is skipped rather than counted.
async function getDaysOff() {
  const s = await loadSettingsOrDefault();
  return Array.isArray(s.streakDaysOff)
    ? s.streakDaysOff.filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
    : [];
}

async function setDaysOff(list) {
  const s = await loadSettings();
  const clean = Array.isArray(list)
    ? [...new Set(list.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort()
    : [];
  s.streakDaysOff = clean;
  await saveSettings(s);
  return clean;
}

// Minutes of inactivity before an encrypted journal re-locks itself. 0 is off.
// Only ever acts when encryption is on; a plaintext journal has no lock.
const AUTOLOCK_CHOICES = [0, 1, 5, 15, 30, 60];

async function getAutoLockMinutes() {
  const s = await loadSettingsOrDefault();
  return AUTOLOCK_CHOICES.includes(s.autoLockMinutes) ? s.autoLockMinutes : 15;
}

async function setAutoLockMinutes(n) {
  const s = await loadSettings();
  s.autoLockMinutes = AUTOLOCK_CHOICES.includes(Number(n)) ? Number(n) : 15;
  await saveSettings(s);
  return s.autoLockMinutes;
}

// Seconds between automatic saves while there are unsaved words. Clamped to a
// whitelist so a bad value can never set a 0/absurd interval.
const AUTOSAVE_CHOICES = [5, 15, 30, 60, 120, 300, 600, 1800, 3600];

async function getAutosaveSeconds() {
  const s = await loadSettingsOrDefault();
  return AUTOSAVE_CHOICES.includes(s.autosaveSeconds) ? s.autosaveSeconds : 30;
}

async function setAutosaveSeconds(n) {
  const s = await loadSettings();
  s.autosaveSeconds = AUTOSAVE_CHOICES.includes(Number(n)) ? Number(n) : 30;
  await saveSettings(s);
  return s.autosaveSeconds;
}

// Whether the one-time first-run onboarding has been completed.
async function getOnboarded() {
  const s = await loadSettingsOrDefault();
  return s.onboarded === true;
}

// A plain local YYYY-MM-DD, for day-level bookkeeping the writer would recognise
// as "today" (unlike the UTC backup stamp, which is about file ordering).
function localDay(d = new Date()) {
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

async function setOnboarded(done) {
  const s = await loadSettings();
  s.onboarded = Boolean(done);
  // Stamp the first day so the gentle first-week touch knows when to ease off.
  // Only ever set once, and never for an install that finished onboarding before
  // this existed (those are long past their first week anyway).
  if (s.onboarded && !s.startedOn) s.startedOn = localDay();
  await saveSettings(s);
  return s.onboarded;
}

// The first-run date, stamped once at onboarding, so the renderer can show a
// gentle "just settling in" note during the opening week and nothing after.
async function getStartedOn() {
  const s = await loadSettingsOrDefault();
  return { startedOn: /^\d{4}-\d{2}-\d{2}$/.test(s.startedOn) ? s.startedOn : '' };
}

// Whether the optional guided prompts are shown under each day. Off by default.
async function getGuided() {
  const s = await loadSettingsOrDefault();
  return s.guided === true;
}

async function setGuided(on) {
  const s = await loadSettings();
  s.guided = Boolean(on);
  await saveSettings(s);
  return s.guided;
}

// ------------------------------------------------------------- update opt

// Whether Flint quietly checks for a new version when it opens. Default on.
// This is the ONLY thing the app ever does online; turning it off returns the
// app to fully-offline behaviour. Flint content is never involved either way.
async function getUpdateChecks() {
  const s = await loadSettingsOrDefault();
  return s.updateChecks !== false;
}

async function setUpdateChecks(on) {
  const s = await loadSettings();
  s.updateChecks = Boolean(on);
  await saveSettings(s);
  return s.updateChecks;
}

// ------------------------------------------------------ scheduled backups
//
// A copy of the journal file dropped into a folder the user picks (a USB stick,
// a synced folder), so losing this machine does not take the record with it.
// The file is copied exactly as it sits on disk, so an encrypted journal stays
// encrypted in the backup. Copies go in a "Flint backups" subfolder and only
// files we wrote there are ever pruned.

const BACKUP_KEEP_DEFAULT = 10;
const BACKUP_SUBFOLDER = 'Flint backups';
// Only the exact grammar this build writes, so pruning can never reach a file
// somebody else put there that merely looks similar.
const BACKUP_PATTERN = /^flint-backup-\d{8}-\d{6}-\d{3}\.json$/;

// A backup destination is only ever set from a folder picker in the main
// process, never from a path handed over IPC. A UNC path (\\host\share) would
// make Node's fs copy the journal over the network, which would walk straight
// past the filter that is supposed to keep this app offline.
function isSafeBackupFolder(folder) {
  if (typeof folder !== 'string' || !folder.trim()) return false;
  if (folder.startsWith('\\\\') || folder.startsWith('//')) return false;
  const resolved = path.resolve(folder);
  if (resolved.startsWith('\\\\') || resolved.startsWith('//')) return false;
  if (!path.isAbsolute(resolved)) return false;
  const root = path.parse(resolved).root;
  return /^[A-Za-z]:[\\/]$/.test(root) || root === '/';
}

async function getBackupSettings() {
  const s = await loadSettingsOrDefault();
  const b = s.autoBackup && typeof s.autoBackup === 'object' ? s.autoBackup : {};
  const folder = isSafeBackupFolder(b.folder) ? b.folder : '';
  return {
    enabled: b.enabled === true && Boolean(folder),
    folder,
    keep: Number.isInteger(b.keep) && b.keep > 0 && b.keep <= 100 ? b.keep : BACKUP_KEEP_DEFAULT,
    lastRun: typeof b.lastRun === 'string' ? b.lastRun : ''
  };
}

// Only 'enabled' is settable from the UI. The folder deliberately is not: see
// isSafeBackupFolder. Retention is fixed rather than caller-supplied so nothing
// can ask for "keep 1" and sweep away the real backups.
async function setBackupSettings(next) {
  const s = await loadSettings();
  const cur = s.autoBackup && typeof s.autoBackup === 'object' ? s.autoBackup : {};
  const folder = isSafeBackupFolder(cur.folder) ? cur.folder : '';
  s.autoBackup = {
    enabled: Boolean(next && next.enabled) && Boolean(folder),
    folder,
    keep: BACKUP_KEEP_DEFAULT,
    lastRun: cur.lastRun || ''
  };
  await saveSettings(s);
  return getBackupSettings();
}

// Called only from the main process, with a path that came from a folder picker.
async function setBackupFolder(folder) {
  if (!isSafeBackupFolder(folder)) {
    return { ok: false, error: 'That folder cannot be used. Pick a folder on a drive on this computer.' };
  }
  const s = await loadSettings();
  const cur = s.autoBackup && typeof s.autoBackup === 'object' ? s.autoBackup : {};
  s.autoBackup = { enabled: true, folder, keep: BACKUP_KEEP_DEFAULT, lastRun: cur.lastRun || '' };
  await saveSettings(s);
  return { ok: true, backup: await getBackupSettings() };
}

// Photos are separate files, so copying entries.json alone would restore every
// word and lose every picture. Attachment ids never change, so only what is not
// already there gets copied. They are copied exactly as stored, which means an
// encrypted journal's photos stay encrypted in the backup too.
// Reports failures as well as copies. Swallowing them meant Flint could say
// "Copied to E:\..." and refresh the "Last copy" date the user reads as proof,
// while an arbitrary subset of their photos was silently missing from the
// offsite copy: a full drive, a locked file, a permission change.
async function backupMedia(destRoot) {
  let names;
  try { names = await fsp.readdir(P.mediaDir); } catch { return { copied: 0, failed: 0 }; }
  const ids = names.filter(isSafeMediaId);
  if (!ids.length) return { copied: 0, failed: 0 };
  const dest = path.join(destRoot, 'media');
  await fsp.mkdir(dest, { recursive: true });
  let copied = 0, failed = 0;
  for (const id of ids) {
    const to = path.join(dest, id);
    try { await fsp.access(to); continue; } catch { /* not copied yet */ }
    try { await fsp.copyFile(mediaPath(id), to); copied++; } catch { failed++; }
  }
  return { copied, failed };
}

function runScheduledBackup() {
  // Serialised with saves: copying the file while it is being replaced would
  // otherwise capture a half-written moment.
  return runExclusive(async () => {
    const cfg = await getBackupSettings();
    if (!cfg.enabled || !cfg.folder) return { ok: false, error: 'Scheduled backups are off.' };
    if (!isSafeBackupFolder(cfg.folder)) return { ok: false, error: 'The saved backup folder is not usable. Choose it again.' };
    if (!fs.existsSync(P.dataFile)) return { ok: false, error: 'There is nothing to back up yet.' };
    const dir = path.join(cfg.folder, BACKUP_SUBFOLDER);
    await fsp.mkdir(dir, { recursive: true });
    const dest = path.join(dir, `flint-backup-${stamp()}.json`);
    await fsp.copyFile(P.dataFile, dest);
    const media = await backupMedia(dir);

    const names = (await fsp.readdir(dir)).filter((n) => BACKUP_PATTERN.test(n)).sort().reverse();
    for (const old of names.slice(cfg.keep)) await fsp.unlink(path.join(dir, old)).catch(() => {});

    // The copy has already happened, so a settings problem must not be reported
    // as a failed backup. Recording when it last ran is bookkeeping, not the job.
    try {
      const s = await loadSettings();
      s.autoBackup = { ...(s.autoBackup || {}), lastRun: new Date().toISOString() };
      await saveSettings(s);
    } catch { /* the backup itself succeeded; the timestamp is not worth failing over */ }
    return { ok: true, path: dest, photos: media.copied, photosFailed: media.failed };
  });
}

// ----------------------------------------------------------------- export
//
// Shared shaping used by both the plain-text and the PDF/HTML exports, so the
// two never drift apart.

function longDate(d) {
  return d.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });
}

function longDateFromISO(iso) {
  return longDate(new Date(iso + 'T00:00:00'));
}

function dayMarkerLabel(entry) {
  if (!entry || !entry.__day) return '';
  const m = DAY_MARKERS.find((x) => x.key === entry.__day);
  return m ? m.label : '';
}

// The optional "compared with usual" trajectory marker (easier/same/harder).
function trajectoryLabel(entry) {
  if (!entry || !entry.__trend) return '';
  const m = TRAJECTORY_MARKERS.find((x) => x.key === entry.__trend);
  return m ? m.label : '';
}

function entryTags(entry) {
  return entry && Array.isArray(entry.__tags) ? entry.__tags.filter((t) => typeof t === 'string' && t.trim()) : [];
}

// The optional named feelings for a day (an array of words, e.g. "calm").
function entryFeelings(entry) {
  return entry && Array.isArray(entry.__feelings) ? entry.__feelings.filter((f) => typeof f === 'string' && f.trim()) : [];
}

// The optional activities tapped for a day (an array of labels).
function entryActivities(entry) {
  return entry && Array.isArray(entry.__activities) ? entry.__activities.filter((a) => typeof a === 'string' && a.trim()) : [];
}

// Exports are text, so photos are noted by count rather than embedded. A day
// holding only a photo still counts as written, and still exports.
function entryMediaCount(entry) {
  return entry && Array.isArray(entry.__media) ? entry.__media.filter((m) => m && typeof m.id === 'string').length : 0;
}
function photosLine(entry) {
  const n = entryMediaCount(entry);
  return n ? `${n} ${n === 1 ? 'photo' : 'photos'}` : '';
}

// The day's main free-form note (the diary body). `note` is the primary field.
function entryNote(entry) {
  return entry && typeof entry.note === 'string' ? entry.note.trim() : '';
}

// The filled-in optional guided-prompt answers, in prompt order, followed by any
// answers whose prompt has since been removed (labelled from knownTitles). The
// free-form `note` is handled separately (it is the main body, not a prompt).
function orderedAnswers(entry, questions, titles) {
  const out = [];
  const qkeys = new Set(questions.map((q) => q.key));
  for (const q of questions) {
    const v = entry[q.key];
    if (typeof v === 'string' && v.trim()) out.push({ title: q.title, text: v.trim() });
  }
  for (const k of Object.keys(entry)) {
    if (k === 'note' || isReservedKey(k) || qkeys.has(k)) continue;
    const v = entry[k];
    if (typeof v === 'string' && v.trim()) {
      out.push({ title: (titles && titles[k]) || 'Note', text: v.trim() });
    }
  }
  return out;
}

function entryHasContent(entry, questions, titles) {
  return (
    Boolean(entryNote(entry)) ||
    Boolean(dayMarkerLabel(entry)) ||
    Boolean(trajectoryLabel(entry)) ||
    entryTags(entry).length > 0 ||
    entryFeelings(entry).length > 0 ||
    entryActivities(entry).length > 0 ||
    entryMediaCount(entry) > 0 ||
    orderedAnswers(entry, questions, titles).length > 0
  );
}

function contentDates(data, questions, titles) {
  return Object.keys(data.entries)
    .filter((date) => entryHasContent(data.entries[date], questions, titles))
    .sort();
}

// One plain-text timeline, oldest first, only the parts that were filled in.
// Uses \r\n line endings so it reads cleanly in Notepad.
function buildExportText(data, opts = {}) {
  const questions = opts.questions || DEFAULT_QUESTIONS;
  const titles = opts.knownTitles || {};
  const now = opts.now || new Date();
  const dates = contentDates(data, questions, titles);

  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const lines = [];
  lines.push('FLINT JOURNAL');
  lines.push('=============');
  lines.push(`Exported ${longDate(now)} at ${time}`);
  lines.push(`${dates.length} ${dates.length === 1 ? 'day' : 'days'} recorded`);

  for (const date of dates) {
    const entry = data.entries[date];
    const heading = longDateFromISO(date);
    lines.push('');
    lines.push('');
    lines.push(heading);
    lines.push('-'.repeat(heading.length));
    const marker = dayMarkerLabel(entry);
    if (marker) lines.push(`Overall: ${marker}`);
    const trend = trajectoryLabel(entry);
    if (trend) lines.push(`Compared with usual: ${trend}`);
    const feelings = entryFeelings(entry);
    if (feelings.length) lines.push(`Feelings: ${feelings.join(', ')}`);
    const activities = entryActivities(entry);
    if (activities.length) lines.push(`Activities: ${activities.join(', ')}`);
    const tags = entryTags(entry);
    if (tags.length) lines.push(`Tags: ${tags.join(', ')}`);
    const photos = photosLine(entry);
    if (photos) lines.push(`Photos: ${photos} (kept in your data folder)`);
    const note = entryNote(entry);
    if (note) { lines.push(''); lines.push(note); }
    // Guided-prompt answers, each under an indented title so they read clearly.
    for (const sec of orderedAnswers(entry, questions, titles)) {
      lines.push('');
      lines.push(`  ${sec.title}`);
      for (const ln of sec.text.split('\n')) lines.push(`    ${ln}`);
    }
  }

  lines.push('');
  return lines.join('\r\n');
}

// The same timeline as Markdown, so the journal can be read or reused anywhere
// (Obsidian, a plain editor) without Flint. Uses \n, as Markdown tools expect.
function buildExportMarkdown(data, opts = {}) {
  const questions = opts.questions || DEFAULT_QUESTIONS;
  const titles = opts.knownTitles || {};
  const now = opts.now || new Date();
  const dates = contentDates(data, questions, titles);
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  const out = [];
  out.push('# Flint journal');
  out.push('');
  out.push(`Exported ${longDate(now)} at ${time}. ${dates.length} ${dates.length === 1 ? 'day' : 'days'} recorded.`);

  for (const date of dates) {
    const entry = data.entries[date];
    out.push('', '---', '');
    out.push(`## ${longDateFromISO(date)}`);
    const marker = dayMarkerLabel(entry);
    const trend = trajectoryLabel(entry);
    const feelings = entryFeelings(entry);
    const activities = entryActivities(entry);
    const tags = entryTags(entry);
    const photos = photosLine(entry);
    if (marker || trend || feelings.length || activities.length || tags.length || photos) {
      out.push('');
      if (marker) out.push(`**Overall:** ${marker}`);
      if (trend) out.push(`**Compared with usual:** ${trend}`);
      if (feelings.length) out.push(`**Feelings:** ${feelings.join(', ')}`);
      if (activities.length) out.push(`**Activities:** ${activities.join(', ')}`);
      if (tags.length) out.push(`**Tags:** ${tags.join(', ')}`);
      if (photos) out.push(`**Photos:** ${photos} (kept in your data folder)`);
    }
    const note = entryNote(entry);
    if (note) { out.push(''); out.push(note); }
    for (const sec of orderedAnswers(entry, questions, titles)) {
      out.push('', `### ${sec.title}`, '', sec.text);
    }
  }
  out.push('');
  return out.join('\n');
}

// Merges an imported journal into the current one. Days we do not already have
// are added; days we do have are left exactly as they are. An import can only
// ever add to the record, never quietly rewrite a day that is already written.
function mergeImported(current, incoming) {
  let added = 0, skipped = 0;
  const out = { version: 1, entries: { ...current.entries } };
  for (const [date, entry] of Object.entries((incoming && incoming.entries) || {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (Object.prototype.hasOwnProperty.call(out.entries, date)) { skipped++; continue; }
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) { out.entries[date] = entry; added++; }
  }
  return { data: out, added, skipped };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// A self-contained, printable HTML document (used to make the PDF). No external
// fonts, styles or images, so it renders identically with the internet off.
function buildExportHtml(data, opts = {}) {
  const questions = opts.questions || DEFAULT_QUESTIONS;
  const titles = opts.knownTitles || {};
  const now = opts.now || new Date();
  const dates = contentDates(data, questions, titles);

  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const parts = [];
  // This document is built from the user's own words and rendered in a real
  // browser window to make the PDF, so it gets a CSP of its own: no scripts, no
  // network, nothing but the text and the styles below.
  parts.push('<!DOCTYPE html><html lang="en-GB"><head><meta charset="UTF-8">');
  // See the note in buildActivityReportHtml: without this, the PDF /Title
  // becomes the data: URL, which is the entire journal.
  parts.push('<title>Flint journal</title>');
  parts.push('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:">');
  parts.push('<style>');
  parts.push(`
    * { box-sizing: border-box; }
    body { font-family: Georgia, "Times New Roman", serif; color: #2b2721;
           line-height: 1.65; margin: 0; padding: 0; }
    .doc-head { border-bottom: 3px solid #c9772f; padding-bottom: 0.55rem; margin: 0 0 1.8rem; }
    h1 { font-size: 24pt; margin: 0 0 0.25rem; letter-spacing: -0.01em; }
    .meta { color: #6a6154; font-size: 10.5pt; margin: 0; }
    .day { margin: 0 0 1.6rem; page-break-inside: avoid; }
    h2 { font-size: 15pt; margin: 0 0 0.35rem; color: #23201b; }
    .day-meta { margin: 0 0 0.7rem; }
    .badge { display: inline-block; font-size: 9.5pt; padding: 0.12rem 0.6rem; border-radius: 999px;
             background: #f0e6d6; color: #6a5a3d; margin: 0 0.35rem 0.25rem 0; }
    .note { white-space: pre-wrap; font-size: 12pt; margin: 0 0 0.6rem; }
    .prompt { margin: 0.75rem 0 0; }
    .prompt-title { font-size: 10pt; font-weight: bold; color: #9a6a2f;
                    text-transform: uppercase; letter-spacing: 0.05em; margin: 0 0 0.1rem; }
    .prompt-answer { white-space: pre-wrap; font-size: 11.5pt; margin: 0; }
    hr.day-rule { border: 0; border-top: 1px solid #e2d7c4; margin: 0 0 1.6rem; }
  `);
  parts.push('</style></head><body>');
  parts.push('<div class="doc-head">');
  parts.push('<h1>Flint journal</h1>');
  parts.push(
    `<p class="meta">Exported ${escapeHtml(longDate(now))} at ${escapeHtml(time)} ` +
    `&nbsp;&middot;&nbsp; ${dates.length} ${dates.length === 1 ? 'day' : 'days'} recorded</p>`
  );
  parts.push('</div>');

  dates.forEach((date, i) => {
    const entry = data.entries[date];
    parts.push('<section class="day">');
    parts.push(`<h2>${escapeHtml(longDateFromISO(date))}</h2>`);
    const badges = [];
    const marker = dayMarkerLabel(entry);
    if (marker) badges.push(`<span class="badge">${escapeHtml(marker)}</span>`);
    const trend = trajectoryLabel(entry);
    if (trend) badges.push(`<span class="badge">${escapeHtml(trend)}</span>`);
    for (const f of entryFeelings(entry)) badges.push(`<span class="badge badge-feeling">${escapeHtml(f)}</span>`);
    for (const a of entryActivities(entry)) badges.push(`<span class="badge">${escapeHtml(a)}</span>`);
    for (const t of entryTags(entry)) badges.push(`<span class="badge">${escapeHtml(t)}</span>`);
    const photos = photosLine(entry);
    if (photos) badges.push(`<span class="badge">${escapeHtml(photos)}</span>`);
    if (badges.length) parts.push(`<div class="day-meta">${badges.join('')}</div>`);
    const note = entryNote(entry);
    if (note) parts.push(`<p class="note">${escapeHtml(note)}</p>`);
    for (const sec of orderedAnswers(entry, questions, titles)) {
      parts.push('<div class="prompt">');
      parts.push(`<p class="prompt-title">${escapeHtml(sec.title)}</p>`);
      parts.push(`<p class="prompt-answer">${escapeHtml(sec.text)}</p>`);
      parts.push('</div>');
    }
    parts.push('</section>');
    if (i < dates.length - 1) parts.push('<hr class="day-rule">');
  });

  parts.push('</body></html>');
  return parts.join('');
}

// --------------------------------------------------- activities summary
//
// A discreet, print-ready per-day record organised so that everyday activities
// and how a day varied (easier/harder than usual) are easy to read at a glance,
// e.g. to keep for your own reference or to show someone helping you. Uses only
// what you have written; deliberately plain wording, no labels beyond that.

// The activities summary is the export the app offers "to show someone who is
// helping you", so its contents must match what its own header says it covers.
// It used to embed the whole free-text note and every guided-prompt answer, so
// a user handing it to an assessor handed over the entire diary without knowing.
// The writing is opt-in now; "Save journal" is the export for sharing everything.
function buildActivityReport(data, opts = {}) {
  const includeWriting = opts.includeWriting === true;
  const questions = opts.questions || DEFAULT_QUESTIONS;
  const titles = opts.knownTitles || {};
  const now = opts.now || new Date();
  const dates = contentDates(data, questions, titles);
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  const lines = [];
  lines.push('DAILY ACTIVITIES SUMMARY');
  lines.push('========================');
  lines.push(`Prepared ${longDate(now)} at ${time}`);
  lines.push(`${dates.length} ${dates.length === 1 ? 'day' : 'days'} recorded`);
  lines.push('');
  lines.push('A day-by-day record of everyday activities and how they varied.');
  lines.push('');
  if (!includeWriting) {
    lines.push('This summary lists activities, how each day went and any tags or');
    lines.push('feelings chosen. It does NOT include the diary writing itself. To');
    lines.push('share everything, use "Save journal" instead.');
    lines.push('');
  }
  lines.push('The everyday activities this record covers:');
  REPORT_ACTIVITIES.forEach((a, i) => lines.push(`  ${i + 1}. ${a}`));

  for (const date of dates) {
    const entry = data.entries[date];
    const heading = longDateFromISO(date);
    lines.push('');
    lines.push('');
    lines.push(heading);
    lines.push('-'.repeat(heading.length));
    const marker = dayMarkerLabel(entry);
    if (marker) lines.push(`Overall: ${marker}`);
    const trend = trajectoryLabel(entry);
    if (trend) lines.push(`Compared with usual: ${trend}`);
    const activities = entryActivities(entry);
    if (activities.length) lines.push(`Activities: ${activities.join(', ')}`);
    const feelings = entryFeelings(entry);
    if (feelings.length) lines.push(`Feelings: ${feelings.join(', ')}`);
    const tags = entryTags(entry);
    if (tags.length) lines.push(`Tags: ${tags.join(', ')}`);
    const photos = photosLine(entry);
    if (photos) lines.push(`Photos: ${photos} (kept in your data folder)`);
    const note = entryNote(entry);
    if (includeWriting) {
      if (note) { lines.push(''); lines.push(note); }
      for (const sec of orderedAnswers(entry, questions, titles)) {
        lines.push('');
        lines.push(`  ${sec.title}`);
        for (const ln of sec.text.split('\n')) lines.push(`    ${ln}`);
      }
    }
  }

  lines.push('');
  return lines.join('\r\n');
}

// The same summary as a self-contained printable HTML document (used for the
// PDF). No external fonts, styles or images, so it prints the same offline.
// Same scope rule as buildActivityReport: activities and markers only, unless
// the caller explicitly asks for the writing too.
function buildActivityReportHtml(data, opts = {}) {
  const includeWriting = opts.includeWriting === true;
  const questions = opts.questions || DEFAULT_QUESTIONS;
  const titles = opts.knownTitles || {};
  const now = opts.now || new Date();
  const dates = contentDates(data, questions, titles);
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  const parts = [];
  parts.push('<!DOCTYPE html><html lang="en-GB"><head><meta charset="UTF-8">');
  // A real title, or Chromium falls back to the document's URL when it writes
  // the PDF /Title. These documents are rendered from a data: URL, so that
  // fallback puts thousands of characters of the diary into the file metadata,
  // where it is invisible on screen but readable in File > Properties, exiftool
  // and the Windows search index. printToPDF has no title option: this element
  // is the fix.
  parts.push('<title>Daily activities summary</title>');
  parts.push('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:">');
  parts.push('<style>');
  parts.push(`
    * { box-sizing: border-box; }
    body { font-family: Georgia, "Times New Roman", serif; color: #2b2721; line-height: 1.6; margin: 0; padding: 0; }
    .doc-head { border-bottom: 3px solid #c9772f; padding-bottom: 0.55rem; margin: 0 0 1.3rem; }
    h1 { font-size: 22pt; margin: 0 0 0.25rem; letter-spacing: -0.01em; }
    .meta { color: #6a6154; font-size: 10.5pt; margin: 0; }
    .intro { font-size: 11.5pt; margin: 0 0 0.8rem; }
    .areas { background: #f7f1e7; border: 1px solid #e2d7c4; border-radius: 8px; padding: 0.6rem 1rem; margin: 0 0 1.8rem; page-break-inside: avoid; }
    .areas h2 { font-size: 11pt; text-transform: uppercase; letter-spacing: 0.05em; color: #9a6a2f; margin: 0 0 0.4rem; }
    .areas ol { margin: 0; padding-left: 1.3rem; columns: 2; font-size: 10.5pt; }
    .areas li { margin: 0 0 0.15rem; }
    .day { margin: 0 0 1.4rem; page-break-inside: avoid; }
    h3 { font-size: 14pt; margin: 0 0 0.35rem; color: #23201b; }
    .day-meta { margin: 0 0 0.5rem; }
    .badge { display: inline-block; font-size: 9.5pt; padding: 0.12rem 0.6rem; border-radius: 999px; background: #f0e6d6; color: #6a5a3d; margin: 0 0.35rem 0.25rem 0; }
    .note { white-space: pre-wrap; font-size: 11.5pt; margin: 0.3rem 0 0.6rem; }
    .prompt { margin: 0.6rem 0 0; }
    .prompt-title { font-size: 10pt; font-weight: bold; color: #9a6a2f; text-transform: uppercase; letter-spacing: 0.05em; margin: 0 0 0.1rem; }
    .prompt-answer { white-space: pre-wrap; font-size: 11pt; margin: 0; }
    hr.day-rule { border: 0; border-top: 1px solid #e2d7c4; margin: 0 0 1.4rem; }
  `);
  parts.push('</style></head><body>');
  parts.push('<div class="doc-head"><h1>Daily activities summary</h1>');
  parts.push(
    `<p class="meta">Prepared ${escapeHtml(longDate(now))} at ${escapeHtml(time)} ` +
    `&nbsp;&middot;&nbsp; ${dates.length} ${dates.length === 1 ? 'day' : 'days'} recorded</p></div>`
  );
  parts.push('<p class="intro">A day-by-day record of everyday activities and how they varied.</p>');
  parts.push('<div class="areas"><h2>The everyday activities this record covers</h2><ol>');
  for (const a of REPORT_ACTIVITIES) parts.push(`<li>${escapeHtml(a)}</li>`);
  parts.push('</ol></div>');

  dates.forEach((date, i) => {
    const entry = data.entries[date];
    parts.push('<section class="day">');
    parts.push(`<h3>${escapeHtml(longDateFromISO(date))}</h3>`);
    const badges = [];
    const marker = dayMarkerLabel(entry);
    if (marker) badges.push(`<span class="badge">${escapeHtml(marker)}</span>`);
    const trend = trajectoryLabel(entry);
    if (trend) badges.push(`<span class="badge">${escapeHtml(trend)}</span>`);
    for (const act of entryActivities(entry)) badges.push(`<span class="badge">${escapeHtml(act)}</span>`);
    for (const f of entryFeelings(entry)) badges.push(`<span class="badge">${escapeHtml(f)}</span>`);
    for (const t of entryTags(entry)) badges.push(`<span class="badge">${escapeHtml(t)}</span>`);
    const photos = photosLine(entry);
    if (photos) badges.push(`<span class="badge">${escapeHtml(photos)}</span>`);
    if (badges.length) parts.push(`<div class="day-meta">${badges.join('')}</div>`);
    if (includeWriting) {
      const note = entryNote(entry);
      if (note) parts.push(`<p class="note">${escapeHtml(note)}</p>`);
      for (const sec of orderedAnswers(entry, questions, titles)) {
        parts.push('<div class="prompt">');
        parts.push(`<p class="prompt-title">${escapeHtml(sec.title)}</p>`);
        parts.push(`<p class="prompt-answer">${escapeHtml(sec.text)}</p>`);
        parts.push('</div>');
      }
    }
    parts.push('</section>');
    if (i < dates.length - 1) parts.push('<hr class="day-rule">');
  });

  parts.push('</body></html>');
  return parts.join('');
}

// ----------------------------------------------------------- window PIN
//
// This is the LEGACY lock: it only gates the app window, entries stay readable
// on disk, so a forgotten window PIN is recovered by deleting settings.json.
// Turning on encryption (below) supersedes it and clears it. It is kept so
// existing installs that set a window PIN keep working.

// Settings are read on a one-minute timer for the whole time Flint sits in the
// tray, so an uncached read is roughly 1,440 full reads and JSON parses a day
// for a value that almost never changes.
//
// The cache is validated by stat rather than simply trusted. Assuming this
// process is the only writer would be wrong in a case that matters: deleting
// settings.json by hand is the documented way to recover from a forgotten
// window PIN. A stat is far cheaper than a read plus parse and it keeps that
// path working, so correctness costs almost nothing here.
let settingsCache = null;
let settingsStamp = '';
function invalidateSettingsCache() { settingsCache = null; settingsStamp = ''; }

// "The file is not there" and "the file could not be read" are completely
// different answers, and collapsing them was a real hazard: a transient read
// failure (antivirus or a sync client holding the file) cached an empty object
// against the LIVE file's stamp, so every later read that session returned {}.
// The next settings write then flattened the file, taking custom prompts, the
// window PIN hash, days off, the reminder and the backup folder with it, with no
// error and no backup anywhere. Only ENOENT may be treated as empty; anything
// else leaves the cache alone and is reported, so a caller can refuse to write.
class SettingsUnreadable extends Error {}

async function loadSettings() {
  let stamp = '';
  try {
    const st = await fsp.stat(P.settingsFile);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch (err) {
    if (err.code !== 'ENOENT') throw new SettingsUnreadable(err.code || err.message);
    // genuinely absent: a fresh install, so an empty object is the truth
    settingsCache = {};
    settingsStamp = '';
    return settingsCache;
  }
  if (settingsCache && stamp === settingsStamp) return settingsCache;
  let parsed;
  try {
    parsed = JSON.parse(await fsp.readFile(P.settingsFile, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') { settingsCache = {}; settingsStamp = ''; return settingsCache; }
    // Unreadable or unparseable while the file exists. Do NOT cache anything:
    // the next read should try again rather than serve a fiction.
    invalidateSettingsCache();
    throw new SettingsUnreadable(err && (err.code || err.message));
  }
  settingsCache = parsed && typeof parsed === 'object' ? parsed : {};
  settingsStamp = stamp;
  return settingsCache;
}

async function saveSettings(settings) {
  if (!settings || typeof settings !== 'object') throw new Error('Refusing to write settings that are not an object.');
  await writeFileAtomic(P.settingsFile, JSON.stringify(settings, null, 2));
  settingsCache = settings;
  try {
    const st = await fsp.stat(P.settingsFile);
    settingsStamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    settingsStamp = ''; // unknown: the next read revalidates rather than trusting
  }
}

// Every getter wants the same thing: the settings if they are readable, and a
// safe default if they are genuinely absent, but never a fiction after a read
// failure. Setters deliberately do NOT use this: they must throw so the caller
// reports the failure instead of writing over settings it could not read.
async function loadSettingsOrDefault(fallback = {}) {
  try {
    return await loadSettings();
  } catch (err) {
    if (err instanceof SettingsUnreadable) return fallback;
    throw err;
  }
}

// Read before app.whenReady, so it cannot use the async API above. Only for
// flags that must be known before the first window exists. Defaults on any
// failure, because a settings problem must never stop Flint opening.
function readStartupFlagsSync() {
  try {
    const parsed = JSON.parse(fs.readFileSync(P.settingsFile, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return { hardwareAcceleration: true };
    return { hardwareAcceleration: parsed.hardwareAcceleration !== false };
  } catch {
    return { hardwareAcceleration: true };
  }
}

function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 64).toString('hex');
}

async function pinIsSet() {
  const s = await loadSettingsOrDefault();
  return Boolean(s.pin && s.pin.salt && s.pin.hash);
}

async function setPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const s = await loadSettings();
  s.pin = { salt, hash: hashPin(pin, salt) };
  await saveSettings(s);
}

async function verifyPin(pin) {
  const s = await loadSettingsOrDefault();
  if (!s.pin || !s.pin.salt || !s.pin.hash) return false;
  const expected = Buffer.from(s.pin.hash, 'hex');
  const actual = Buffer.from(hashPin(pin, s.pin.salt), 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

async function removePin() {
  const s = await loadSettings();
  delete s.pin;
  await saveSettings(s);
}

// ------------------------------------------------------------- encryption
//
// Real at-rest encryption (see crypto.js). When it is on, entries.json is a
// vault and the data key lives only in memory while unlocked. The PIN unlocks
// it day to day; the recovery code (shown once) is the fallback for a forgotten
// PIN. Losing both is unrecoverable by design, which is what makes it real.

// Looks at entries.json WITHOUT deciding anything it cannot actually tell.
// Returns one of:
//   { state: 'vault', vault }  the file is an encrypted vault
//   { state: 'plain' }         the file exists and is not a vault
//   { state: 'absent' }        there is no file yet
//   { state: 'unknown' }       it could not be read (locked by antivirus, a
//                              sync client, permissions, a bad disk)
//
// The distinction between 'plain' and 'unknown' is the whole point. Treating an
// unreadable file as "not encrypted" is how an encrypted journal gets silently
// overwritten in the clear, so callers must never downgrade on 'unknown'.
async function peekVaultState() {
  let raw;
  try {
    raw = await fsp.readFile(P.dataFile, 'utf8');
  } catch (err) {
    return { state: err.code === 'ENOENT' ? 'absent' : 'unknown', error: err.code || err.message };
  }
  try {
    const parsed = JSON.parse(raw);
    return vaultCrypto.isVault(parsed) ? { state: 'vault', vault: parsed } : { state: 'plain' };
  } catch {
    return { state: 'plain' }; // readable but not JSON: loadData quarantines it
  }
}

// Convenience for the paths that only care about an actually-present vault.
// Throws on 'unknown' so no caller can mistake a read failure for plaintext.
async function requireVaultState() {
  const s = await peekVaultState();
  if (s.state === 'unknown') throw new Error(`Your journal file could not be read (${s.error}). Nothing was changed.`);
  return s;
}

// Whether the journal is encrypted, and if so whether this session holds the
// key. Reads the disk so it is correct even before the first loadData().
async function securityStatus() {
  const s = await peekVaultState();
  if (s.state === 'vault') {
    encryptedOnDisk = encryptedEverThisSession = true;
    sessionVault = s.vault;
    // If the file changed underneath us, the key we hold may no longer belong to
    // it. Resealing a body under a key the wraps do not match would leave a
    // journal nobody could ever open, so drop the key and ask for the PIN again.
    if (sessionDk) {
      try { vaultCrypto.openWithDk(s.vault, sessionDk); }
      catch { clearSessionDk(); }
    }
  } else if (s.state === 'plain' || s.state === 'absent') {
    // A session that is encrypted and unlocked must NOT be downgraded by the
    // file going missing or unreadable underneath us. That is always an outside
    // event (Flint verifies its own writes), and treating it as "encryption is
    // off" drops the key and lets the next autosave write every entry in the
    // clear while the UI still says encrypted. Only an explicit
    // disableEncryption may turn encryption off.
    if (!(encryptedOnDisk && sessionDk)) {
      encryptedOnDisk = false;
      sessionVault = null;
      clearSessionDk();
    }
  }
  // 'unknown' deliberately changes nothing: we could not read the file, so we
  // still believe whatever we last knew. Downgrading here would drop the key and
  // let the next save write the journal out in the clear.
  const windowPin = await pinIsSet();
  return {
    ok: true,
    encrypted: encryptedOnDisk,
    unlocked: encryptedOnDisk ? Boolean(sessionDk) : true,
    windowPin: !encryptedOnDisk && windowPin,
    unreadable: s.state === 'unknown'
  };
}

// Unlock the vault with the PIN. On success the key is held for this session.
async function unlock(pin) {
  let s;
  try { s = await requireVaultState(); }
  catch (err) { return { ok: false, error: err.message }; }
  if (s.state !== 'vault') { encryptedOnDisk = false; return { ok: true }; } // nothing to unlock
  const opened = await openVaultWith(s.vault, () => vaultCrypto.openWithPin(s.vault, pin), 'PIN');
  if (!opened.ok) return opened;
  await upgradeWrapCost(pin);
  return { ok: true };
}

// Shared by the PIN and recovery paths. Splits "your secret is wrong" from "the
// file is damaged": if the wrap opens but the body will not decrypt, the secret
// was RIGHT and the journal is corrupt. Saying "wrong PIN" there is how someone
// burns their recovery code and concludes the journal is gone, when a backup
// would have restored it.
async function openVaultWith(vault, opener, secretName) {
  let dk, data;
  try {
    ({ dk, data } = await opener());
  } catch (err) {
    if (err && err.code === 'FLINT_DAMAGED') {
      return { ok: false, damaged: true, error: `Your ${secretName} is correct, but the journal file is damaged, so it could not be opened. A backup can be restored from your data folder.` };
    }
    return { ok: false, error: `That ${secretName} did not work.` };
  }
  void data;
  setSessionDk(dk);
  sessionVault = vault;
  encryptedOnDisk = encryptedEverThisSession = true;
  return { ok: true };
}

// If the PIN wrap was written at an older, cheaper cost, rewrite it at the
// current cost now that we hold the PIN. Best effort: a failure here must never
// block an unlock, since the existing wrap still works.
async function upgradeWrapCost(pin) {
  try {
    if (!sessionVault || !sessionDk || !vaultCrypto.isStaleWrap(sessionVault.pin)) return;
    await runExclusive(async () => {
      const next = await vaultCrypto.rewrapPin(sessionVault, sessionDk, pin);
      await writeMainAndBackup(JSON.stringify(next, null, 2));
      sessionVault = next;
    });
  } catch { /* keep the session; the old wrap is still valid */ }
}

// Unlock the vault with the recovery code (the forgotten-PIN path).
async function unlockWithRecovery(code) {
  let s;
  try { s = await requireVaultState(); }
  catch (err) { return { ok: false, error: err.message }; }
  if (s.state !== 'vault') { encryptedOnDisk = false; return { ok: true }; }
  return openVaultWith(s.vault, () => vaultCrypto.openWithRecovery(s.vault, code), 'recovery code');
}

// Wipe the key from memory. Disk stays encrypted; the app should show its gate.
function lock() {
  clearSessionDk();
  return { ok: true };
}

// Removes any backup files that are plaintext journals, leaving encrypted ones.
// Called when encryption is switched on so old cleartext copies do not linger.
// Returns how many plaintext copies it could NOT remove, so enabling encryption
// can say so plainly instead of claiming success while readable journals remain.
// Anything it cannot prove is a vault is treated as plaintext and removed: a
// half-written or truncated copy still holds the words.
async function purgePlaintextIn(dir, pattern, sweepTmp = true) {
  let left = 0;
  let names;
  try { names = await fsp.readdir(dir); } catch { return left; }
  for (const name of names) {
    // .tmp leftovers from an interrupted write hold the full plaintext journal
    // and match no normal pattern, so nothing else would ever clear them. Callers
    // that share a directory with OTHER atomic writers (the data root, where
    // settings.json is written outside the save lock) pass sweepTmp:false so a
    // concurrent foreign *.tmp is never unlinked mid-rename.
    const isTmp = sweepTmp && name.endsWith('.tmp');
    if (!pattern.test(name) && !isTmp) continue;
    const full = path.join(dir, name);
    try {
      if (!isTmp) {
        const parsed = JSON.parse(await fsp.readFile(full, 'utf8'));
        if (vaultCrypto.isVault(parsed)) continue; // already encrypted, keep it
      }
      await fsp.unlink(full);
    } catch {
      left++;
    }
  }
  return left;
}

async function purgePlaintextBackups() {
  return purgePlaintextIn(P.backupsDir, /^entries-.*\.json$/);
}

// Copies already sitting in the user's chosen backup folder are the same leak,
// and worse if that folder syncs to a cloud. If the folder is not reachable we
// say so rather than pretend it was handled.
async function purgeExternalPlaintextBackups() {
  const cfg = await getBackupSettings();
  if (!cfg.folder || !isSafeBackupFolder(cfg.folder)) return { reachable: false, left: 0 };
  const dir = path.join(cfg.folder, BACKUP_SUBFOLDER);
  try { await fsp.access(dir); } catch { return { reachable: false, left: 0 }; }
  return { reachable: true, left: await purgePlaintextIn(dir, BACKUP_PATTERN) };
}

// Turn encryption on for a currently-plaintext journal. Returns the one-time
// recovery code, which the UI must show the user once and never store.
// Is there anything on disk that might still hold journal entries? Used before
// encrypting an empty journal, because that operation deletes the plaintext
// copies and there is no way back from it. Describes what it found in the
// user's own words, or returns '' when the data folder really is empty.
async function recoverableCopiesExist() {
  const found = [];
  try {
    const names = await fsp.readdir(P.dataDir);
    const quarantined = names.filter((n) => /^entries\.json\.corrupt-/.test(n)).length;
    if (quarantined) found.push(`${quarantined} set-aside ${quarantined === 1 ? 'copy' : 'copies'} of your journal`);
  } catch { /* an unreadable data folder is handled by the caller's other checks */ }
  try {
    const backup = await newestValidBackup();
    const entries = backup && backup.parsed && backup.parsed.entries ? Object.keys(backup.parsed.entries).length : 0;
    if (entries) found.push(`a backup holding ${entries} ${entries === 1 ? 'day' : 'days'}`);
  } catch { /* backups are best effort here */ }
  return found.join(' and ');
}

function enableEncryption(pin) {
  return runExclusive(async () => {
    const pre = await requireVaultState();
    if (pre.state === 'vault') return { ok: false, error: 'Your journal is already encrypted.' };
    if (typeof pin !== 'string' || pin.length < 4) {
      return { ok: false, error: 'Choose a PIN of at least 4 characters.' };
    }
    // Refuse unless we can PROVE we captured the real journal. The old code fell
    // back to emptyData() here, which looks harmless because emptyData() is
    // valid, and was catastrophic: after loadData quarantines an unreadable
    // entries.json the file is absent, so a second read returns an empty journal
    // with no warning. We would then seal a vault around nothing and, in the
    // tidy-up below, delete the plaintext backups AND the quarantined original,
    // reporting success. Encrypting nothing is never worth doing, and it must
    // never be the step that destroys the copies.
    const loaded = await loadData();
    if (loaded.locked) {
      return { ok: false, error: 'Your journal is locked, so encryption was not changed.' };
    }
    if (!loaded.data || !isValidData(loaded.data)) {
      return { ok: false, error: 'Your journal could not be read, so nothing was encrypted and nothing was changed. Please reopen Flint and check your journal is showing before turning encryption on.' };
    }
    if (loaded.warning) {
      // loadData recovered from a backup or started empty. Either way the file
      // it would encrypt is not the one the user thinks it is, and the purge
      // below would remove the copies that still hold the original.
      return { ok: false, error: `Encryption was not turned on, and nothing was changed. ${loaded.warning} Please make sure your journal is showing the days you expect, save once, then turn encryption on.` };
    }
    const data = loaded.data;
    // The warning check above is not enough on its own. After loadData
    // quarantines an unreadable entries.json the file is ABSENT, so the next
    // read takes the ENOENT path and returns an empty journal with no warning
    // at all, indistinguishable from a fresh install. Encrypting nothing is
    // harmless on a fresh install and catastrophic here, because the tidy-up
    // below deletes the very copies that still hold the writing. So when the
    // journal is empty, refuse if anything on disk looks like it holds more.
    if (!Object.keys(data.entries || {}).length) {
      const rescue = await recoverableCopiesExist();
      if (rescue) {
        return { ok: false, error: `Encryption was not turned on, and nothing was changed. Your journal is showing no entries, but Flint can still see ${rescue} on disk, so it will not encrypt an empty journal and remove them. Please reopen Flint and check your days are showing first.` };
      }
    }
    const { vault, recoveryCode, dk } = await vaultCrypto.createVault(data, pin);
    await writeMainAndBackup(JSON.stringify(vault, null, 2));
    setSessionDk(dk);
    sessionVault = vault;
    encryptedOnDisk = encryptedEverThisSession = true;

    // Everything past this point is tidying, and the vault is already committed.
    // If any of it throws, the recovery code would be lost forever while the
    // journal stayed encrypted, so nothing here is allowed to be fatal.
    const leftovers = [];
    try {
      // The vault is already committed above, so the new-key copies are safe to
      // move in immediately. Anything that would not convert is reported.
      const { prepared, failed } = await rewriteMediaPrepare(dk, true);
      const stuck = await mediaSidecarCommit(prepared);
      const left = failed.length + stuck.length;
      if (left) leftovers.push(`${left} ${left === 1 ? 'photo is' : 'photos are'} still unencrypted`);
    } catch { leftovers.push('photos could not all be encrypted'); }
    try {
      const left = await purgePlaintextBackups();
      if (left) leftovers.push(`${left} readable backup ${left === 1 ? 'copy' : 'copies'} could not be removed`);
    } catch { leftovers.push('old readable backups could not be removed'); }
    try {
      const ext = await purgeExternalPlaintextBackups();
      if (ext.left) leftovers.push(`${ext.left} readable ${ext.left === 1 ? 'copy' : 'copies'} could not be removed from your backup folder`);
    } catch { leftovers.push('your backup folder could not be cleaned'); }
    // The data root can hold an entries.json.corrupt-* copy set aside by loadData
    // in the clear. purgePlaintextIn keeps the live vault and any file that is
    // itself a vault, deleting only confirmed-plaintext copies. sweepTmp:false so a
    // concurrent settings.json.tmp write (settings save runs off the lock) is never
    // touched; a stale entries.json.tmp is already consumed by the vault write above.
    try {
      const left = await purgePlaintextIn(P.dataDir, /^entries\.json\.corrupt-/, false);
      if (left) leftovers.push(`${left} readable ${left === 1 ? 'copy' : 'copies'} of your journal set aside earlier could not be removed`);
    } catch { leftovers.push('a readable copy of your journal beside it could not be removed'); }
    try { await removePin(); } catch { /* the encryption PIN supersedes it anyway */ }

    return { ok: true, recoveryCode, leftovers };
  });
}

// Turn encryption off, writing the journal back as plaintext. Requires the PIN.
function disableEncryption(pin) {
  return runExclusive(async () => {
    const s = await requireVaultState();
    if (s.state !== 'vault') { encryptedOnDisk = false; clearSessionDk(); sessionVault = null; return { ok: true }; }
    let data, dk;
    try {
      ({ data, dk } = await vaultCrypto.openWithPin(s.vault, pin));
    } catch (err) {
      if (err && err.code === 'FLINT_DAMAGED') {
        return { ok: false, error: 'Your PIN is correct, but the journal file is damaged, so encryption was left on.' };
      }
      return { ok: false, error: 'That PIN did not work, so encryption was left on.' };
    }
    // Photos FIRST, and only continue if every one of them came back. Clearing
    // the key while an attachment is still encrypted would strand it forever:
    // the vault (and its wraps) would be gone, so nothing could re-derive it.
    // Photos first and in two phases, because the key disappears at the end of
    // this function: a photo still encrypted after that is lost. Phase one
    // touches no original, so giving up here really does change nothing.
    const { prepared, failed } = await rewriteMediaPrepare(dk, false);
    if (failed.length) {
      await mediaSidecarAbort(prepared);
      return {
        ok: false,
        error: `Encryption was left ON because ${failed.length} ${failed.length === 1 ? 'photo' : 'photos'} could not be unlocked just now (they may be open in another program). Nothing was changed. Please try again.`
      };
    }
    const stuck = await mediaSidecarCommit(prepared);
    if (stuck.length) {
      // Some photos are readable now and some are not. The vault is still on
      // disk and we still hold the key, so keeping encryption ON is the state
      // everything can still be recovered from. Say exactly that.
      return {
        ok: false,
        error: `Encryption was left ON because ${stuck.length} ${stuck.length === 1 ? 'photo' : 'photos'} could not be replaced just now (they may be open in another program). Some photos are already readable, and your journal is unchanged. Close anything using your photos and try again.`
      };
    }
    await writeMainAndBackup(JSON.stringify(data, null, 2));
    clearSessionDk();
    sessionVault = null;
    encryptedOnDisk = false;
    // A deliberate turn-off is the only thing allowed to clear the sticky flag,
    // otherwise plaintext saves would be refused for the rest of the session.
    encryptedEverThisSession = false;
    return { ok: true };
  });
}

// Re-encrypt every attachment from one data key to another, in two phases.
//
// This used to rewrite each photo in place. If photo 12 of 40 failed (open in
// another program, an antivirus scan, a sync client), the caller returned early
// and threw the new key away, leaving photos 1 to 11 sealed under a key that
// then existed nowhere. They were unreadable forever, the message said "Nothing
// was changed", and every retry hit the same wall, because those files no longer
// decrypted with the old key either.
//
// Now phase one only writes <id>.rekey sidecars, so a failure anywhere leaves
// every original untouched and "nothing was changed" is true. Phase two renames
// the sidecars in, and runs only after the vault holding the new key is on disk.
async function rekeyMediaPrepare(oldDk, newDk) {
  const prepared = [];
  const failed = [];
  let names;
  try { names = await fsp.readdir(P.mediaDir); } catch { return { prepared, failed }; }
  for (const name of names.filter((n) => n.endsWith('.tmp'))) {
    await fsp.unlink(path.join(P.mediaDir, name)).catch(() => {});
  }
  for (const name of names.filter(isSafeMediaId)) {
    const file = mediaPath(name);
    const sidecar = `${file}.rekey`;
    try {
      const blob = await fsp.readFile(file);
      const raw = isEncryptedBlob(blob) ? vaultCrypto.decryptBuffer(oldDk, blob.subarray(MEDIA_MAGIC.length)) : blob;
      await writeFileAtomicRaw(sidecar, Buffer.concat([MEDIA_MAGIC, vaultCrypto.encryptBuffer(newDk, raw)]));
      prepared.push({ file, sidecar });
    } catch {
      failed.push(name);
    }
  }
  return { prepared, failed };
}

// Give up cleanly: the originals were never touched, so removing the sidecars
// returns the folder to exactly the state we found it in.
async function mediaSidecarAbort(prepared) {
  for (const p of prepared) await fsp.unlink(p.sidecar).catch(() => {});
}

// Move the new-key copies into place. A rename that fails here leaves its
// sidecar behind on purpose: the sidecar holds the only readable copy under the
// new key, so deleting it would be the very loss this rewrite exists to prevent.
async function mediaSidecarCommit(prepared) {
  const stuck = [];
  for (const p of prepared) {
    let done = false;
    for (let i = 0; i < 3 && !done; i++) {
      try { await fsp.rename(p.sidecar, p.file); done = true; }
      catch { await new Promise((r) => setTimeout(r, 40)); }
    }
    if (!done) stuck.push(p.file);
  }
  return stuck;
}

// Move the rolling backups onto the new key as well. A backup that still holds
// the OLD wraps is exactly what makes changing a PIN meaningless, so any copy we
// cannot move over is deleted rather than left answering to the old secret.
// Returns how many were removed, so the user can be told plainly.
async function rekeyBackups(oldDk, newDk, newVault) {
  let removed = 0;
  let names;
  try { names = await fsp.readdir(P.backupsDir); } catch { return removed; }
  for (const name of names.filter((n) => /^entries-.*\.json/.test(n))) {
    const file = path.join(P.backupsDir, name);
    try {
      const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (!vaultCrypto.isVault(parsed)) { await fsp.unlink(file).catch(() => {}); removed++; continue; }
      let body;
      try { body = vaultCrypto.openWithDk(parsed, oldDk); }
      catch { await fsp.unlink(file).catch(() => {}); removed++; continue; }
      const moved = vaultCrypto.resealBody(newVault, newDk, body);
      await writeFileAtomicRaw(file, Buffer.from(JSON.stringify(moved, null, 2), 'utf8'));
    } catch {
      await fsp.unlink(file).catch(() => {}); removed++;
    }
  }
  return removed;
}

// Mints a brand new data key, moves the journal, the photos and the backups onto
// it, and wraps it under the new PIN and a fresh recovery code. This is what
// makes "change my PIN" true: afterwards the old PIN and the old recovery code
// open nothing that still exists.
async function rotateToNewKey(data, oldDk, newPin) {
  const { vault, recoveryCode, dk } = await vaultCrypto.createVault(data, newPin);
  const { prepared, failed } = await rekeyMediaPrepare(oldDk, dk);
  if (failed.length) {
    // Every original is still on the old key, so this really is a clean no-op.
    await mediaSidecarAbort(prepared);
    return {
      ok: false,
      error: `Nothing was changed, because ${failed.length} ${failed.length === 1 ? 'photo' : 'photos'} could not be re-locked just now (they may be open in another program). Your PIN is unchanged and every photo is exactly as it was. Please try again.`
    };
  }
  // Commit the vault FIRST: it holds the wraps for the new key, so from here the
  // new-key photos are readable. Doing it the other way round is what stranded
  // them.
  await writeMainAndBackup(JSON.stringify(vault, null, 2));
  const stuck = await mediaSidecarCommit(prepared);
  const removed = await rekeyBackups(oldDk, dk, vault);
  setSessionDk(dk);
  sessionVault = vault;
  encryptedOnDisk = encryptedEverThisSession = true;
  return { ok: true, recoveryCode, removedBackups: removed, stuckPhotos: stuck.length };
}

// Change the PIN. This rotates the data key, so a NEW recovery code is issued.
function changeEncryptionPin(currentPin, newPin) {
  return runExclusive(async () => {
    const s = await requireVaultState();
    if (s.state !== 'vault') return { ok: false, error: 'Your journal is not encrypted.' };
    if (typeof newPin !== 'string' || newPin.length < 4) {
      return { ok: false, error: 'Choose a new PIN of at least 4 characters.' };
    }
    let data, dk;
    try {
      ({ data, dk } = await vaultCrypto.openWithPin(s.vault, currentPin));
    } catch (err) {
      if (err && err.code === 'FLINT_DAMAGED') {
        return { ok: false, error: 'Your current PIN is correct, but the journal file is damaged, so the PIN was not changed.' };
      }
      return { ok: false, error: 'Your current PIN did not work.' };
    }
    return rotateToNewKey(data, dk, newPin);
  });
}

// Called after someone gets in with their recovery code. They do not know their
// PIN (that is why they used the code), so they must choose a new one, and that
// rotation is what genuinely retires BOTH the forgotten PIN and the spent code:
// afterwards neither opens anything that still exists. Returns a fresh code.
function resetSecretsAfterRecovery(newPin) {
  return runExclusive(async () => {
    const s = await requireVaultState();
    if (s.state !== 'vault') return { ok: false, error: 'Your journal is not encrypted.' };
    if (!sessionDk) return { ok: false, error: 'Unlock the journal first.' };
    if (typeof newPin !== 'string' || newPin.length < 4) {
      return { ok: false, error: 'Choose a PIN of at least 4 characters.' };
    }
    // Reading the body with the key we hold also proves the key and the file on
    // disk still belong together, so a fresh code can never be wrapped around a
    // key that does not open this journal.
    let data;
    try { data = vaultCrypto.openWithDk(s.vault, sessionDk); }
    catch { return { ok: false, error: 'Flint could not read your journal with the key it holds. Unlock again and try that once more.' }; }
    return rotateToNewKey(data, sessionDk, newPin);
  });
}

// Verify a PIN without unlocking or changing session state. Unwraps the key only
// and wipes it straight away: a yes/no check must never pull the whole journal
// into memory, least of all while the app is meant to be locked.
async function checkEncryptionPin(pin) {
  let s;
  try { s = await requireVaultState(); }
  catch (err) { return { ok: false, valid: false, error: err.message }; }
  if (s.state !== 'vault') return { ok: true, encrypted: false, valid: true };
  try {
    const dk = await vaultCrypto.unwrapWithPin(s.vault, String(pin));
    dk.fill(0);
    return { ok: true, encrypted: true, valid: true };
  } catch {
    return { ok: true, encrypted: true, valid: false };
  }
}

// ------------------------------------------------------------- start over
//
// Wipe everything Flint owns and return to a brand-new state: no entries, no
// backups, no photos, no settings, no PIN. Runs serialised with saves so it can
// never race a write. The caller reloads the window afterwards, which then runs
// first-time onboarding again. There is no undo, which is why the UI confirms
// twice before it ever gets here.
function resetAll() {
  return runExclusive(async () => {
    clearSessionDk();
    sessionVault = null;
    encryptedOnDisk = false;
    encryptedEverThisSession = false; // starting over from a blank install
    invalidateSettingsCache(); // settings.json is about to be deleted underneath the cache
    try {
      await fsp.rm(P.dataDir, { recursive: true, force: true });
    } catch (err) {
      return { ok: false, error: `Some files could not be removed (${err.code || err.message}). Close anything using your data folder and try again.` };
    }
    await fsp.mkdir(P.backupsDir, { recursive: true });
    return { ok: true };
  });
}

module.exports = {
  init, paths, emptyData, loadData, saveData, loadQuestions, saveQuestions, knownTitles, loadTemplates, saveTemplates, loadActivities, saveActivities, addMedia, getMedia, removeMedia, getTheme, setTheme, getCustomTheme, setCustomTheme, setThemePresets, getRunInBackground, setRunInBackground, getStartWithWindows, setStartWithWindows, getTrayAsked, setTrayAsked, getTrayNoticeShown, setTrayNoticeShown, getHardwareAcceleration, setHardwareAcceleration, readStartupFlagsSync, getOnboarded, setOnboarded, getStartedOn, getAutoLockMinutes, setAutoLockMinutes, getAutosaveSeconds, setAutosaveSeconds, getDaysOff, setDaysOff, getReminder, setReminder, getBackupSettings, setBackupSettings, setBackupFolder, runScheduledBackup, getGuided, setGuided, getUpdateChecks, setUpdateChecks, buildExportText, buildExportHtml, buildExportMarkdown, buildActivityReport, buildActivityReportHtml, mergeImported, pinIsSet, setPin, verifyPin, removePin,
  securityStatus, unlock, unlockWithRecovery, lock, enableEncryption, disableEncryption, changeEncryptionPin, resetSecretsAfterRecovery, checkEncryptionPin, resetAll,
  BACKUPS_TO_KEEP, DEFAULT_QUESTIONS
};
