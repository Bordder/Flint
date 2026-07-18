'use strict';

/* Flint renderer. All persistence goes through window.journal (preload IPC).
   The app is a two-pane note journal: a calendar navigator (left) and a
   free-form writing area (right), plus slide-in Settings and Privacy panels. */

const api = window.journal;

let questions = (window.DEFAULT_QUESTIONS || []).map((q) => ({ ...q }));
let knownTitles = {};
const MARKERS = window.DAY_MARKERS || [
  { key: 'good', label: 'Good day', short: 'Good' }, { key: 'mixed', label: 'Mixed day', short: 'Mixed' }, { key: 'hard', label: 'Bad day', short: 'Bad' }
];
const MAX_TAGS = 20;
const MAX_TAG_LEN = 40;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

let data = { version: 1, entries: {} };
let paths = null;
let currentDate = todayISO();
let currentDay = '';
let currentTags = [];
let guided = false;                 // show the optional guided prompts
let snapshot = { note: '', answers: {}, day: '', tags: [] };
let loadFailed = false;
let saving = false;
let appReady = false;               // true once the editor is loaded (gate/onboarding done)
let calYear, calMonth;              // month currently shown in the calendar

const $ = (id) => document.getElementById(id);

async function safeCall(fn, ...args) {
  try { return await fn(...args); }
  catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
}

/* helpers */

function todayISO() {
  const d = new Date();
  return ymd(d);
}
function ymd(d) {
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}
function longDate(iso) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
function mediumDate(iso) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}
function isReservedKey(k) { return k === 'updatedAt' || k.startsWith('__'); }
function entryTags(entry) {
  return entry && Array.isArray(entry.__tags) ? entry.__tags.filter((t) => typeof t === 'string' && t.trim()) : [];
}
function entryNote(entry) { return entry && typeof entry.note === 'string' ? entry.note : ''; }
function dayMarker(key) { return MARKERS.find((m) => m.key === key) || null; }
function entryMedia(entry) {
  return entry && Array.isArray(entry.__media) ? entry.__media.filter((m) => m && typeof m.id === 'string') : [];
}

// The searchable / previewable text of an entry: note + prompt answers.
function entryTexts(entry) {
  const out = [];
  if (entryNote(entry).trim()) out.push(entryNote(entry).trim());
  for (const k of Object.keys(entry)) {
    if (k === 'note' || isReservedKey(k)) continue;
    if (typeof entry[k] === 'string' && entry[k].trim()) out.push(entry[k].trim());
  }
  return out;
}
function entryHasAnyContent(entry) {
  if (!entry) return false;
  if (entry.__day) return true;
  if (entryTags(entry).length) return true;
  if (entryMedia(entry).length) return true;
  return entryTexts(entry).length > 0;
}

/* modal */

function modalIsOpen() { return $('modal-root').childElementCount > 0; }

function showModal({ title, body, buttons, focusValue }) {
  return new Promise((resolve) => {
    const root = $('modal-root');
    const previouslyFocused = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'modal-title');
    const h = document.createElement('h2'); h.id = 'modal-title'; h.textContent = title;
    const b = document.createElement('p'); b.className = 'modal-body'; b.id = 'modal-body'; b.textContent = body;
    modal.setAttribute('aria-describedby', 'modal-body');
    const row = document.createElement('div'); row.className = 'btn-row';
    modal.append(h, b, row); overlay.append(modal); root.append(overlay);
    function close(value) {
      root.removeChild(overlay);
      document.removeEventListener('keydown', onKey, true);
      if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
      resolve(value);
    }
    const btnEls = buttons.map((spec) => {
      const btn = document.createElement('button');
      btn.textContent = spec.label; if (spec.kind) btn.className = spec.kind;
      btn.addEventListener('click', () => close(spec.value)); row.append(btn); return btn;
    });
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(buttons[buttons.length - 1].value); }
      else if (e.key === 'Tab') {
        const idx = btnEls.indexOf(document.activeElement);
        if (idx === -1) { e.preventDefault(); btnEls[e.shiftKey ? btnEls.length - 1 : 0].focus(); }
        else if (e.shiftKey && idx === 0) { e.preventDefault(); btnEls[btnEls.length - 1].focus(); }
        else if (!e.shiftKey && idx === btnEls.length - 1) { e.preventDefault(); btnEls[0].focus(); }
      }
    }
    document.addEventListener('keydown', onKey, true);
    const initial = buttons.findIndex((s) => s.value === focusValue);
    btnEls[initial === -1 ? 0 : initial].focus();
  });
}

// A modal that asks for a secret (the PIN) and resolves to the typed value, or
// null if cancelled. Kept separate from showModal, which is text-and-buttons only.
function promptSecret({ title, body, placeholder = '' }) {
  return new Promise((resolve) => {
    const root = $('modal-root');
    const previouslyFocused = document.activeElement;
    const overlay = document.createElement('div'); overlay.className = 'modal-overlay';
    const modal = document.createElement('div'); modal.className = 'modal'; modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
    const h = document.createElement('h2'); h.textContent = title;
    const b = document.createElement('p'); b.className = 'modal-body'; b.textContent = body;
    const input = document.createElement('input'); input.type = 'password'; input.autocomplete = 'off'; input.className = 'modal-input'; input.placeholder = placeholder; input.maxLength = 64;
    const row = document.createElement('div'); row.className = 'btn-row';
    modal.append(h, b, input, row); overlay.append(modal); root.append(overlay);
    function close(val) { root.removeChild(overlay); document.removeEventListener('keydown', onKey, true); if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus(); resolve(val); }
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel'; cancel.addEventListener('click', () => close(null));
    const ok = document.createElement('button'); ok.type = 'button'; ok.className = 'primary'; ok.textContent = 'Continue'; ok.addEventListener('click', () => close(input.value));
    row.append(cancel, ok);
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
      else if (e.key === 'Enter') { e.preventDefault(); close(input.value); }
    }
    document.addEventListener('keydown', onKey, true);
    input.focus();
  });
}

// A modal for capturing a few lines of writing. Resolves to the text, or null
// if cancelled. Ctrl+Enter saves, so a thought can be caught without reaching
// for the mouse.
function promptCapture() {
  return new Promise((resolve) => {
    const root = $('modal-root');
    const previouslyFocused = document.activeElement;
    const overlay = document.createElement('div'); overlay.className = 'modal-overlay';
    const modal = document.createElement('div'); modal.className = 'modal'; modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
    const h = document.createElement('h2'); h.textContent = 'Quick note into today';
    const b = document.createElement('p'); b.className = 'modal-body';
    b.textContent = 'This is added to the end of today, with the time in front of it. Ctrl and Enter saves.';
    const ta = document.createElement('textarea'); ta.className = 'modal-capture'; ta.rows = 4;
    ta.setAttribute('aria-label', 'What is on your mind');
    const row = document.createElement('div'); row.className = 'btn-row';
    modal.append(h, b, ta, row); overlay.append(modal); root.append(overlay);
    function close(val) {
      root.removeChild(overlay);
      document.removeEventListener('keydown', onKey, true);
      if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
      resolve(val);
    }
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => close(null));
    const ok = document.createElement('button'); ok.type = 'button'; ok.className = 'primary'; ok.textContent = 'Add to today';
    ok.addEventListener('click', () => close(ta.value));
    row.append(cancel, ok);
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); close(ta.value); }
    }
    document.addEventListener('keydown', onKey, true);
    ta.focus();
  });
}

// The feedback composer: a note plus an optional name. Resolves to { text, name }
// or null if cancelled. The note is sent nowhere from here; the caller decides.
function promptFeedback() {
  return new Promise((resolve) => {
    const root = $('modal-root');
    const previouslyFocused = document.activeElement;
    const overlay = document.createElement('div'); overlay.className = 'modal-overlay';
    const modal = document.createElement('div'); modal.className = 'modal'; modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
    const h = document.createElement('h2'); h.textContent = 'Share feedback';
    const b = document.createElement('p'); b.className = 'modal-body';
    b.textContent = 'What is working, what is not, or an idea. This sends your note privately to the app\'s maker over the internet. Nothing from your journal is included.';
    const ta = document.createElement('textarea'); ta.className = 'modal-capture'; ta.rows = 5; ta.placeholder = 'Your feedback…'; ta.setAttribute('aria-label', 'Your feedback');
    const field = document.createElement('div'); field.className = 'field';
    const nameLabel = document.createElement('label'); nameLabel.setAttribute('for', 'feedback-name'); nameLabel.textContent = 'Name to sign it with (optional)';
    const nameInput = document.createElement('input'); nameInput.type = 'text'; nameInput.id = 'feedback-name'; nameInput.autocomplete = 'off'; nameInput.maxLength = 60; nameInput.placeholder = 'Left blank, a random name is used';
    field.append(nameLabel, nameInput);
    const row = document.createElement('div'); row.className = 'btn-row';
    modal.append(h, b, ta, field, row); overlay.append(modal); root.append(overlay);
    function close(val) { root.removeChild(overlay); document.removeEventListener('keydown', onKey, true); if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus(); resolve(val); }
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel'; cancel.addEventListener('click', () => close(null));
    const send = document.createElement('button'); send.type = 'button'; send.className = 'primary'; send.textContent = 'Send'; send.addEventListener('click', () => close({ text: ta.value, name: nameInput.value }));
    row.append(cancel, send);
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(null); } }
    document.addEventListener('keydown', onKey, true);
    ta.focus();
  });
}

// A simple progress modal with an indeterminate bar, shown while a slower task
// (like building and writing an export) runs. Returns a handle with close().
function showProgressModal(title) {
  const root = $('modal-root');
  const overlay = document.createElement('div'); overlay.className = 'modal-overlay';
  const modal = document.createElement('div'); modal.className = 'modal'; modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
  const h = document.createElement('h2'); h.textContent = title;
  const bar = document.createElement('div'); bar.className = 'progress-bar'; const fill = document.createElement('div'); fill.className = 'progress-fill'; bar.append(fill);
  modal.append(h, bar); overlay.append(modal); root.append(overlay);
  return { close() { if (overlay.parentNode) root.removeChild(overlay); } };
}

/* status */

let statusTimer = null;
function setStatus(msg, { error = false, sticky = false } = {}) {
  const el = $('status'); el.textContent = msg; el.classList.toggle('error', error);
  clearTimeout(statusTimer);
  if (msg && !sticky && !error) statusTimer = setTimeout(() => { el.textContent = ''; }, 6000);
}

/* editor */

function buildPromptSections() {
  const holder = $('sections');
  holder.textContent = '';
  for (const q of questions) {
    const wrap = document.createElement('div'); wrap.className = 'q-section';
    const label = document.createElement('label'); label.setAttribute('for', `box-${q.key}`); label.textContent = q.title;
    const hint = document.createElement('p'); hint.className = 'q-hint'; hint.id = `hint-${q.key}`; hint.textContent = q.hint || '';
    if (!q.hint) hint.hidden = true;
    const ta = document.createElement('textarea'); ta.id = `box-${q.key}`; ta.rows = 2;
    if (q.hint) ta.setAttribute('aria-describedby', `hint-${q.key}`);
    ta.addEventListener('input', () => autosize(ta));
    wrap.append(label, hint, ta); holder.append(wrap);
  }
}

function buildDayMarker() {
  const holder = $('day-marker'); holder.textContent = '';
  for (const m of MARKERS) {
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'marker-btn';
    btn.dataset.key = m.key; btn.textContent = m.short; btn.setAttribute('aria-pressed', 'false');
    btn.addEventListener('click', () => { currentDay = currentDay === m.key ? '' : m.key; renderDayMarker(); updateEmptyHelpers(); });
    holder.append(btn);
  }
}
function renderDayMarker() {
  for (const btn of $('day-marker').querySelectorAll('.marker-btn')) {
    const on = btn.dataset.key === currentDay;
    btn.classList.toggle('is-on', on); btn.setAttribute('aria-pressed', String(on));
  }
}
function renderTags() {
  const list = $('tag-list'); list.textContent = '';
  currentTags.forEach((tag, i) => {
    const chip = document.createElement('span'); chip.className = 'tag-chip';
    const text = document.createElement('span'); text.textContent = tag;
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'tag-remove';
    remove.setAttribute('aria-label', `Remove tag ${tag}`); remove.textContent = '×';
    remove.addEventListener('click', () => { currentTags.splice(i, 1); renderTags(); $('tag-input').focus(); });
    chip.append(text, remove); list.append(chip);
  });
}
function addTagFromInput() {
  const input = $('tag-input'); const raw = input.value.trim().replace(/\s+/g, ' '); input.value = '';
  if (!raw) return;
  for (const part of raw.split(',')) {
    const tag = part.trim().slice(0, MAX_TAG_LEN);
    if (!tag || currentTags.length >= MAX_TAGS) continue;
    if (currentTags.some((t) => t.toLowerCase() === tag.toLowerCase())) continue;
    currentTags.push(tag);
  }
  renderTags();
}

function autosize(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight + 2, 600) + 'px'; }

function noteValue() { return $('note').value; }
function collectAnswers() {
  const v = {};
  if (guided) for (const q of questions) { const el = $(`box-${q.key}`); if (el) v[q.key] = el.value; }
  return v;
}
function currentState() { return { note: noteValue(), answers: collectAnswers(), day: currentDay, tags: currentTags.slice() }; }

function isDirty() {
  if (!appReady) return false; // during the gate / onboarding there is nothing to save
  const s = currentState();
  if (s.note !== snapshot.note) return true;
  if (s.day !== snapshot.day) return true;
  if (s.tags.join('\n') !== snapshot.tags.join('\n')) return true;
  const keys = new Set([...Object.keys(s.answers), ...Object.keys(snapshot.answers)]);
  for (const k of keys) if ((s.answers[k] || '') !== (snapshot.answers[k] || '')) return true;
  return false;
}

// Build the entry to store, preserving prompt answers even when the guided
// prompts aren't currently shown (so switching modes never drops writing).
function buildEntry(prev) {
  const entry = {};
  const qkeys = new Set(questions.map((q) => q.key));
  if (prev) for (const k of Object.keys(prev)) {
    if (k === 'note' || isReservedKey(k) || qkeys.has(k)) continue;
    if (typeof prev[k] === 'string' && prev[k].trim()) entry[k] = prev[k]; // orphaned answer
  }
  if (guided) {
    for (const q of questions) { const el = $(`box-${q.key}`); const v = el ? el.value : ''; if (v.trim()) entry[q.key] = v; }
  } else if (prev) {
    for (const q of questions) { const v = prev[q.key]; if (typeof v === 'string' && v.trim()) entry[q.key] = v; }
  }
  const note = noteValue(); if (note.trim()) entry.note = note;
  if (currentDay) entry.__day = currentDay;
  if (currentTags.length) entry.__tags = currentTags.slice();
  // Photos can no longer be added, but any attached by an older version are kept
  // as they were rather than dropped on the next save.
  if (prev && Array.isArray(prev.__media) && prev.__media.length) entry.__media = prev.__media.map((m) => ({ ...m }));
  return entry;
}
function entryHasAny(entry) {
  if (entry.__day) return true;
  if (Array.isArray(entry.__tags) && entry.__tags.length) return true;
  if (Array.isArray(entry.__media) && entry.__media.length) return true;
  for (const k of Object.keys(entry)) { if (isReservedKey(k)) continue; if (typeof entry[k] === 'string' && entry[k].trim()) return true; }
  return false;
}

function loadEditor(dateIso) {
  currentDate = dateIso;
  promptOffset = 0;
  const entry = data.entries[dateIso] || {};
  $('note').value = entryNote(entry);
  autosize($('note'));
  currentDay = typeof entry.__day === 'string' ? entry.__day : '';
  currentTags = entryTags(entry).slice();
  $('tag-input').value = '';
  renderDayMarker(); renderTags();
  if (guided) { buildPromptSections(); for (const q of questions) { const el = $(`box-${q.key}`); if (el) { el.value = typeof entry[q.key] === 'string' ? entry[q.key] : ''; autosize(el); } } }
  snapshot = currentState();
  // keep the calendar showing the month of the day being edited
  const d = new Date(dateIso + 'T00:00:00'); calYear = d.getFullYear(); calMonth = d.getMonth();
  renderWriterHead();
  renderLookback();
  updateEmptyHelpers();
  if (previewOn) renderMarkdownInto($('note-preview'), noteValue());
}

function renderWriterHead() {
  const isToday = currentDate === todayISO();
  $('writer-date').textContent = isToday ? 'Today' : longDate(currentDate);
  const entry = data.entries[currentDate];
  let sub = isToday ? longDate(currentDate) : '';
  if (entry && entry.updatedAt) {
    const d = new Date(entry.updatedAt);
    if (!isNaN(d)) sub = `saved ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
  } else if (!isToday) { sub = 'not written yet'; }
  $('editor-sub').textContent = sub;
  $('delete-btn').hidden = !(entry && entryHasAnyContent(entry));
}

/* empty-day helpers: the low-bar floor line and the optional prompt nudge */

let startedOn = '';                 // first-run day, for the gentle starter week
let promptOffset = 0;               // advances the offered prompt (the "Another" button)
const dismissedNudges = new Set();  // days the nudge was waved off this session

function daysBetween(aIso, bIso) {
  const a = new Date(aIso + 'T00:00:00'), b = new Date(bIso + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}
// The Monday that starts a date's week, so "a new week" means crossing it.
function mondayOf(iso) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return ymd(d);
}
function inStarterWeek() {
  if (!startedOn) return false;
  const since = daysBetween(startedOn, todayISO());
  return since >= 0 && since < 7;
}
function noteIsEmpty() { return !noteValue().trim(); }

function updateEmptyHelpers() {
  const empty = noteIsEmpty();
  renderWriterHint(empty);
  renderPromptNudge(empty);
}

// One faint line when the page is blank: the whole point is that a single line
// is a complete day, and the writer's own plan is there if they set one.
function renderWriterHint(empty) {
  const el = $('writer-hint'); if (!el) return;
  if (!appReady || !empty) { el.hidden = true; el.textContent = ''; return; }
  const isToday = currentDate === todayISO();
  el.textContent = isToday && inStarterWeek()
    ? 'You are just settling in. Even one line counts as a day.'
    : 'Even one line counts as a day.';
  el.hidden = false;
}

function nudgePrompt() {
  if (!window.promptForDay) return null;
  // On a day the writer marked Hard, lean away from the cheery prompts.
  const avoid = currentDay === 'hard' ? ['gratitude', 'savor', 'forward'] : [];
  return window.promptForDay(currentDate, promptOffset, avoid);
}

// A calm inspiration card, only for a blank day, always cyclable and dismissible.
function renderPromptNudge(empty) {
  const box = $('prompt-nudge'); if (!box) return;
  if (!appReady || !empty || dismissedNudges.has(currentDate)) { box.hidden = true; box.textContent = ''; return; }
  const p = nudgePrompt();
  if (!p) { box.hidden = true; box.textContent = ''; return; }
  box.textContent = '';
  const lead = document.createElement('span'); lead.className = 'nudge-lead'; lead.textContent = 'Need a nudge?';
  const text = document.createElement('p'); text.className = 'nudge-text'; text.textContent = p.text;
  const row = document.createElement('div'); row.className = 'nudge-actions';
  const use = document.createElement('button'); use.type = 'button'; use.className = 'ghost small'; use.textContent = 'Use this';
  use.addEventListener('click', () => useNudgePrompt(p.text));
  const another = document.createElement('button'); another.type = 'button'; another.className = 'linklike'; another.textContent = 'Another';
  another.addEventListener('click', () => { promptOffset++; renderPromptNudge(noteIsEmpty()); });
  const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.className = 'linklike nudge-dismiss'; dismiss.textContent = 'Not now';
  dismiss.addEventListener('click', () => { dismissedNudges.add(currentDate); renderPromptNudge(false); });
  row.append(use, another, dismiss);
  box.append(lead, text, row);
  box.hidden = false;
}

function useNudgePrompt(text) {
  insertTemplate(`**${text}**\n\n`);
  if (previewOn) renderMarkdownInto($('note-preview'), noteValue());
  updateEmptyHelpers();
}

/* welcome-back / fresh-start greeting */

let greetingShown = false;

// A single, soft, dismissible line: warm if it has been a while, or a clean-page
// note on a new week. Never counts what was missed, never fires if today is
// already written or there is no history yet. Shown at most once per launch.
function maybeShowGreeting() {
  if (greetingShown || !appReady) return;
  const box = $('greeting'); if (!box) return;
  const today = todayISO();
  if (entryHasAnyContent(data.entries[today])) return;
  const written = Object.keys(data.entries).filter((d) => d < today && entryHasAnyContent(data.entries[d])).sort();
  if (!written.length) return;
  const last = written[written.length - 1];
  let msg = '';
  if (daysBetween(last, today) >= 4) {
    msg = 'Welcome back. It has been a little while, and that is completely fine. Your page is here whenever you are.';
  } else if (mondayOf(last) !== mondayOf(today)) {
    msg = 'A new week, and a clean page whenever you want it.';
  }
  if (!msg) return;
  greetingShown = true;
  box.textContent = '';
  const p = document.createElement('p'); p.className = 'greeting-text'; p.textContent = msg;
  const close = document.createElement('button'); close.type = 'button'; close.className = 'greeting-close';
  close.setAttribute('aria-label', 'Dismiss'); close.textContent = '×';
  close.addEventListener('click', () => { box.hidden = true; box.textContent = ''; });
  box.append(p, close);
  box.hidden = false;
}

async function saveCurrent() {
  if (saving) return false;
  if (loadFailed) {
    await showModal({
      title: 'Saving is switched off for now', body: 'Your journal file could not be opened when the app started, so saving is blocked to protect the entries already on disk.\n\nEverything you typed is still on the page. Use "Try loading again" in the notice at the top.', buttons: [{ label: 'Back to my writing', value: 'ok', kind: 'primary' }]
    });
    return false;
  }
  saving = true; $('save-btn').disabled = true;
  try {
    const existed = Object.prototype.hasOwnProperty.call(data.entries, currentDate);
    const previous = existed ? data.entries[currentDate] : undefined;
    const wasWrittenBefore = entryHasAnyContent(previous);
    const entry = buildEntry(previous);
    const hasContent = entryHasAny(entry);
    if (!hasContent && !existed) { setStatus('Nothing written for this day yet.'); return true; }
    if (hasContent) { entry.updatedAt = new Date().toISOString(); data.entries[currentDate] = entry; }
    else delete data.entries[currentDate];
    const res = await safeCall(api.save, data);
    if (res.ok) {
      snapshot = currentState();
      // A quiet, warmer note the first time today crosses into "written", not on
      // every save. Understated on purpose: a nod, not a fanfare.
      const madeTodayWritten = hasContent && currentDate === todayISO() && !wasWrittenBefore;
      setStatus(hasContent ? (madeTodayWritten ? 'Saved. That is today done.' : 'Saved.') : 'This day has been removed.');
      if (res.backupWarning) showNotice(res.backupWarning);
      renderWriterHead(); renderCount(); renderCalendar(); updateEmptyHelpers();
      return true;
    }
    if (existed) data.entries[currentDate] = previous; else delete data.entries[currentDate];
    setStatus('Not saved, see the message.', { error: true, sticky: true });
    await showModal({
      title: 'Your words could not be saved', body: (res.error || 'Something went wrong writing to disk.') + '\n\nNothing has been lost. Everything you typed is still on the page, so please try saving again.', buttons: [{ label: 'Back to my writing', value: 'ok', kind: 'primary' }]
    });
    return false;
  } finally { saving = false; $('save-btn').disabled = false; }
}

/* quick capture */

// Catches a thought into today from wherever you happen to be. If today is the
// day on screen the text goes into the editor, so anything unsaved there is
// kept; otherwise it is appended to today's stored entry and the day you were
// editing is left completely alone.
async function quickCapture() {
  if (loadFailed) {
    await showModal({
      title: 'Saving is switched off for now', body: 'Your journal file could not be opened when the app started, so nothing new can be written until it opens properly.', buttons: [{ label: 'OK', value: 'ok', kind: 'primary' }]
    });
    return;
  }
  const text = await promptCapture();
  if (text === null || !text.trim()) return;

  const today = todayISO();
  const stamp = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const block = `**${stamp}**\n${text.trim()}`;

  if (currentDate === today) {
    const ta = $('note');
    ta.value = ta.value.trim() ? `${ta.value.replace(/\s+$/, '')}\n\n${block}` : block;
    autosize(ta);
    if (previewOn) renderMarkdownInto($('note-preview'), noteValue());
    if (await saveCurrent()) setStatus('Added to today.');
    return;
  }

  const previous = data.entries[today];
  const entry = { ...(previous || {}) };
  const prevNote = typeof entry.note === 'string' ? entry.note : '';
  entry.note = prevNote.trim() ? `${prevNote.replace(/\s+$/, '')}\n\n${block}` : block;
  entry.updatedAt = new Date().toISOString();
  data.entries[today] = entry;
  const res = await safeCall(api.save, data);
  if (!res.ok) {
    if (previous) data.entries[today] = previous; else delete data.entries[today];
    await showModal({
      title: 'That note could not be saved', body: (res.error || 'Something went wrong writing to disk.') + '\n\nNothing was changed.', buttons: [{ label: 'OK', value: 'ok', kind: 'primary' }]
    });
    return;
  }
  renderCount(); renderCalendar(); renderLookback();
  setStatus('Added to today.');
}

async function guardDirty(actionLabel) {
  if (!isDirty()) return true;
  const label = currentDate === todayISO() ? 'today' : longDate(currentDate);
  const choice = await showModal({
    title: 'You have unsaved words', body: `Save ${label} before ${actionLabel}?`, buttons: [
      { label: 'Save first', value: 'save', kind: 'primary' }, { label: "Don't save", value: 'discard' }, { label: 'Stay here', value: 'stay' }
    ]
  });
  if (choice === 'save') return await saveCurrent();
  return choice === 'discard';
}

async function deleteDay(date) {
  if (loadFailed) { await saveCurrent(); return; }
  const alsoLosesUnsaved = date === currentDate && isDirty();
  const choice = await showModal({
    title: `Delete ${longDate(date)}?`, body: "This removes that day's writing from your journal. A backup copy from before this change stays in your backups folder." +
      (alsoLosesUnsaved ? '\n\nThis day is open with unsaved words, deleting discards those too, and they are in no backup.' : ''), buttons: [
      { label: 'Delete this day', value: 'delete', kind: 'danger' }, { label: 'Keep it', value: 'keep', kind: 'primary' }
    ], focusValue: 'keep'
  });
  if (choice !== 'delete') return;
  const previous = data.entries[date]; delete data.entries[date];
  const res = await safeCall(api.save, data);
  if (!res.ok) {
    data.entries[date] = previous;
    await showModal({ title: 'That day could not be removed', body: (res.error || 'Something went wrong writing to disk.') + '\n\nNothing was changed.', buttons: [{ label: 'OK', value: 'ok', kind: 'primary' }] });
    return;
  }
  if (date === currentDate) loadEditor(currentDate);
  renderCount(); renderCalendar(); renderWriterHead();
  setStatus(`${longDate(date)} removed.`);
}

/* guided prompts toggle */

async function setGuidedMode(on, persist = true) {
  guided = on;
  $('guided-toggle').checked = on;
  const gb = $('guided-btn'); gb.setAttribute('aria-pressed', String(on)); gb.classList.toggle('is-on', on);
  $('prompts-wrap').hidden = !on;
  if (on) {
    buildPromptSections();
    const entry = data.entries[currentDate] || {};
    for (const q of questions) { const el = $(`box-${q.key}`); if (el) { el.value = typeof entry[q.key] === 'string' ? entry[q.key] : ''; autosize(el); } }
  }
  snapshot = currentState();
  if (persist) await safeCall(api.setGuided, on);
}

/* calendar */

function renderCount() {
  renderStreak();
}

// Streak milestones. The flame changes colour as the run grows, hotter (orange
// to blue) at each tier, covering a full month before the top tier.
const STREAK_TIERS = [
  { min: 1, name: 'Spark', color: 'oklch(70% 0.19 47)' },
  { min: 3, name: 'Kindling', color: 'oklch(78% 0.16 72)' },
  { min: 7, name: 'Steady flame', color: 'oklch(83% 0.15 95)' },
  { min: 14, name: 'Roaring fire', color: 'oklch(66% 0.2 30)' },
  { min: 21, name: 'Blue flame', color: 'oklch(72% 0.14 235)' },
  { min: 30, name: 'Everburning', color: 'oklch(60% 0.19 272)' }
];
function currentTier(count) {
  let t = null;
  for (const tier of STREAK_TIERS) if (count >= tier.min) t = tier;
  return t;
}
function nextTier(count) {
  return STREAK_TIERS.find((tier) => tier.min > count) || null;
}

// Consecutive days with any writing, counting back from today. The flame is
// "lit" only when today itself has something, a gentle nudge to write daily.
// A chosen day off is stepped over: it neither counts nor breaks the run.
function computeStreak() {
  const todayDone = entryHasAnyContent(data.entries[todayISO()]);
  const todayOff = daysOff.includes(new Date(todayISO() + 'T00:00:00').getDay());
  const d = new Date(todayISO() + 'T00:00:00');
  if (!todayDone) d.setDate(d.getDate() - 1); // yesterday's run still counts until midnight
  let count = 0;
  for (let guard = 0; guard < 3650; guard++) {
    if (entryHasAnyContent(data.entries[ymd(d)])) count++;
    else if (!daysOff.includes(d.getDay())) break;
    d.setDate(d.getDate() - 1);
  }
  return { count, todayDone, todayOff };
}
function renderStreak() {
  const el = $('streak'); if (!el) return;
  const { count, todayDone, todayOff } = computeStreak();
  const tier = currentTier(count);
  el.classList.toggle('is-lit', (todayDone || todayOff) && count > 0);
  el.style.setProperty('--flame', tier ? tier.color : 'var(--ink-3)');
  $('streak-count').textContent = count > 0 ? String(count) : '';
  const label = count === 0
    ? 'No streak yet. Write today to start one.'
    : `${count}-day streak, ${todayDone ? 'written today' : todayOff ? 'today is a day off' : 'not written today yet'}. Open for details.`;
  el.setAttribute('aria-label', label);
  el.setAttribute('title', label);
  if (!$('streak-pop').hidden) renderStreakPop();
}

/* days off */

let daysOff = [];

function renderDaysOff() {
  const box = $('days-off'); if (!box) return;
  box.textContent = '';
  const order = [1, 2, 3, 4, 5, 6, 0]; // Monday first, matching the calendar
  order.forEach((dow, i) => {
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'day-off-btn';
    btn.textContent = WEEKDAYS[i];
    const on = daysOff.includes(dow);
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.addEventListener('click', async () => {
      const next = daysOff.includes(dow) ? daysOff.filter((x) => x !== dow) : [...daysOff, dow];
      const res = await safeCall(api.setDaysOff, next);
      if (res.ok) { daysOff = res.days; renderDaysOff(); renderStreak(); }
    });
    box.append(btn);
  });
}

/* streak details popover */

function toggleStreakPop() {
  const pop = $('streak-pop');
  if (!pop.hidden) { closeStreakPop(); return; }
  renderStreakPop();
  pop.hidden = false;
  $('streak').setAttribute('aria-expanded', 'true');
  document.addEventListener('keydown', streakPopKey, true);
  document.addEventListener('click', streakPopOutside, true);
}
function closeStreakPop() {
  const pop = $('streak-pop'); if (pop.hidden) return;
  pop.hidden = true;
  $('streak').setAttribute('aria-expanded', 'false');
  document.removeEventListener('keydown', streakPopKey, true);
  document.removeEventListener('click', streakPopOutside, true);
}
function streakPopKey(e) { if (e.key === 'Escape') { e.preventDefault(); closeStreakPop(); $('streak').focus(); } }
function streakPopOutside(e) { if (!$('streak-pop').contains(e.target) && !$('streak').contains(e.target)) closeStreakPop(); }

function renderStreakPop() {
  const pop = $('streak-pop'); pop.textContent = '';
  const { count, todayDone, todayOff } = computeStreak();
  const total = Object.keys(data.entries).filter((d) => entryHasAnyContent(data.entries[d])).length;
  const tier = currentTier(count);
  const next = nextTier(count);

  const head = document.createElement('div'); head.className = 'streak-pop-head';
  const flame = document.createElement('span');
  flame.className = 'streak-pop-flame' + ((todayDone || todayOff) && count ? ' is-lit' : '');
  flame.style.setProperty('--flame', tier ? tier.color : 'var(--ink-3)');
  flame.append($('streak').querySelector('.flame-icon').cloneNode(true));
  const headText = document.createElement('div');
  const title = document.createElement('p'); title.className = 'streak-pop-title';
  title.textContent = count === 0 ? 'No streak yet' : `${count}-day streak`;
  const tierName = document.createElement('p'); tierName.className = 'streak-pop-tier';
  tierName.textContent = tier ? tier.name : 'Write today to light the first flame';
  headText.append(title, tierName);
  head.append(flame, headText);
  pop.append(head);

  // Progress toward the next milestone.
  const from = tier ? tier.min : 0;
  const to = next ? next.min : (tier ? tier.min : 1);
  const pct = next ? Math.round(((count - from) / (to - from)) * 100) : 100;
  const bar = document.createElement('div'); bar.className = 'streak-bar';
  const fill = document.createElement('div'); fill.className = 'streak-bar-fill';
  fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
  if (tier) fill.style.background = tier.color;
  bar.append(fill);
  const prog = document.createElement('p'); prog.className = 'soft small';
  if (next) {
    const left = next.min - count;
    prog.textContent = `${left} more ${left === 1 ? 'day' : 'days'} to ${next.name}.`;
  } else {
    prog.textContent = 'You have reached the hottest flame. Keep it burning.';
  }
  pop.append(bar, prog);

  // Milestone ladder.
  const ladder = document.createElement('div'); ladder.className = 'streak-ladder';
  for (const t of STREAK_TIERS) {
    const item = document.createElement('div'); item.className = 'streak-ladder-item';
    if (count >= t.min) item.classList.add('reached');
    if (tier && t.min === tier.min) item.classList.add('current');
    const dot = document.createElement('span'); dot.className = 'streak-dot'; dot.style.background = t.color;
    const n = document.createElement('span'); n.className = 'streak-dot-n'; n.textContent = String(t.min);
    item.append(dot, n); item.title = t.name; ladder.append(item);
  }
  pop.append(ladder);

  const totalLine = document.createElement('p'); totalLine.className = 'soft small streak-total';
  totalLine.textContent = total === 0 ? 'No days written yet.' : `Written on ${total} ${total === 1 ? 'day' : 'days'} in total.`;
  pop.append(totalLine);

  if (todayOff && !todayDone) {
    const off = document.createElement('p'); off.className = 'soft small';
    off.textContent = 'Today is one of your days off, so your streak is safe.';
    pop.append(off);
  } else if (!todayDone) {
    const go = document.createElement('button'); go.type = 'button'; go.className = 'ghost small';
    go.textContent = 'Write today';
    go.addEventListener('click', () => { closeStreakPop(); selectDay(todayISO()); });
    pop.append(go);
  }
}

function renderCalendar() {
  const grid = $('cal-grid'); grid.textContent = '';
  const first = new Date(calYear, calMonth, 1);
  $('cal-label').textContent = first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const startDow = (first.getDay() + 6) % 7; // Monday-first
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const today = todayISO();
  for (let i = 0; i < startDow; i++) { const b = document.createElement('div'); b.className = 'cal-cell cal-blank'; grid.append(b); }
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = ymd(new Date(calYear, calMonth, d));
    const cell = document.createElement('button'); cell.type = 'button'; cell.className = 'cal-cell';
    cell.setAttribute('aria-label', longDate(iso));
    const num = document.createElement('span'); num.className = 'cal-num'; num.textContent = String(d); cell.append(num);
    if (iso === today) cell.classList.add('is-today');
    if (iso === currentDate) { cell.classList.add('is-selected'); cell.setAttribute('aria-current', 'date'); }
    if (iso > today) { cell.disabled = true; cell.classList.add('is-future'); }
    const entry = data.entries[iso];
    if (entryHasAnyContent(entry)) {
      cell.classList.add('has-entry');
      const dot = document.createElement('span');
      dot.className = 'cal-dot' + (entry.__day ? ' m-' + entry.__day : '');
      cell.append(dot);
    }
    cell.addEventListener('click', () => selectDay(iso));
    grid.append(cell);
  }
}

async function selectDay(iso) {
  if (iso === currentDate) { $('note').focus(); return; }
  if (!(await guardDirty('opening another day'))) return;
  loadEditor(iso); renderCalendar(); $('note').focus();
}
function gotoMonth(delta) {
  const d = new Date(calYear, calMonth + delta, 1);
  calYear = d.getFullYear(); calMonth = d.getMonth(); renderCalendar();
}

/* on this day */

// The same calendar date, earlier: previous years first, then earlier months.
// setFullYear/setMonth can roll over (29 Feb, 31st of a short month), so a date
// that did not land on the day we asked for is skipped rather than shown wrong.
function lookbackDates(iso) {
  const d = new Date(iso + 'T00:00:00');
  const out = [];
  for (let y = 1; y <= 10; y++) {
    const past = new Date(d); past.setFullYear(d.getFullYear() - y);
    if (past.getDate() === d.getDate()) out.push({ iso: ymd(past), label: y === 1 ? '1 year ago' : `${y} years ago` });
  }
  for (let m = 1; m <= 6; m++) {
    const past = new Date(d); past.setMonth(d.getMonth() - m);
    if (past.getDate() === d.getDate()) out.push({ iso: ymd(past), label: m === 1 ? '1 month ago' : `${m} months ago` });
  }
  return out.filter((x) => entryHasAnyContent(data.entries[x.iso]));
}

function renderLookback() {
  const box = $('lookback'); if (!box) return;
  if (!$('search-results').hidden) { box.hidden = true; return; } // search owns the pane
  const items = lookbackDates(currentDate).slice(0, 5);
  box.textContent = '';
  if (!items.length) { box.hidden = true; return; }
  box.hidden = false;
  const h = document.createElement('h2'); h.className = 'lookback-title'; h.textContent = 'On this day';
  box.append(h);
  for (const it of items) {
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'lookback-item';
    const when = document.createElement('div'); when.className = 'lookback-when'; when.textContent = it.label;
    const sn = document.createElement('div'); sn.className = 'lookback-snip'; sn.textContent = snippet(data.entries[it.iso], '');
    btn.append(when, sn);
    btn.addEventListener('click', async () => {
      if (!(await guardDirty('opening that day'))) return;
      loadEditor(it.iso); renderCalendar(); $('note').focus();
    });
    box.append(btn);
  }
}

/* search */

function entryMatches(entry, term) {
  if (entryTexts(entry).some((t) => t.toLowerCase().includes(term))) return true;
  return entryTags(entry).some((t) => t.toLowerCase().includes(term));
}
function snippet(entry, term, width = 120) {
  const text = entryTexts(entry).join(' · ');
  const at = text.toLowerCase().indexOf(term);
  if (at === -1) return text.slice(0, width) + (text.length > width ? '…' : '');
  const start = Math.max(0, at - 30);
  return (start ? '…' : '') + text.slice(start, start + width) + (start + width < text.length ? '…' : '');
}
function onSearch() {
  const term = $('search-input').value.trim().toLowerCase();
  if (!term) { $('search-results').hidden = true; $('calendar').hidden = false; renderLookback(); return; }
  $('calendar').hidden = true; $('search-results').hidden = false; $('lookback').hidden = true;
  const box = $('search-results'); box.textContent = '';
  const dates = Object.keys(data.entries).filter((d) => entryMatches(data.entries[d], term)).sort().reverse();
  const head = document.createElement('p'); head.className = 'soft small search-count';
  head.textContent = dates.length ? `${dates.length} ${dates.length === 1 ? 'day' : 'days'} match` : 'No days match.';
  box.append(head);
  for (const d of dates) {
    const item = document.createElement('button'); item.type = 'button'; item.className = 'search-item';
    const dd = document.createElement('div'); dd.className = 'search-item-date'; dd.textContent = mediumDate(d);
    const sn = document.createElement('div'); sn.className = 'search-item-snip'; sn.textContent = snippet(data.entries[d], term);
    item.append(dd, sn);
    item.addEventListener('click', async () => {
      if (!(await guardDirty('opening that day'))) return;
      loadEditor(d); $('search-input').value = ''; $('search-results').hidden = true; $('calendar').hidden = false;
      renderCalendar(); $('note').focus();
    });
    box.append(item);
  }
}

/* export */

function setExportStatus(msg, error = false) { const el = $('export-status'); el.textContent = msg; el.classList.toggle('error', error); }
async function ensureSavedForExport() {
  if (!isDirty()) return true;
  const choice = await showModal({
    title: 'Include what you just wrote?', body: 'You have unsaved words on the page. Save first so they are included?', buttons: [{ label: 'Save, then continue', value: 'save', kind: 'primary' }, { label: 'Continue without them', value: 'skip' }, { label: 'Cancel', value: 'cancel' }]
  });
  if (choice === 'save') return await saveCurrent();
  return choice === 'skip';
}
// Re-confirm the PIN before an export when the journal is encrypted. An export
// is a readable copy by design, so this is the checkpoint that guards it.
async function ensureExportAuth() {
  const st = await safeCall(api.securityStatus);
  if (!(st.ok && st.encrypted)) return true;
  const pin = await promptSecret({ title: 'Confirm your PIN to export', body: 'Your journal is encrypted. An export is a readable copy, so Flint checks your PIN before making one.', placeholder: 'PIN' });
  if (pin === null) return false;
  const chk = await safeCall(api.checkPin, pin);
  if (chk.ok && chk.valid) return true;
  await showModal({ title: 'That PIN did not match', body: 'Your export was cancelled, so nothing was written.', buttons: [{ label: 'OK', value: 'ok', kind: 'primary' }] });
  return false;
}

async function runExport(runner, done) {
  if (!(await ensureSavedForExport())) return;
  if (!(await ensureExportAuth())) return;
  setExportStatus('');
  const prog = showProgressModal('Preparing your export…');
  let res;
  try { res = await safeCall(runner); } finally { prog.close(); }
  done(res);
}
function exportToFile() {
  return runExport(api.exportToFile, (res) => {
    if (!res.ok) setExportStatus(`Could not write: ${res.error}`, true);
    else if (!res.canceled) setExportStatus(`Saved to ${res.path}`);
    else setExportStatus('');
  });
}
function exportToPdf() {
  return runExport(api.exportToPdf, (res) => {
    if (!res.ok) setExportStatus(`Could not write: ${res.error}`, true);
    else if (!res.canceled) setExportStatus(`Saved to ${res.path}`);
    else setExportStatus('');
  });
}
function exportToMarkdown() {
  return runExport(api.exportToMarkdown, (res) => {
    if (!res.ok) setExportStatus(`Could not write: ${res.error}`, true);
    else if (!res.canceled) setExportStatus(`Saved to ${res.path}`);
    else setExportStatus('');
  });
}
function exportToJson() {
  return runExport(api.exportToJson, (res) => {
    if (!res.ok) setExportStatus(`Could not write: ${res.error}`, true);
    else if (!res.canceled) setExportStatus(`Saved to ${res.path}`);
    else setExportStatus('');
  });
}
function copyAll() {
  return runExport(api.copyAll, (res) => {
    if (!res.ok) setExportStatus(`Could not copy: ${res.error}`, true);
    else setExportStatus(res.days === 1 ? 'Copied 1 day to the clipboard.' : `Copied ${res.days} days to the clipboard.`);
  });
}

// Importing adds days, so it needs no PIN: it never reveals anything.
async function importJson() {
  if (!(await guardDirty('importing a journal file'))) return;
  setExportStatus('');
  const prog = showProgressModal('Reading that journal file…');
  let res;
  try { res = await safeCall(api.importJson); } finally { prog.close(); }
  if (!res.ok) { setExportStatus(`Could not import: ${res.error}`, true); return; }
  if (res.canceled) return;
  if (res.added > 0) {
    const load = await safeCall(api.load);
    if (load.ok && !load.locked) { data = load.data || data; loadEditor(currentDate); renderCount(); renderCalendar(); }
  }
  const kept = res.skipped ? ` ${res.skipped} ${res.skipped === 1 ? 'day was' : 'days were'} already written, so ${res.skipped === 1 ? 'it was' : 'they were'} left alone.` : '';
  setExportStatus(res.added === 0 ? `Nothing new to add.${kept}` : `Added ${res.added} ${res.added === 1 ? 'day' : 'days'}.${kept}`);
}

/* notices */

function showNotice(msg) { const el = $('load-notice'); el.textContent = msg; el.hidden = false; }
function showLoadErrorNotice(errorMsg) {
  const el = $('load-notice'); el.textContent = '';
  const p = document.createElement('p'); p.style.margin = '0 0 0.6rem';
  p.textContent = `Your journal could not be opened: ${errorMsg} To protect the entries already on disk, saving is switched off until it opens properly. You can safely keep writing. Your words stay on the page.`;
  const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = 'Try loading again'; btn.addEventListener('click', retryLoad);
  el.append(p, btn); el.hidden = false;
}
async function retryLoad() {
  const res = await safeCall(api.load);
  if (!res.ok) { showLoadErrorNotice(res.error); return; }
  loadFailed = false; data = res.data; paths = res.paths;
  if (paths) $('data-path').textContent = paths.dataFile;
  $('load-notice').textContent = ''; $('load-notice').hidden = true;
  if (res.warning) showNotice(res.warning);
  if (!isDirty()) loadEditor(currentDate);
  renderCount(); renderCalendar(); renderWriterHead();
  setStatus('Your journal is open again. Saving is back on.');
}

/* theme (light / dark / system) */

const darkMedia = window.matchMedia('(prefers-color-scheme: dark)');
let themePref = 'light';

function resolveTheme(pref) {
  if (pref === 'system') return darkMedia.matches ? 'dark' : 'light';
  return pref === 'dark' ? 'dark' : 'light';
}
function applyTheme(pref) {
  themePref = pref === 'dark' || pref === 'system' ? pref : 'light';
  document.documentElement.dataset.theme = resolveTheme(themePref);
  syncThemeChoice();
}
function syncThemeChoice() {
  for (const btn of document.querySelectorAll('.theme-opt')) {
    const on = btn.dataset.themePref === themePref;
    btn.classList.toggle('is-selected', on);
    btn.setAttribute('aria-pressed', String(on));
  }
}
async function setThemePref(pref) { applyTheme(pref); await safeCall(api.setTheme, pref); }
function wireThemeChoice(container) {
  if (!container) return;
  for (const btn of container.querySelectorAll('.theme-opt')) {
    btn.addEventListener('click', () => setThemePref(btn.dataset.themePref));
  }
}
// The top-bar button flips between light and dark from whatever is showing now.
async function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  await setThemePref(next);
}
// If the preference is 'system', follow the OS the moment it flips light/dark.
darkMedia.addEventListener('change', () => { if (themePref === 'system') document.documentElement.dataset.theme = resolveTheme('system'); });

/* updates */

function updBanner() { return $('update-banner'); }
function hideUpdateBanner() { const el = updBanner(); el.textContent = ''; el.hidden = true; }
function showUpdateBanner(message, buttons) {
  const el = updBanner(); el.textContent = '';
  const p = document.createElement('p'); p.className = 'update-text'; p.textContent = message; el.append(p);
  if (buttons && buttons.length) {
    const row = document.createElement('div'); row.className = 'btn-row';
    for (const b of buttons) { const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = b.label; if (b.kind) btn.className = b.kind; btn.addEventListener('click', b.onClick); row.append(btn); }
    el.append(row);
  }
  el.hidden = false;
}
function setUpdateSettingStatus(msg) { $('update-setting-status').textContent = msg || ''; }
function handleUpdateStatus({ status, info, manual }) {
  const version = info && info.version ? ` (version ${info.version})` : '';
  switch (status) {
    case 'checking': if (manual) setUpdateSettingStatus('Checking…'); break;
    case 'available':
      if (manual) setUpdateSettingStatus('');
      showUpdateBanner(`A new version of Flint is available${version}.`, [
        { label: 'Download', kind: 'primary', onClick: () => { showUpdateBanner('Downloading update…'); api.updateDownload(); } }, { label: 'Not now', onClick: hideUpdateBanner }
      ]); break;
    case 'progress': showUpdateBanner(`Downloading update… ${info && info.percent != null ? info.percent + '%' : ''}`.trim()); break;
    case 'ready':
      showUpdateBanner(`Update${version} downloaded and ready.`, [
        { label: 'Install and restart', kind: 'primary', onClick: installUpdateFlow }, { label: 'Later', onClick: hideUpdateBanner }
      ]); break;
    case 'none': if (manual) setUpdateSettingStatus("You're on the latest version."); break;
    case 'error': if (manual) setUpdateSettingStatus("Couldn't check just now, are you online?"); break;
    case 'unsupported': if (manual) setUpdateSettingStatus('Updates apply to the installed app, not this test run.'); break;
  }
}
async function installUpdateFlow() { if (!(await guardDirty('installing the update'))) return; showUpdateBanner('Installing… Flint will restart.'); await safeCall(api.updateInstall); }

/* lock gate (unlock + decrypt, or legacy window PIN) */

let gateMode = null;       // 'encrypted' | 'window'
let gateResolve = null;
let gateDataDir = '';

function openLockGate(status) {
  return new Promise((resolve) => {
    gateResolve = resolve;
    gateMode = status && status.encrypted ? 'encrypted' : 'window';
    gateDataDir = (status && status.dataDir) || '';
    $('pin-form').hidden = false; $('pin-forgot').hidden = false; $('pin-sub').hidden = false;
    $('pin-sub').textContent = gateMode === 'encrypted'
      ? 'Enter your PIN to unlock and decrypt your journal.'
      : 'Enter your PIN to open your journal.';
    $('pin-input').value = '';
    $('pin-error').textContent = '';
    $('pin-recovery').hidden = true;
    $('pin-forgot').setAttribute('aria-expanded', 'false');
    buildRecoveryPanel();
    $('pin-gate').hidden = false;
    $('skip-link').hidden = true;
    $('pin-input').focus();
  });
}

function finishGate() {
  $('pin-gate').hidden = true;
  $('skip-link').hidden = false;
  const done = gateResolve; gateResolve = null;
  if (done) done();
}

async function onGateSubmit(e) {
  e.preventDefault();
  const input = $('pin-input');
  let ok = false; let error = '';
  if (gateMode === 'encrypted') {
    const res = await safeCall(api.unlock, input.value);
    ok = res.ok; error = res.error || 'That PIN did not work.';
  } else {
    const res = await safeCall(api.pinVerify, input.value);
    ok = res.ok && res.valid; error = res.ok ? "That PIN doesn't match." : (res.error || 'Something went wrong.');
  }
  if (ok) { finishGate(); return; }
  $('pin-error').textContent = `${error} Try again, or use “Forgotten your PIN?” below.`;
  input.value = ''; input.focus();
}

function onGateForgot() {
  const panel = $('pin-recovery'); const btn = $('pin-forgot');
  panel.hidden = !panel.hidden;
  btn.setAttribute('aria-expanded', String(!panel.hidden));
  if (!panel.hidden) { const inp = $('recovery-input'); if (inp) inp.focus(); }
}

// The "Forgotten your PIN?" content, built to match the mode: a recovery-code
// box when encrypted, or the delete-settings.json steps for a legacy window PIN.
function buildRecoveryPanel() {
  const panel = $('pin-recovery'); panel.textContent = '';
  if (gateMode === 'encrypted') {
    const p = document.createElement('p');
    p.textContent = 'Enter the recovery code you saved when you turned on encryption. It is the only other way in if you have forgotten your PIN.';
    const form = document.createElement('form'); form.className = 'recovery-form';
    const label = document.createElement('label'); label.className = 'visually-hidden'; label.setAttribute('for', 'recovery-input'); label.textContent = 'Recovery code';
    const input = document.createElement('input'); input.id = 'recovery-input'; input.type = 'text'; input.autocomplete = 'off'; input.spellcheck = false; input.placeholder = 'XXXX-XXXX-XXXX-XXXX-XXXX';
    const btn = document.createElement('button'); btn.type = 'submit'; btn.className = 'primary'; btn.textContent = 'Unlock with recovery code';
    const err = document.createElement('p'); err.className = 'pin-error'; err.setAttribute('role', 'alert');
    const note = document.createElement('p'); note.className = 'soft small'; note.textContent = 'After you get back in, set a new PIN under Settings, Lock and encryption, so you can lock and unlock normally again.';
    form.append(label, input, btn);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const res = await safeCall(api.unlockWithRecovery, input.value);
      if (!res.ok) { err.textContent = res.error || 'That recovery code did not work.'; input.focus(); input.select(); return; }
      // They are in, but they do not know their PIN. Choosing a new one rotates
      // the key, which is what actually retires the old PIN and the spent code.
      await runRecoveryReset(err);
    });
    panel.append(p, form, err, note);
  } else {
    const p1 = document.createElement('p');
    p1.textContent = 'This journal is not encrypted, the PIN only hides the window, so a forgotten PIN can never lock you out. Your words are stored, readable, on this computer.';
    const p2 = document.createElement('p'); p2.textContent = 'To remove a forgotten window PIN:';
    const ol = document.createElement('ol');
    const steps = ['Close Flint.', 'Open your data folder in File Explorer.', 'Delete the file settings.json.', 'Open Flint again. No PIN, and everything is still there.'];
    steps.forEach((t, i) => { const li = document.createElement('li'); if (i === 1 && gateDataDir) { li.append(document.createTextNode('Open this folder in File Explorer: ')); const code = document.createElement('code'); code.textContent = gateDataDir; li.append(code); } else { li.textContent = t; } ol.append(li); });
    panel.append(p1, p2, ol);
  }
}

// After a recovery unlock: make the user set a new PIN, which rotates the key,
// then show them the fresh recovery code that rotation produced. If they refuse
// to set one, they still get in, but the old secrets keep working and we say so
// rather than pretending otherwise.
async function runRecoveryReset(errEl) {
  for (;;) {
    const pin = await promptSecret({
      title: 'Choose a new PIN',
      body: 'You got in with your recovery code, so your old PIN is unknown. Setting a new PIN now also retires the code you just used and gives you a fresh one.',
      placeholder: 'New PIN'
    });
    if (pin === null) {
      const choice = await showModal({
        title: 'Carry on without a new PIN?', body: 'Your old PIN and the recovery code you just used will both keep working, so nothing is protected from whoever knew them.', buttons: [
          { label: 'Set a new PIN', value: 'set', kind: 'primary' }, { label: 'Not now', value: 'skip' }
        ]
      });
      if (choice === 'set') continue;
      finishGate();
      return;
    }
    const res = await safeCall(api.resetAfterRecovery, pin);
    if (res.ok && res.recoveryCode) { showGateRecoveryReissue(res.recoveryCode, res.removedBackups); return; }
    if (errEl) errEl.textContent = res.error || 'That PIN could not be set.';
  }
}

// Show the freshly issued code and make the user save it before going in.
function showGateRecoveryReissue(code, removedBackups) {
  $('pin-form').hidden = true; $('pin-forgot').hidden = true; $('pin-sub').hidden = true;
  const panel = $('pin-recovery'); panel.hidden = false; panel.textContent = '';
  const box = document.createElement('div'); box.className = 'recovery-reveal';
  const title = document.createElement('p'); title.className = 'recovery-reveal-title'; title.textContent = 'Your new recovery code';
  const warn = document.createElement('p'); warn.className = 'soft small';
  warn.textContent = 'Your PIN is set and your journal has been re-locked with a brand new key, so the old PIN and the code you just used now open nothing. Save this new code somewhere safe. It is shown once.'
    + (removedBackups ? ` ${removedBackups} older backup ${removedBackups === 1 ? 'copy' : 'copies'} could not be moved to the new key, so ${removedBackups === 1 ? 'it was' : 'they were'} removed rather than left readable by the old PIN.` : '');
  const codeEl = document.createElement('code'); codeEl.className = 'recovery-code'; codeEl.textContent = code; codeEl.tabIndex = 0;
  const row = document.createElement('div'); row.className = 'btn-row';
  const copyBtn = document.createElement('button'); copyBtn.type = 'button'; copyBtn.textContent = 'Copy code';
  const copyMsg = document.createElement('span'); copyMsg.className = 'soft small';
  copyBtn.addEventListener('click', async () => { await safeCall(api.copyText, code); copyMsg.textContent = 'Copied. Paste it somewhere safe.'; });
  const doneBtn = document.createElement('button'); doneBtn.type = 'button'; doneBtn.className = 'primary'; doneBtn.textContent = 'I have saved it';
  doneBtn.addEventListener('click', finishGate);
  row.append(copyBtn, doneBtn);
  box.append(title, warn, codeEl, row, copyMsg);
  panel.append(box);
  codeEl.focus();
}

/* lock / re-lock */

function updateLockButton(encrypted) {
  encryptedNow = Boolean(encrypted);
  const btn = $('lock-btn'); if (btn) btn.hidden = !encrypted;
  resetAutoLockTimer();
}
function updatePrivacyEncryptionLine(encrypted) {
  updateFooter(encrypted);
  const li = $('privacy-encryption'); if (!li) return;
  li.textContent = '';
  const strong = document.createElement('strong'); strong.textContent = 'On disk: ';
  li.append(strong, document.createTextNode(encrypted
    ? 'your entries are encrypted, so the files cannot be read on their own. Someone who copied them would have to guess your PIN, which is why a longer one matters: Flint shows you how long yours would take.'
    : 'your entries are stored as readable files. Turn on encryption in Settings (Lock and encryption) to scramble them with a PIN.'));
}

// The footer reassurance line, worded to match the real encryption state.
function updateFooter(encrypted) {
  const el = $('foot-text'); if (!el) return;
  el.textContent = encrypted
    ? 'Your notes are encrypted on this computer with your PIN. Your entries are never sent over the internet. The only times Flint goes online are to check for updates and to send feedback you choose to send.'
    : 'Your notes stay on this computer. Your entries are never sent over the internet. The only times Flint goes online are to check for updates and to send feedback you choose to send. Turn on a PIN in Settings to encrypt them too.';
}

async function lockAndGate() {
  await safeCall(api.lock);
  data = { version: 1, entries: {} };   // clear the words from the page behind the gate
  loadEditor(currentDate);              // resets the editor and the dirty snapshot
  renderCount(); renderCalendar();
  closeStreakPop(); closePanel();
  const status = await safeCall(api.securityStatus);
  await openLockGate(status);           // resolves when unlocked again
  const res = await safeCall(api.load);
  if (res.ok && !res.locked) {
    data = res.data || { version: 1, entries: {} };
    if (res.warning) showNotice(res.warning);
    loadEditor(currentDate); renderCount(); renderCalendar(); renderWriterHead();
    $('note').focus();
  }
  resetAutoLockTimer();
}

async function relock() {
  if (!(await guardDirty('locking Flint'))) return;
  await lockAndGate();
}

/* auto-lock on idle */

let autoLockMinutes = 15;
let autoLockTimer = null;
let encryptedNow = false;

function resetAutoLockTimer() {
  clearTimeout(autoLockTimer);
  if (!encryptedNow || !autoLockMinutes || !appReady) return;
  autoLockTimer = setTimeout(autoLockNow, autoLockMinutes * 60 * 1000);
}

// An automatic lock must never cost anyone their words: save first, and if that
// save fails, stay unlocked rather than clear the page.
async function autoLockNow() {
  if (!encryptedNow || !appReady || $('pin-gate').hidden === false) return;
  // Don't lock out from under an open dialog or settings panel: being in one is a
  // sign someone is still here. The timer resumes once it is closed.
  if (modalIsOpen() || openPanelEl) { resetAutoLockTimer(); return; }
  if (isDirty()) {
    const saved = await saveCurrent();
    if (!saved) { resetAutoLockTimer(); return; }
  }
  await lockAndGate();
}

/* security settings (encryption) */

// How long a PIN would hold up against someone who copied your files and tried
// every combination offline. This is the honest number: the encryption itself is
// strong, but it can only ever be as strong as the PIN in front of it, and a
// short one falls fast no matter how slow each guess is made.
//
// GUESSES_PER_SEC assumes a determined attacker with a high-end graphics card
// against our key settings (deliberately memory-hungry, which is what keeps this
// number low). It is a conservative estimate: better to overstate the risk.
const GUESSES_PER_SEC = 500;

function humanDuration(seconds) {
  if (seconds < 1) return 'less than a second';
  if (seconds < 60) return `about ${Math.round(seconds)} seconds`;
  const mins = seconds / 60;
  if (mins < 60) return `about ${Math.round(mins)} minute${Math.round(mins) === 1 ? '' : 's'}`;
  const hours = mins / 60;
  if (hours < 24) return `about ${Math.round(hours)} hour${Math.round(hours) === 1 ? '' : 's'}`;
  const days = hours / 24;
  if (days < 365) return `about ${Math.round(days)} day${Math.round(days) === 1 ? '' : 's'}`;
  const years = days / 365;
  if (years < 1000) return `about ${Math.round(years)} year${Math.round(years) === 1 ? '' : 's'}`;
  if (years < 1e6) return 'thousands of years';
  return 'millions of years';
}

function crackSeconds(pin) {
  const s = String(pin || '');
  let charset = 0;
  if (/[a-z]/.test(s)) charset += 26;
  if (/[A-Z]/.test(s)) charset += 26;
  if (/[0-9]/.test(s)) charset += 10;
  if (/[^a-zA-Z0-9]/.test(s)) charset += 33;
  if (!charset) return 0;
  // On average an attacker finds it half way through the space.
  return Math.pow(charset, s.length) / 2 / GUESSES_PER_SEC;
}

function pinStrength(pin) {
  const s = String(pin || '');
  if (!s) return { level: '', text: '' };
  if (s.length < 4) return { level: 'weak', text: 'Too short. Use at least 4 characters.' };
  const secs = crackSeconds(s);
  const level = secs < 60 * 60 ? 'weak'
    : secs < 60 * 60 * 24 * 30 ? 'fair'
      : secs < 60 * 60 * 24 * 365 * 100 ? 'good'
        : 'strong';
  return { level, text: `This PIN could be cracked in ${humanDuration(secs)}.` };
}

function attachStrengthHint(input, hint) {
  input.addEventListener('input', () => {
    const s = pinStrength(input.value);
    hint.textContent = s.text;
    hint.className = 'pin-hint' + (s.level ? ' is-' + s.level : '');
  });
}

function secField(labelText, id, opts = {}) {
  const wrap = document.createElement('div'); wrap.className = 'field';
  const label = document.createElement('label'); label.setAttribute('for', id); label.textContent = labelText;
  const input = document.createElement('input'); input.type = 'password'; input.id = id; input.autocomplete = 'off'; input.maxLength = 64;
  wrap.append(label, input);
  if (opts.strength) {
    const hint = document.createElement('p'); hint.className = 'pin-hint';
    attachStrengthHint(input, hint);
    wrap.append(hint);
  }
  return { wrap, input };
}

async function renderSecuritySettings(announce) {
  const status = await safeCall(api.securityStatus);
  const encrypted = status.ok && status.encrypted;
  updateLockButton(encrypted);
  updatePrivacyEncryptionLine(encrypted);
  $('security-explain').textContent = encrypted
    ? 'Your journal is encrypted on this computer. Your PIN unlocks it each time Flint opens. Keep your recovery code safe: it is the only other way in if you forget your PIN.'
    : 'Turn on encryption to scramble your entries on disk. Your PIN unlocks them; if you ever forget it, a one-time recovery code is the only other way in, so keep it safe. Both lost means the journal cannot be recovered, by anyone. That is what makes it real.';
  const holder = $('security-settings'); holder.textContent = '';
  holder.append(encrypted ? buildChangePinForm() : buildEnableForm());
  if (encrypted) holder.append(buildAutoLockControl(), buildDisableForm());
  else if (status.ok && status.windowPin) holder.append(buildRemoveWindowPinForm());
  $('security-status').textContent = announce || '';
}

function buildEnableForm() {
  const form = document.createElement('form'); form.className = 'sec-form';
  const a = secField('Choose a PIN (at least 4 characters)', 'enc-new', { strength: true });
  const b = secField('Type it again', 'enc-confirm');
  const btn = document.createElement('button'); btn.type = 'submit'; btn.className = 'primary'; btn.textContent = 'Turn on encryption';
  const msg = document.createElement('p'); msg.className = 'status'; msg.setAttribute('role', 'status');
  form.append(a.wrap, b.wrap, btn, msg);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); msg.classList.remove('error');
    if (a.input.value.length < 4) { msg.textContent = 'Choose a PIN of at least 4 characters.'; msg.classList.add('error'); return; }
    if (a.input.value !== b.input.value) { msg.textContent = 'Those two PINs are not the same.'; msg.classList.add('error'); return; }
    btn.disabled = true; msg.classList.remove('error'); msg.textContent = 'Encrypting…';
    const res = await safeCall(api.enableEncryption, a.input.value);
    btn.disabled = false;
    if (res.ok && res.recoveryCode) { showRecoveryReveal(res.recoveryCode, res.removedBackups, res.leftovers); }
    else { msg.textContent = res.error || 'Encryption could not be turned on.'; msg.classList.add('error'); }
  });
  return form;
}

// After encryption is switched on, show the recovery code once, front and
// centre, and make the user acknowledge it before moving on. It is never shown
// again, because Flint does not store it anywhere.
function showRecoveryReveal(code, removedBackups, leftovers) {
  const holder = $('security-settings'); holder.textContent = '';
  updateLockButton(true); updatePrivacyEncryptionLine(true);
  $('security-explain').textContent = 'Encryption is on.';
  const box = document.createElement('div'); box.className = 'recovery-reveal';
  const title = document.createElement('p'); title.className = 'recovery-reveal-title'; title.textContent = 'Save your recovery code now';
  const codeEl = document.createElement('code'); codeEl.className = 'recovery-code'; codeEl.textContent = code; codeEl.tabIndex = 0;
  const warn = document.createElement('p'); warn.className = 'soft small';
  warn.textContent = 'This is the only time it is shown. Write it down, or keep it somewhere safe and separate from this computer. If you forget your PIN, this code is the only way back into your journal. Flint does not store it, so it cannot show it to you again.'
    + (removedBackups ? ` Any older backup that could not be moved to the new key was removed (${removedBackups}), rather than left readable by your old PIN.` : '');
  const row = document.createElement('div'); row.className = 'btn-row';
  const copyBtn = document.createElement('button'); copyBtn.type = 'button'; copyBtn.textContent = 'Copy code';
  const copyMsg = document.createElement('span'); copyMsg.className = 'soft small';
  copyBtn.addEventListener('click', async () => { await safeCall(api.copyText, code); copyMsg.textContent = 'Copied. Paste it somewhere safe, then clear your clipboard.'; });
  const doneBtn = document.createElement('button'); doneBtn.type = 'button'; doneBtn.className = 'primary'; doneBtn.textContent = 'I have saved it';
  doneBtn.addEventListener('click', () => renderSecuritySettings('Encryption is on. Flint will ask for your PIN each time it opens.'));
  row.append(copyBtn, doneBtn);
  box.append(title, codeEl, warn, row, copyMsg);
  holder.append(box);

  // If any readable copy survived, say so rather than let "Encryption is on"
  // imply the old plaintext is gone when it is not.
  if (leftovers && leftovers.length) {
    const note = document.createElement('div'); note.className = 'leftover-note';
    const h = document.createElement('p'); h.className = 'recovery-reveal-title'; h.textContent = 'Some readable copies are still there';
    const p = document.createElement('p'); p.className = 'soft small';
    p.textContent = `Your journal itself is encrypted, but ${leftovers.join(', and ')}. They may be open in another program. Close anything using your data folder and turn encryption off and on again, or delete them yourself.`;
    note.append(h, p);
    holder.append(note);
  }
  codeEl.focus();
}

function buildChangePinForm() {
  const form = document.createElement('form'); form.className = 'sec-form';
  const cur = secField('Current PIN', 'enc-cur');
  const a = secField('New PIN (at least 4 characters)', 'enc-chg-new', { strength: true });
  const b = secField('Type the new PIN again', 'enc-chg-confirm');
  const btn = document.createElement('button'); btn.type = 'submit'; btn.className = 'primary'; btn.textContent = 'Change PIN';
  const msg = document.createElement('p'); msg.className = 'status'; msg.setAttribute('role', 'status');
  form.append(cur.wrap, a.wrap, b.wrap, btn, msg);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); msg.classList.remove('error');
    if (a.input.value.length < 4) { msg.textContent = 'Choose a new PIN of at least 4 characters.'; msg.classList.add('error'); return; }
    if (a.input.value !== b.input.value) { msg.textContent = 'The two new PINs are not the same.'; msg.classList.add('error'); return; }
    btn.disabled = true; msg.classList.remove('error'); msg.textContent = 'Re-locking your journal with a new key…';
    const res = await safeCall(api.changeEncryptionPin, cur.input.value, a.input.value);
    btn.disabled = false;
    // Changing the PIN rotates the key, which issues a new recovery code. The
    // old code stops working, so the user must be shown and keep the new one.
    if (res.ok && res.recoveryCode) showRecoveryReveal(res.recoveryCode, res.removedBackups);
    else { msg.textContent = res.error || 'The PIN could not be changed.'; msg.classList.add('error'); cur.input.value = ''; cur.input.focus(); }
  });
  return form;
}

function buildAutoLockControl() {
  const wrap = document.createElement('div'); wrap.className = 'field sec-autolock';
  const label = document.createElement('label'); label.setAttribute('for', 'autolock-select'); label.textContent = 'Lock automatically after';
  const sel = document.createElement('select'); sel.id = 'autolock-select';
  for (const [v, t] of [[0, 'Never'], [1, '1 minute'], [5, '5 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 hour']]) {
    const o = document.createElement('option'); o.value = String(v); o.textContent = t; sel.append(o);
  }
  sel.value = String(autoLockMinutes);
  const msg = document.createElement('p'); msg.className = 'soft small';
  msg.textContent = 'Flint locks itself after this long without activity. Anything you have written is saved first, so nothing is lost.';
  sel.addEventListener('change', async () => {
    const res = await safeCall(api.setAutoLock, Number(sel.value));
    if (res.ok) { autoLockMinutes = res.minutes; resetAutoLockTimer(); }
  });
  wrap.append(label, sel, msg);
  return wrap;
}

function buildDisableForm() {
  const details = document.createElement('details'); details.className = 'sec-disable';
  const summary = document.createElement('summary'); summary.className = 'linklike'; summary.textContent = 'Turn off encryption';
  const p = document.createElement('p'); p.className = 'soft small'; p.textContent = 'This writes your entries back as readable files on this computer. Only do it if you no longer need them protected.';
  const form = document.createElement('form'); form.className = 'sec-form';
  const cur = secField('Enter your PIN to confirm', 'enc-off-pin');
  const btn = document.createElement('button'); btn.type = 'submit'; btn.className = 'danger'; btn.textContent = 'Turn off encryption';
  const msg = document.createElement('p'); msg.className = 'status'; msg.setAttribute('role', 'status');
  form.append(cur.wrap, btn, msg);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); msg.classList.remove('error');
    btn.disabled = true;
    const res = await safeCall(api.disableEncryption, cur.input.value);
    btn.disabled = false;
    if (res.ok) renderSecuritySettings('Encryption is off. Your entries are readable files again.');
    else { msg.textContent = res.error || 'Encryption could not be turned off.'; msg.classList.add('error'); cur.input.value = ''; cur.input.focus(); }
  });
  details.append(summary, p, form);
  return details;
}

// Legacy: only appears if an older install still has a window-only PIN set.
function buildRemoveWindowPinForm() {
  const wrap = document.createElement('div'); wrap.className = 'sec-legacy';
  const p = document.createElement('p'); p.className = 'soft small'; p.textContent = 'You have an older window PIN set (it hides the window but does not encrypt). Turning on encryption above replaces it, or you can just remove it here.';
  const form = document.createElement('form'); form.className = 'sec-form';
  const cur = secField('Current window PIN', 'win-pin');
  const btn = document.createElement('button'); btn.type = 'submit'; btn.textContent = 'Remove window PIN';
  const msg = document.createElement('p'); msg.className = 'status'; msg.setAttribute('role', 'status');
  form.append(cur.wrap, btn, msg);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); msg.classList.remove('error');
    const res = await safeCall(api.pinRemove, cur.input.value);
    if (res.ok && res.valid) renderSecuritySettings('Window PIN removed.');
    else { msg.textContent = res.ok ? "That PIN doesn't match." : (res.error || 'Could not remove it.'); msg.classList.add('error'); cur.input.value = ''; }
  });
  wrap.append(p, form);
  return wrap;
}

/* onboarding (first run) */

let onboardResolve = null;

function onboardGoto(step) {
  for (const el of document.querySelectorAll('#onboarding .onboard-step')) el.hidden = el.dataset.step !== step;
  const active = document.querySelector(`#onboarding .onboard-step[data-step="${step}"]`);
  const focusable = active && active.querySelector('button, input, [tabindex]');
  if (focusable) focusable.focus();
}

function showOnboarding() {
  return new Promise((resolve) => {
    onboardResolve = resolve;
    syncThemeChoice();
    $('onboarding').hidden = false;
    onboardGoto('theme');
  });
}

async function onboardEnableEncryption(e) {
  e.preventDefault();
  const pin = $('onboard-pin').value;
  const confirm = $('onboard-pin-confirm').value;
  const err = $('onboard-pin-error'); err.textContent = '';
  if (pin.length < 4) { err.textContent = 'Choose a PIN of at least 4 characters.'; return; }
  if (pin !== confirm) { err.textContent = 'Those two PINs are not the same.'; return; }
  const res = await safeCall(api.enableEncryption, pin);
  if (res.ok && res.recoveryCode) {
    $('onboard-recovery-code').textContent = res.recoveryCode;
    onboardGoto('recovery');
  } else {
    err.textContent = res.error || 'Encryption could not be turned on.';
  }
}

async function finishOnboarding() {
  // Awaited so the first-run day is stamped before the editor loads and the
  // starter-week touch checks for it.
  await safeCall(api.setOnboarded);
  $('onboarding').hidden = true;
  const done = onboardResolve; onboardResolve = null;
  if (done) done();
}

// Wired once at startup; showOnboarding() drives the steps and resolves at the end.
function wireOnboarding() {
  wireThemeChoice($('onboard-theme'));
  attachStrengthHint($('onboard-pin'), $('onboard-pin-hint'));
  $('onboard-theme-next').addEventListener('click', () => onboardGoto('pin'));
  $('onboard-pin-yes').addEventListener('click', () => onboardGoto('pin-entry'));
  $('onboard-pin-no').addEventListener('click', finishOnboarding);
  $('onboard-pin-back').addEventListener('click', () => onboardGoto('pin'));
  $('onboard-pin-form').addEventListener('submit', onboardEnableEncryption);
  $('onboard-copy').addEventListener('click', async () => {
    await safeCall(api.copyText, $('onboard-recovery-code').textContent);
    $('onboard-copy-msg').textContent = 'Copied. Paste it somewhere safe, then clear your clipboard.';
  });
  $('onboard-recovery-done').addEventListener('click', finishOnboarding);
}

/* prompts editor */

let promptDraft = [];
function renderPromptsEditor(announce) {
  const holder = $('prompts-list'); holder.textContent = '';
  promptDraft.forEach((q, i) => {
    const row = document.createElement('div'); row.className = 'prompt-row';
    const title = document.createElement('input'); title.type = 'text'; title.className = 'prompt-title'; title.value = q.title; title.placeholder = 'Prompt title'; title.maxLength = 200;
    title.setAttribute('aria-label', `Prompt ${i + 1} title`);
    title.addEventListener('input', () => { promptDraft[i].title = title.value; });
    const hint = document.createElement('input'); hint.type = 'text'; hint.className = 'prompt-hint'; hint.value = q.hint || ''; hint.placeholder = 'Optional helper line'; hint.maxLength = 1000;
    hint.setAttribute('aria-label', `Prompt ${i + 1} helper text`);
    hint.addEventListener('input', () => { promptDraft[i].hint = hint.value; });
    const controls = document.createElement('div'); controls.className = 'prompt-controls';
    const up = iconBtn('↑', `Move up`, () => movePrompt(i, -1)); up.disabled = i === 0;
    const down = iconBtn('↓', `Move down`, () => movePrompt(i, 1)); down.disabled = i === promptDraft.length - 1;
    const del = iconBtn('×', `Remove`, () => { promptDraft.splice(i, 1); renderPromptsEditor(); }); del.classList.add('danger');
    controls.append(up, down, del);
    row.append(title, hint, controls); holder.append(row);
  });
  $('prompts-status').textContent = announce || '';
}
function iconBtn(symbol, label, onClick) { const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'prompt-icon'; btn.textContent = symbol; btn.setAttribute('aria-label', label); btn.addEventListener('click', onClick); return btn; }
function movePrompt(i, delta) { const j = i + delta; if (j < 0 || j >= promptDraft.length) return; const t = promptDraft[i]; promptDraft[i] = promptDraft[j]; promptDraft[j] = t; renderPromptsEditor(); }
function startPromptsEditor() { promptDraft = questions.map((q) => ({ key: q.key, title: q.title, hint: q.hint || '' })); renderPromptsEditor(); }
async function savePrompts() {
  const cleaned = promptDraft.map((q) => ({ key: q.key, title: (q.title || '').trim(), hint: (q.hint || '').trim() })).filter((q) => q.title);
  if (!cleaned.length) { renderPromptsEditor('Add at least one prompt with a title before saving.'); return; }
  if (!(await guardDirty('changing your prompts'))) return;
  const res = await safeCall(api.setQuestions, cleaned);
  if (!res.ok) { renderPromptsEditor(res.error || 'Those prompts could not be saved.'); return; }
  questions = res.questions;
  const fresh = await safeCall(api.getQuestions); if (fresh.ok) knownTitles = fresh.knownTitles || {};
  if (guided) { buildPromptSections(); const entry = data.entries[currentDate] || {}; for (const q of questions) { const el = $(`box-${q.key}`); if (el) el.value = typeof entry[q.key] === 'string' ? entry[q.key] : ''; } snapshot = currentState(); }
  startPromptsEditor(); renderPromptsEditor('Saved. Your prompts are updated.');
}

/* scheduled backups */

let backupCfg = { enabled: false, folder: '', keep: 10, lastRun: '' };

function renderBackup() {
  $('backup-toggle').checked = backupCfg.enabled;
  $('backup-folder').textContent = backupCfg.folder || 'not chosen yet';
  $('backup-now-btn').disabled = !backupCfg.folder;
  if (backupCfg.lastRun) {
    const d = new Date(backupCfg.lastRun);
    if (!isNaN(d)) $('backup-status').textContent = `Last copy: ${d.toLocaleDateString('en-GB')} at ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}.`;
  }
}
async function saveBackupCfg(next) {
  const res = await safeCall(api.setBackup, next);
  if (!res.ok) { $('backup-status').textContent = res.error || 'That could not be saved.'; return; }
  backupCfg = res.backup;
  renderBackup();
  if (backupCfg.enabled) $('backup-status').textContent = 'On. Flint will keep a dated copy there once a day.';
  else if (!backupCfg.folder) $('backup-status').textContent = 'Choose a folder first.';
  else $('backup-status').textContent = 'Off.';
}

/* daily reminder */

async function saveReminder() {
  const next = { enabled: $('reminder-toggle').checked, time: $('reminder-time').value || '20:00' };
  const res = await safeCall(api.setReminder, next);
  if (!res.ok) { $('reminder-status').textContent = res.error || 'That could not be saved.'; return; }
  $('reminder-time').disabled = !res.reminder.enabled;
  $('reminder-status').textContent = res.reminder.enabled
    ? `Flint will nudge you at ${res.reminder.time} if you have not written.`
    : 'Reminder off.';
}

/* patterns (local stats) */
//
// Everything here is counted from the entries already in memory. No scores are
// invented for a day: correlations lean on the Good/Mixed/Hard marker the user
// already chose, which keeps the calm, no-numbers feel of the day marker.

function allWrittenDates() {
  return Object.keys(data.entries).filter((d) => entryHasAnyContent(data.entries[d])).sort();
}
function countWords(entry) {
  return entryTexts(entry).join(' ').split(/\s+/).filter(Boolean).length;
}

// The longest run ever, stepping over days off exactly as the live streak does.
function longestStreak() {
  const written = allWrittenDates();
  if (!written.length) return 0;
  const end = new Date(todayISO() + 'T00:00:00');
  let run = 0, best = 0;
  for (const d = new Date(written[0] + 'T00:00:00'); d <= end; d.setDate(d.getDate() + 1)) {
    if (entryHasAnyContent(data.entries[ymd(d)])) { run++; if (run > best) best = run; }
    else if (!daysOff.includes(d.getDay())) run = 0;
  }
  return best;
}

// How each tag's days tended to go. Only tags with a couple of marked days are
// shown, because two data points is the least that can suggest anything at all.
function tagCorrelations() {
  const byTag = new Map();
  for (const entry of Object.values(data.entries)) {
    if (!entryHasAnyContent(entry)) continue;
    for (const tag of entryTags(entry)) {
      const key = tag.toLowerCase();
      if (!byTag.has(key)) byTag.set(key, { tag, good: 0, mixed: 0, hard: 0, total: 0 });
      const c = byTag.get(key);
      c.total++;
      if (entry.__day === 'good') c.good++;
      else if (entry.__day === 'mixed') c.mixed++;
      else if (entry.__day === 'hard') c.hard++;
    }
  }
  return [...byTag.values()]
    .filter((c) => c.good + c.mixed + c.hard >= 2)
    .sort((a, b) => (b.good + b.mixed + b.hard) - (a.good + a.mixed + a.hard))
    .slice(0, 8);
}

function buildPixels() {
  const wrap = document.createElement('div'); wrap.className = 'pixels';
  const now = new Date(todayISO() + 'T00:00:00');
  for (let back = 11; back >= 0; back--) {
    const m = new Date(now.getFullYear(), now.getMonth() - back, 1);
    const row = document.createElement('div'); row.className = 'pixel-row';
    const label = document.createElement('span'); label.className = 'pixel-month';
    label.textContent = m.toLocaleDateString('en-GB', { month: 'short' });
    row.append(label);
    const days = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
    for (let d = 1; d <= days; d++) {
      const iso = ymd(new Date(m.getFullYear(), m.getMonth(), d));
      const cell = document.createElement('span'); cell.className = 'pixel';
      const entry = data.entries[iso];
      if (iso > todayISO()) cell.classList.add('future');
      else if (entryHasAnyContent(entry)) {
        cell.classList.add('on');
        if (entry.__day) cell.classList.add('m-' + entry.__day);
        const marker = dayMarker(entry.__day);
        cell.title = marker ? `${longDate(iso)}, ${marker.label}` : longDate(iso);
      } else {
        cell.title = longDate(iso);
      }
      row.append(cell);
    }
    wrap.append(row);
  }
  return wrap;
}

function renderStats() {
  const body = $('stats-body'); body.textContent = '';
  const written = allWrittenDates();
  const { count: current } = computeStreak();
  const words = written.reduce((n, d) => n + countWords(data.entries[d]), 0);

  const grid = document.createElement('div'); grid.className = 'stat-grid';
  for (const [label, value] of [
    ['Days written', String(written.length)],
    ['Current streak', String(current)],
    ['Longest streak', String(longestStreak())],
    ['Words written', words.toLocaleString('en-GB')]
  ]) {
    const tile = document.createElement('div'); tile.className = 'stat-tile';
    const v = document.createElement('div'); v.className = 'stat-value'; v.textContent = value;
    const l = document.createElement('div'); l.className = 'stat-label'; l.textContent = label;
    tile.append(v, l); grid.append(tile);
  }
  body.append(grid);

  if (!written.length) {
    const p = document.createElement('p'); p.className = 'soft';
    p.textContent = 'Write a few days and your patterns will show up here.';
    body.append(p);
    return;
  }

  const h1 = document.createElement('h3'); h1.textContent = 'Your year in pixels';
  const p1 = document.createElement('p'); p1.className = 'soft small';
  p1.textContent = 'One square per day for the last twelve months, tinted by how the day went.';
  body.append(h1, p1, buildPixels());

  const legend = document.createElement('div'); legend.className = 'pixel-legend';
  for (const [cls, text] of [['on', 'Written'], ['on m-good', 'Good'], ['on m-mixed', 'Mixed'], ['on m-hard', 'Bad']]) {
    const item = document.createElement('span'); item.className = 'pixel-legend-item';
    const sw = document.createElement('span'); sw.className = 'pixel ' + cls;
    const t = document.createElement('span'); t.textContent = text;
    item.append(sw, t); legend.append(item);
  }
  body.append(legend);

  const corr = tagCorrelations();
  const h2 = document.createElement('h3'); h2.textContent = 'Tags and how those days went';
  body.append(h2);
  if (!corr.length) {
    const p = document.createElement('p'); p.className = 'soft small';
    p.textContent = 'Tag a few days and set "How was today?" on them, and any pattern will show here.';
    body.append(p);
    return;
  }
  const p2 = document.createElement('p'); p2.className = 'soft small';
  p2.textContent = 'Only days you tagged and marked are counted. This shows a leaning, not a verdict.';
  body.append(p2);
  const list = document.createElement('div'); list.className = 'corr-list';
  for (const c of corr) {
    const marked = c.good + c.mixed + c.hard;
    const row = document.createElement('div'); row.className = 'corr-row';
    const head = document.createElement('div'); head.className = 'corr-head';
    const name = document.createElement('span'); name.className = 'corr-tag'; name.textContent = c.tag;
    const n = document.createElement('span'); n.className = 'soft small';
    n.textContent = `${marked} marked ${marked === 1 ? 'day' : 'days'}`;
    head.append(name, n);
    const bar = document.createElement('div'); bar.className = 'corr-bar';
    for (const kind of ['good', 'mixed', 'hard']) {
      if (!c[kind]) continue;
      const seg = document.createElement('span'); seg.className = 'corr-seg m-' + kind;
      seg.style.width = `${Math.round((c[kind] / marked) * 100)}%`;
      seg.title = `${c[kind]} ${(dayMarker(kind) || {}).short || kind}`;
      bar.append(seg);
    }
    row.append(head, bar); list.append(row);
  }
  body.append(list);
}

/* markdown preview */
//
// A deliberately small Markdown renderer. It builds DOM nodes and never touches
// innerHTML, so nothing written in a note can turn into live markup. Notes stay
// plain text on disk; this is only a way of reading them back.

let previewOn = false;

function appendInline(parent, text) {
  const re = /(\*\*[^*]+\*\*|`[^`]+`|~~[^~]+~~|\*[^*]+\*|_[^_]+_)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) parent.append(document.createTextNode(text.slice(last, m.index)));
    const tok = m[0];
    let el;
    if (tok.startsWith('**')) { el = document.createElement('strong'); el.textContent = tok.slice(2, -2); }
    else if (tok.startsWith('`')) { el = document.createElement('code'); el.textContent = tok.slice(1, -1); }
    else if (tok.startsWith('~~')) { el = document.createElement('s'); el.textContent = tok.slice(2, -2); }
    else { el = document.createElement('em'); el.textContent = tok.slice(1, -1); }
    parent.append(el);
    last = m.index + tok.length;
  }
  if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
}

function isBlockStart(line) {
  return /^```/.test(line.trim())
    || /^#{1,3}\s/.test(line)
    || /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)
    || /^\s*>\s?/.test(line)
    || /^\s*[-*+]\s+/.test(line)
    || /^\s*\d+\.\s+/.test(line);
}

function renderMarkdownInto(container, src) {
  container.textContent = '';
  const lines = String(src || '').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line.trim())) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) { buf.push(lines[i]); i++; }
      i++;
      const pre = document.createElement('pre'); const code = document.createElement('code');
      code.textContent = buf.join('\n'); pre.append(code); container.append(pre);
      continue;
    }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      const el = document.createElement('h' + (h[1].length + 1)); // the page already owns h1
      appendInline(el, h[2]); container.append(el); i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { container.append(document.createElement('hr')); i++; continue; }
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      const bq = document.createElement('blockquote'); const p = document.createElement('p');
      appendInline(p, buf.join(' ')); bq.append(p); container.append(bq);
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const ul = document.createElement('ul');
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        const li = document.createElement('li'); appendInline(li, lines[i].replace(/^\s*[-*+]\s+/, '')); ul.append(li); i++;
      }
      container.append(ul);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const ol = document.createElement('ol');
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        const li = document.createElement('li'); appendInline(li, lines[i].replace(/^\s*\d+\.\s+/, '')); ol.append(li); i++;
      }
      container.append(ol);
      continue;
    }
    if (!line.trim()) { i++; continue; }

    const buf = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) { buf.push(lines[i]); i++; }
    const p = document.createElement('p'); appendInline(p, buf.join(' ')); container.append(p);
  }
  if (!container.childElementCount) {
    const p = document.createElement('p'); p.className = 'soft'; p.textContent = 'Nothing written for this day yet.';
    container.append(p);
  }
}

function setPreview(on) {
  previewOn = Boolean(on);
  const btn = $('preview-btn');
  btn.setAttribute('aria-pressed', String(previewOn));
  btn.classList.toggle('is-on', previewOn);
  $('note').hidden = previewOn;
  $('note-preview').hidden = !previewOn;
  if (previewOn) renderMarkdownInto($('note-preview'), noteValue());
  else $('note').focus();
}

/* entry templates */

let templates = (window.DEFAULT_TEMPLATES || []).map((t) => ({ ...t }));

// Drops a template in at the cursor, keeping whatever is already written.
function insertTemplate(body) {
  const ta = $('note');
  const start = ta.selectionStart, end = ta.selectionEnd;
  const before = ta.value.slice(0, start);
  const after = ta.value.slice(end);
  const gap = before && !before.endsWith('\n\n') ? (before.endsWith('\n') ? '\n' : '\n\n') : '';
  ta.value = before + gap + body + after;
  const caret = (before + gap + body).length;
  ta.setSelectionRange(caret, caret);
  autosize(ta);
  ta.focus();
}

function toggleTplMenu() {
  const menu = $('tpl-menu');
  if (!menu.hidden) { closeTplMenu(); return; }
  menu.textContent = '';
  for (const t of templates) {
    const item = document.createElement('button'); item.type = 'button'; item.className = 'tpl-item'; item.setAttribute('role', 'menuitem');
    item.textContent = t.name;
    item.addEventListener('click', () => { closeTplMenu(); insertTemplate(t.body); });
    menu.append(item);
  }
  menu.hidden = false;
  $('tpl-btn').setAttribute('aria-expanded', 'true');
  document.addEventListener('keydown', tplMenuKey, true);
  document.addEventListener('click', tplMenuOutside, true);
}
function closeTplMenu() {
  const menu = $('tpl-menu'); if (menu.hidden) return;
  menu.hidden = true;
  $('tpl-btn').setAttribute('aria-expanded', 'false');
  document.removeEventListener('keydown', tplMenuKey, true);
  document.removeEventListener('click', tplMenuOutside, true);
}
function tplMenuKey(e) { if (e.key === 'Escape') { e.preventDefault(); closeTplMenu(); $('tpl-btn').focus(); } }
function tplMenuOutside(e) { if (!$('tpl-menu').contains(e.target) && !$('tpl-btn').contains(e.target)) closeTplMenu(); }

/* templates editor (settings) */

let tplDraft = [];
function startTemplatesEditor() { tplDraft = templates.map((t) => ({ ...t })); renderTemplatesEditor(); }
function renderTemplatesEditor(announce) {
  const holder = $('templates-list'); if (!holder) return;
  holder.textContent = '';
  tplDraft.forEach((t, i) => {
    const row = document.createElement('div'); row.className = 'tpl-row';
    const name = document.createElement('input'); name.type = 'text'; name.className = 'tpl-name'; name.value = t.name; name.placeholder = 'Template name'; name.maxLength = 80;
    name.setAttribute('aria-label', `Template ${i + 1} name`);
    name.addEventListener('input', () => { tplDraft[i].name = name.value; });
    const body = document.createElement('textarea'); body.className = 'tpl-body'; body.value = t.body || ''; body.rows = 3; body.placeholder = 'What the template writes into the day';
    body.setAttribute('aria-label', `Template ${i + 1} body`);
    body.addEventListener('input', () => { tplDraft[i].body = body.value; });
    const del = iconBtn('×', 'Remove template', () => { tplDraft.splice(i, 1); renderTemplatesEditor(); }); del.classList.add('danger');
    row.append(name, body, del); holder.append(row);
  });
  $('templates-status').textContent = announce || '';
}
async function saveTemplatesEdits() {
  const cleaned = tplDraft.map((t) => ({ name: (t.name || '').trim(), body: t.body || '' })).filter((t) => t.name);
  if (!cleaned.length) { renderTemplatesEditor('Add at least one template with a name before saving.'); return; }
  const res = await safeCall(api.setTemplates, cleaned);
  if (!res.ok) { renderTemplatesEditor(res.error || 'Those templates could not be saved.'); return; }
  templates = res.templates;
  startTemplatesEditor(); renderTemplatesEditor('Saved. Your templates are updated.');
}

/* focus mode */

let focusMode = false;

function setFocusMode(on) {
  focusMode = Boolean(on);
  document.body.classList.toggle('is-focus', focusMode);
  const btn = $('focus-btn');
  btn.setAttribute('aria-pressed', String(focusMode));
  btn.classList.toggle('is-on', focusMode);
  if (focusMode) $('note').focus();
}

/* side panels */

let openPanelEl = null;
function openPanel(el) {
  closePanel();
  openPanelEl = el;
  const scrim = $('panel-scrim');
  scrim.hidden = false;
  el.hidden = false;
  // Force a reflow so the slide-in transition has a starting frame, then add
  // the open class synchronously (requestAnimationFrame can be throttled).
  void el.offsetWidth;
  scrim.classList.add('is-open');
  el.classList.add('is-open');
  const focusable = el.querySelector('button, input, [tabindex]'); if (focusable) focusable.focus();
  document.addEventListener('keydown', panelKey, true);
}
function closePanel() {
  if (!openPanelEl) return;
  const el = openPanelEl; openPanelEl = null;
  el.classList.remove('is-open'); $('panel-scrim').classList.remove('is-open');
  el.hidden = true; $('panel-scrim').hidden = true;
  document.removeEventListener('keydown', panelKey, true);
}
function panelKey(e) { if (e.key === 'Escape') { e.preventDefault(); closePanel(); } }

// Settings is one dialog with a category rail: show the chosen category, mark its
// tab, and scroll the content back to the top.
function showSettingsCat(cat) {
  for (const b of document.querySelectorAll('#settings-nav .settings-nav-item')) b.classList.toggle('is-active', b.dataset.cat === cat);
  for (const c of document.querySelectorAll('#settings-content .settings-cat')) c.hidden = c.dataset.cat !== cat;
  const content = $('settings-content'); if (content) content.scrollTop = 0;
}

/* start over (reset everything) */

// Two separate confirmations, both defaulting to the safe choice, because this
// erases the whole journal with no undo. On success the main process reloads the
// window straight into first-run onboarding, so there is nothing to do here.
async function resetEverything() {
  const first = await showModal({
    title: 'Erase everything and start over?',
    body: 'This deletes every entry and backup, your settings, and your PIN, and returns Flint to a brand-new setup. It cannot be undone, and there is no backup once it is gone.',
    buttons: [{ label: 'Continue', value: 'go', kind: 'danger' }, { label: 'Keep my journal', value: 'keep', kind: 'primary' }],
    focusValue: 'keep'
  });
  if (first !== 'go') return;
  const second = await showModal({
    title: 'Last chance, this is permanent',
    body: 'Are you completely sure? Everything in Flint will be gone for good the moment you confirm.',
    buttons: [{ label: 'Yes, erase everything', value: 'erase', kind: 'danger' }, { label: 'Cancel', value: 'cancel', kind: 'primary' }],
    focusValue: 'cancel'
  });
  if (second !== 'erase') return;
  $('reset-status').textContent = 'Erasing…';
  const res = await safeCall(api.resetAll);
  if (!res.ok) $('reset-status').textContent = res.error || 'That could not be completed.';
}

/* feedback */

function randomHandle() {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += a[Math.floor(Math.random() * a.length)];
  return 'flint-' + s;
}

async function sendFeedback() {
  const fb = await promptFeedback();
  if (!fb || !fb.text.trim()) return;
  const name = fb.name.trim().slice(0, 60) || randomHandle();
  const res = await safeCall(api.sendFeedback, { text: fb.text.trim(), name });
  if (res.ok) {
    await showModal({ title: 'Thanks', body: 'Your feedback was sent. Thank you.', buttons: [{ label: 'OK', kind: 'primary', value: true }] });
  } else {
    const body = 'Sorry, your feedback could not be sent just now. Please try again later.' + (res.error ? '\n' + res.error : '');
    await showModal({ title: 'That could not be sent', body, buttons: [{ label: 'OK', kind: 'primary', value: true }] });
  }
}

/* boot */

async function init() {
  const themeRes = await safeCall(api.getTheme);
  applyTheme(themeRes.ok ? themeRes.theme : 'light');

  // Wire the lock gate and onboarding once; each is driven by a promise below.
  $('pin-form').addEventListener('submit', onGateSubmit);
  $('pin-forgot').addEventListener('click', onGateForgot);
  wireOnboarding();

  // Register the close guard now, before the gate or onboarding can hold up
  // init. Until the editor loads, isDirty() is false, so closing during the
  // gate or onboarding just closes cleanly instead of wrongly asking to save.
  api.onQueryDirty(() => api.dirtyReply(isDirty()));
  api.onSaveThenClose(async () => { const ok = await saveCurrent(); if (ok) api.closeNow(); });

  let secStatus = await safeCall(api.securityStatus);
  const needGate = secStatus.ok && ((secStatus.encrypted && !secStatus.unlocked) || (!secStatus.encrypted && secStatus.windowPin));
  if (needGate) await openLockGate(secStatus);

  // First run: a brand-new (ungated) journal shows the onboarding overlay once.
  if (!needGate) {
    const ob = await safeCall(api.getOnboarded);
    if (ob.ok && !ob.onboarded) {
      await showOnboarding();
      secStatus = await safeCall(api.securityStatus); // onboarding may have turned on encryption
    }
  }
  updateLockButton(secStatus.ok && secStatus.encrypted);
  updatePrivacyEncryptionLine(secStatus.ok && secStatus.encrypted);

  const qRes = await safeCall(api.getQuestions);
  if (qRes.ok && Array.isArray(qRes.questions) && qRes.questions.length) { questions = qRes.questions; knownTitles = qRes.knownTitles || {}; }

  const tRes = await safeCall(api.getTemplates);
  if (tRes.ok && Array.isArray(tRes.templates) && tRes.templates.length) templates = tRes.templates;

  const gRes = await safeCall(api.getGuided);
  const guidedPref = gRes.ok ? gRes.guided : false;

  const alRes = await safeCall(api.getAutoLock);
  autoLockMinutes = alRes.ok ? alRes.minutes : 15;

  const doRes = await safeCall(api.getDaysOff);
  daysOff = doRes.ok ? doRes.days : [];

  const bkRes = await safeCall(api.getBackup);
  if (bkRes.ok) { backupCfg = bkRes.backup; renderBackup(); }

  const remRes = await safeCall(api.getReminder);
  if (remRes.ok) {
    $('reminder-toggle').checked = remRes.reminder.enabled;
    $('reminder-time').value = remRes.reminder.time;
    $('reminder-time').disabled = !remRes.reminder.enabled;
  }

  // startedOn (stamped by finishOnboarding) drives the gentle starter-week hint.
  const startRes = await safeCall(api.getStartedOn);
  if (startRes.ok) startedOn = startRes.startedOn || '';

  const res = await safeCall(api.load);
  $('app').hidden = false;
  if (!res.ok) { loadFailed = true; showLoadErrorNotice(res.error); }
  else if (res.locked) { loadFailed = true; showLoadErrorNotice('The journal is locked. Reopen Flint and unlock it to keep writing.'); if (res.paths) paths = res.paths; }
  else { data = res.data; paths = res.paths; if (res.warning) showNotice(res.warning); }
  if (paths) $('data-path').textContent = paths.dataFile;

  buildDayMarker();
  const wk = $('cal-weekdays'); for (const w of WEEKDAYS) { const s = document.createElement('span'); s.textContent = w; wk.append(s); }

  const today = new Date(); calYear = today.getFullYear(); calMonth = today.getMonth();
  loadEditor(todayISO());
  appReady = true; // from here a close should honour real unsaved-word checks
  resetAutoLockTimer();
  await setGuidedMode(guidedPref, false);
  renderCount(); renderCalendar();
  updateEmptyHelpers();
  maybeShowGreeting();

  if (needGate) $('note').focus();

  // editor inputs
  $('note').addEventListener('input', () => { autosize($('note')); updateEmptyHelpers(); });
  $('save-btn').addEventListener('click', () => saveCurrent());
  $('delete-btn').addEventListener('click', () => deleteDay(currentDate));
  $('tag-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTagFromInput(); }
    else if (e.key === 'Backspace' && !e.target.value && currentTags.length) { currentTags.pop(); renderTags(); }
  });
  $('tag-input').addEventListener('blur', addTagFromInput);
  $('guided-btn').addEventListener('click', () => setGuidedMode(!guided));
  $('tpl-btn').addEventListener('click', toggleTplMenu);
  $('preview-btn').addEventListener('click', () => setPreview(!previewOn));

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (!modalIsOpen() && !openPanelEl) saveCurrent(); }
    else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); setFocusMode(!focusMode); }
    else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); if (!modalIsOpen()) quickCapture(); }
    else if (e.key === 'Escape' && focusMode && !modalIsOpen() && !openPanelEl) { e.preventDefault(); setFocusMode(false); }
  });
  $('focus-btn').addEventListener('click', () => setFocusMode(!focusMode));

  // Any sign of life postpones the auto-lock.
  for (const ev of ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart']) {
    document.addEventListener(ev, resetAutoLockTimer, { passive: true });
  }

  // calendar
  $('cal-prev').addEventListener('click', () => gotoMonth(-1));
  $('cal-next').addEventListener('click', () => gotoMonth(1));
  $('cal-today').addEventListener('click', () => selectDay(todayISO()));
  let searchTimer = null;
  $('search-input').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(onSearch, 150); });

  // top bar
  $('theme-btn').addEventListener('click', toggleTheme);
  $('settings-btn').addEventListener('click', () => { renderSecuritySettings(); renderDaysOff(); startPromptsEditor(); startTemplatesEditor(); showSettingsCat('appearance'); openPanel($('settings-panel')); });
  for (const btn of document.querySelectorAll('#settings-nav .settings-nav-item')) btn.addEventListener('click', () => showSettingsCat(btn.dataset.cat));
  $('quick-btn').addEventListener('click', quickCapture);
  $('stats-btn').addEventListener('click', () => { renderStats(); openPanel($('stats-panel')); });
  $('privacy-btn').addEventListener('click', () => openPanel($('privacy-panel')));
  $('lock-btn').addEventListener('click', relock);
  $('streak').addEventListener('click', toggleStreakPop);
  $('panel-scrim').addEventListener('click', closePanel);
  for (const btn of document.querySelectorAll('[data-close]')) btn.addEventListener('click', closePanel);

  // settings panel controls
  wireThemeChoice($('theme-choice'));
  $('guided-toggle').addEventListener('change', () => setGuidedMode($('guided-toggle').checked));
  $('reminder-toggle').addEventListener('change', saveReminder);
  $('reminder-time').addEventListener('change', saveReminder);
  $('backup-toggle').addEventListener('change', () => saveBackupCfg({ ...backupCfg, enabled: $('backup-toggle').checked }));
  $('backup-choose-btn').addEventListener('click', async () => {
    // Main picks and stores the folder itself; we only get back the result.
    const res = await safeCall(api.chooseBackupFolder);
    if (res.canceled) return;
    if (!res.ok) { $('backup-status').textContent = res.error || 'That folder could not be used.'; return; }
    backupCfg = res.backup;
    renderBackup();
    $('backup-status').textContent = 'On. Flint will keep a dated copy there once a day.';
  });
  $('backup-now-btn').addEventListener('click', async () => {
    $('backup-status').textContent = 'Copying…';
    const res = await safeCall(api.runBackupNow);
    if (res.ok) { $('backup-status').textContent = `Copied to ${res.path}`; const g = await safeCall(api.getBackup); if (g.ok) backupCfg = g.backup; }
    else $('backup-status').textContent = res.error || 'That copy did not work.';
  });
  $('prompt-add-btn').addEventListener('click', () => { promptDraft.push({ key: null, title: '', hint: '' }); renderPromptsEditor(); const inputs = $('prompts-list').querySelectorAll('.prompt-title'); if (inputs.length) inputs[inputs.length - 1].focus(); });
  $('prompt-save-btn').addEventListener('click', savePrompts);
  $('prompt-reset-btn').addEventListener('click', () => { startPromptsEditor(); renderPromptsEditor('Changes discarded.'); });
  $('tpl-add-btn').addEventListener('click', () => { tplDraft.push({ name: '', body: '' }); renderTemplatesEditor(); const inputs = $('templates-list').querySelectorAll('.tpl-name'); if (inputs.length) inputs[inputs.length - 1].focus(); });
  $('tpl-save-btn').addEventListener('click', saveTemplatesEdits);
  $('tpl-reset-btn').addEventListener('click', () => { startTemplatesEditor(); renderTemplatesEditor('Changes discarded.'); });
  $('export-file-btn').addEventListener('click', exportToFile);
  $('export-pdf-btn').addEventListener('click', exportToPdf);
  $('export-md-btn').addEventListener('click', exportToMarkdown);
  $('export-json-btn').addEventListener('click', exportToJson);
  $('export-copy-btn').addEventListener('click', copyAll);
  $('import-json-btn').addEventListener('click', importJson);
  $('open-folder-btn').addEventListener('click', () => api.openDataFolder());
  $('reset-btn').addEventListener('click', resetEverything);
  $('foot-feedback').addEventListener('click', sendFeedback);

  // updates
  api.onUpdateStatus(handleUpdateStatus);
  const verRes = await safeCall(api.appVersion);
  $('version-line').textContent = verRes.ok ? `Flint version ${verRes.version}` : 'Flint';
  const updSetting = await safeCall(api.getUpdateSetting);
  $('update-toggle').checked = updSetting.ok ? updSetting.enabled : true;
  $('update-toggle').addEventListener('change', async () => { const on = $('update-toggle').checked; await safeCall(api.setUpdateSetting, on); setUpdateSettingStatus(on ? 'Flint will check for a new version when it opens.' : 'Update checks are off, Flint stays fully offline.'); });
  $('update-check-btn').addEventListener('click', () => { setUpdateSettingStatus('Checking…'); api.updateCheck(); });

  // menu bridge (the close-guard bridges are registered near the top of init)
  api.onMenu((action) => {
    if (modalIsOpen()) return;
    if (action === 'save') saveCurrent();
    if (action === 'export') exportToFile();
    if (action === 'export-pdf') exportToPdf();
  });

  renderWriterHead();
}

init();
