// Data layer for Flint.
//
// Everything lives in plain files under one folder so the whole journal can
// be found, read, backed up and moved by hand:
//
//   <root>/data/entries.json     — every entry, keyed by date (YYYY-MM-DD)
//   <root>/data/backups/         — rolling timestamped copies, newest 30 kept
//   <root>/data/settings.json    — the optional PIN, the user's own prompts,
//                                  the last known prompt titles (so removed
//                                  prompts' answers can still be labelled), and
//                                  the light/dark theme choice. Entries are
//                                  never encrypted, so a lost PIN can never
//                                  lock the words away.
//
// Saves are atomic: write to a temp file, flush to disk, then rename over
// the real file. A crash mid-save leaves the previous file untouched.
//
// Within an entry, keys beginning with "__" and the key "updatedAt" are
// reserved by the app (day marker, tags, save time). Every other key holds the
// answer to a prompt. Answers whose prompt has since been removed are still
// kept, shown and exported — the app never drops a word the user wrote.

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const { DEFAULT_QUESTIONS, DAY_MARKERS } = require('./shared/questions');

const BACKUPS_TO_KEEP = 30;
const MAX_QUESTIONS = 40;
const MAX_TITLE = 200;
const MAX_HINT = 1000;

let P = null;

function init(rootDir) {
  P = {
    root: rootDir,
    dataDir: path.join(rootDir, 'data'),
    dataFile: path.join(rootDir, 'data', 'entries.json'),
    backupsDir: path.join(rootDir, 'data', 'backups'),
    settingsFile: path.join(rootDir, 'data', 'settings.json')
  };
  fs.mkdirSync(P.backupsDir, { recursive: true });
  return { ...P };
}

function paths() {
  return { ...P };
}

function emptyData() {
  return { version: 1, entries: {} };
}

function stamp(d = new Date()) {
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` +
    `-${p(d.getMilliseconds(), 3)}`
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

async function loadData() {
  let raw;
  try {
    raw = await fsp.readFile(P.dataFile, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { data: emptyData() };
    }
    throw new Error(
      `Your journal file could not be read (${err.code || err.message}). ` +
      `It is at: ${P.dataFile}`
    );
  }

  try {
    const parsed = JSON.parse(raw);
    if (!isValidData(parsed)) throw new Error('unexpected shape');
    return { data: parsed };
  } catch {
    // The file exists but cannot be read as journal data. Never overwrite
    // it — set it aside and fall back to the newest readable backup.
    const corruptPath = `${P.dataFile}.corrupt-${stamp()}`;
    let setAside = true;
    try {
      await fsp.rename(P.dataFile, corruptPath);
    } catch {
      // Rename can fail if something (antivirus, indexer) holds the file.
      // A copy still preserves the bytes even though the original stays put.
      try {
        await fsp.copyFile(P.dataFile, corruptPath);
      } catch {
        setAside = false;
      }
    }
    const keptNote = setAside
      ? `The unreadable file was kept, unchanged, at: ${corruptPath}`
      : `The unreadable file could not be copied aside (it may be locked ` +
        `by another program); it is still at ${P.dataFile} and will be ` +
        `replaced the next time you save.`;
    const backup = await newestValidBackup();
    if (backup) {
      return {
        data: backup.data,
        warning:
          `Your main journal file could not be read, so the most recent ` +
          `backup (${backup.name}) was loaded instead. Nothing you save ` +
          `from now on is affected. ${keptNote}`
      };
    }
    return {
      data: emptyData(),
      warning:
        `Your journal file could not be read and no backup was found, so ` +
        `Flint is starting empty. ${keptNote}`
    };
  }
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
      const raw = await fsp.readFile(path.join(P.backupsDir, name), 'utf8');
      const parsed = JSON.parse(raw);
      if (isValidData(parsed)) return { name, data: parsed };
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

function saveData(data) {
  const run = saveChain.then(() => doSaveData(data));
  saveChain = run.catch(() => {});
  return run;
}

async function doSaveData(data) {
  if (!isValidData(data)) {
    throw new Error('Flint was asked to save something that does not look like journal data. Nothing was written.');
  }
  const json = JSON.stringify(data, null, 2);
  JSON.parse(json); // sanity check: never write unparseable text

  try {
    await writeFileAtomic(P.dataFile, json);
  } catch (err) {
    throw new Error(
      `Your words could NOT be saved to disk (${err.code || err.message}). ` +
      `They are still in the app — please try saving again. ` +
      `File: ${P.dataFile}`
    );
  }

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
      key,
      title: q.title.trim().slice(0, MAX_TITLE),
      hint: (typeof q.hint === 'string' ? q.hint.trim() : '').slice(0, MAX_HINT)
    });
  }
  return cleaned.length ? cleaned : null;
}

// The prompts to actually show: the user's saved set, or the built-in default.
async function loadQuestions() {
  const s = await loadSettings();
  const saved = normaliseQuestions(s.questions);
  return saved || DEFAULT_QUESTIONS.map((q) => ({ ...q }));
}

// A key→title map used to label answers whose prompt has since been removed.
// The built-in defaults are always included, so their answers never fall back
// to a generic label even if the user has never explicitly saved a prompt set.
async function knownTitles() {
  const s = await loadSettings();
  const base = {};
  for (const q of DEFAULT_QUESTIONS) base[q.key] = q.title;
  const saved = s.knownTitles && typeof s.knownTitles === 'object' ? s.knownTitles : {};
  return { ...base, ...saved };
}

// Saves a new prompt set. Records the titles of both the outgoing prompts and
// the new ones in `knownTitles` (never removing old ones), so answers to a
// prompt the user deletes can still be labelled in the list and the export.
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
  s.knownTitles = titles;
  await saveSettings(s);
  return cleaned;
}

// -------------------------------------------------------------------- theme

async function getTheme() {
  const s = await loadSettings();
  return s.theme === 'dark' ? 'dark' : 'light';
}

async function setTheme(theme) {
  const s = await loadSettings();
  s.theme = theme === 'dark' ? 'dark' : 'light';
  await saveSettings(s);
  return s.theme;
}

// ------------------------------------------------------------- update opt

// Whether Flint quietly checks for a new version when it opens. Default on.
// This is the ONLY thing the app ever does online; turning it off returns the
// app to fully-offline behaviour. Flint content is never involved either way.
async function getUpdateChecks() {
  const s = await loadSettings();
  return s.updateChecks !== false;
}

async function setUpdateChecks(on) {
  const s = await loadSettings();
  s.updateChecks = Boolean(on);
  await saveSettings(s);
  return s.updateChecks;
}

// ----------------------------------------------------------------- export
//
// Shared shaping used by both the plain-text and the PDF/HTML exports, so the
// two never drift apart.

function longDate(d) {
  return d.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
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

function entryTags(entry) {
  return entry && Array.isArray(entry.__tags) ? entry.__tags.filter((t) => typeof t === 'string' && t.trim()) : [];
}

// The filled-in answers for one day, in prompt order, followed by any answers
// whose prompt has since been removed (labelled from knownTitles).
function orderedAnswers(entry, questions, titles) {
  const out = [];
  const qkeys = new Set(questions.map((q) => q.key));
  for (const q of questions) {
    const v = entry[q.key];
    if (typeof v === 'string' && v.trim()) out.push({ title: q.title, text: v.trim() });
  }
  for (const k of Object.keys(entry)) {
    if (isReservedKey(k) || qkeys.has(k)) continue;
    const v = entry[k];
    if (typeof v === 'string' && v.trim()) {
      out.push({ title: (titles && titles[k]) || 'Note', text: v.trim() });
    }
  }
  return out;
}

function entryHasContent(entry, questions, titles) {
  return (
    Boolean(dayMarkerLabel(entry)) ||
    entryTags(entry).length > 0 ||
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

  const lines = [];
  lines.push('Flint export');
  lines.push(
    `Created: ${longDate(now)}, ` +
    now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  );
  lines.push(`Days recorded: ${dates.length}`);
  lines.push('');

  for (const date of dates) {
    const entry = data.entries[date];
    const heading = longDateFromISO(date);
    const bar = '='.repeat(Math.max(heading.length, 20));
    lines.push(bar);
    lines.push(heading);
    lines.push(bar);
    const marker = dayMarkerLabel(entry);
    if (marker) lines.push(`Overall: ${marker}`);
    const tags = entryTags(entry);
    if (tags.length) lines.push(`Tags: ${tags.join(', ')}`);
    lines.push('');
    for (const sec of orderedAnswers(entry, questions, titles)) {
      lines.push(sec.title);
      lines.push('-'.repeat(sec.title.length));
      lines.push(sec.text);
      lines.push('');
    }
  }

  return lines.join('\r\n');
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

  const parts = [];
  parts.push('<!DOCTYPE html><html lang="en-GB"><head><meta charset="UTF-8"><style>');
  parts.push(`
    * { box-sizing: border-box; }
    body { font-family: Georgia, "Times New Roman", serif; color: #2c2822;
           line-height: 1.6; margin: 0; padding: 0; }
    .doc-head { margin: 0 0 1.5rem; }
    h1 { font-size: 22pt; margin: 0 0 0.2rem; }
    .meta { color: #5c5346; font-size: 11pt; margin: 0; }
    .day { margin: 0 0 1.4rem; page-break-inside: avoid; }
    h2 { font-size: 15pt; margin: 0 0 0.15rem; border-bottom: 2px solid #c9bda3;
         padding-bottom: 0.2rem; }
    .day-meta { color: #5c5346; font-size: 10.5pt; margin: 0.1rem 0 0.5rem; }
    h3 { font-size: 12pt; margin: 0.7rem 0 0.1rem; color: #4a4236; }
    p.answer { margin: 0.1rem 0 0; white-space: pre-wrap; font-size: 11.5pt; }
  `);
  parts.push('</style></head><body>');
  parts.push('<div class="doc-head">');
  parts.push('<h1>Flint</h1>');
  parts.push(
    `<p class="meta">Created ${escapeHtml(longDate(now))}, ` +
    `${escapeHtml(now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }))} · ` +
    `${dates.length} ${dates.length === 1 ? 'day' : 'days'} recorded</p>`
  );
  parts.push('</div>');

  for (const date of dates) {
    const entry = data.entries[date];
    parts.push('<section class="day">');
    parts.push(`<h2>${escapeHtml(longDateFromISO(date))}</h2>`);
    const bits = [];
    const marker = dayMarkerLabel(entry);
    if (marker) bits.push(escapeHtml(marker));
    const tags = entryTags(entry);
    if (tags.length) bits.push('Tags: ' + escapeHtml(tags.join(', ')));
    if (bits.length) parts.push(`<p class="day-meta">${bits.join(' &nbsp;·&nbsp; ')}</p>`);
    for (const sec of orderedAnswers(entry, questions, titles)) {
      parts.push(`<h3>${escapeHtml(sec.title)}</h3>`);
      parts.push(`<p class="answer">${escapeHtml(sec.text)}</p>`);
    }
    parts.push('</section>');
  }

  parts.push('</body></html>');
  return parts.join('');
}

// -------------------------------------------------------------------- PIN
//
// The PIN only gates the app window. Entries stay readable on disk, so a
// forgotten PIN is recovered by deleting settings.json — never by losing data.

async function loadSettings() {
  try {
    const raw = await fsp.readFile(P.settingsFile, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function saveSettings(settings) {
  await writeFileAtomic(P.settingsFile, JSON.stringify(settings, null, 2));
}

function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 64).toString('hex');
}

async function pinIsSet() {
  const s = await loadSettings();
  return Boolean(s.pin && s.pin.salt && s.pin.hash);
}

async function setPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const s = await loadSettings();
  s.pin = { salt, hash: hashPin(pin, salt) };
  await saveSettings(s);
}

async function verifyPin(pin) {
  const s = await loadSettings();
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

module.exports = {
  init,
  paths,
  emptyData,
  loadData,
  saveData,
  loadQuestions,
  saveQuestions,
  knownTitles,
  getTheme,
  setTheme,
  getUpdateChecks,
  setUpdateChecks,
  buildExportText,
  buildExportHtml,
  pinIsSet,
  setPin,
  verifyPin,
  removePin,
  BACKUPS_TO_KEEP,
  DEFAULT_QUESTIONS
};
