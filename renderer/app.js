'use strict';

/* Flint renderer. All persistence goes through window.journal (preload IPC).
   The app is a two-pane note journal: a calendar navigator (left) and a
   free-form writing area (right), plus slide-in Settings and Privacy panels. */

const api = window.journal;

let questions = (window.DEFAULT_QUESTIONS || []).map((q) => ({ ...q }));
let knownTitles = {};
// True when the prompts/templates/activities on screen are the built-in
// defaults standing in for a set we could not read, rather than the person's
// own. Saving in that state would overwrite their real ones with the defaults,
// so every editor that writes these checks it first.
let contentReadOnly = false;
let contentReadError = '';
let activityChoices = (window.DEFAULT_ACTIVITIES || []).slice(); // replaced from settings at init
const MARKERS = window.DAY_MARKERS || [
  { key: 'good', label: 'Good day', short: 'Good' }, { key: 'mixed', label: 'Mixed day', short: 'Mixed' }, { key: 'hard', label: 'Bad day', short: 'Bad' }
];
const TRAJ_MARKERS = window.TRAJECTORY_MARKERS || [
  { key: 'up', label: 'Easier than usual', short: 'Easier' }, { key: 'same', label: 'About the same', short: 'Same' }, { key: 'down', label: 'Harder than usual', short: 'Harder' }
];
const MAX_TAGS = 20;
const MAX_TAG_LEN = 40;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

let data = { version: 1, entries: {} };
let paths = null;
let currentDate = todayISO();
let currentDay = '';
let currentTags = [];
let currentFeelings = [];           // optional named feelings for the open day
let currentActivities = [];         // optional activities tapped for the open day
let currentTrend = '';              // optional "compared with usual" marker
let currentFav = false;             // whether the open day is favourited
let guided = false;                 // show the optional guided prompts
let snapshot = { note: '', answers: {}, day: '', tags: [] };
let loadFailed = false;
let saving = false;
let appReady = false;               // true once the editor is loaded (gate/onboarding done)
let calYear, calMonth;              // month currently shown in the calendar

/* autosave: a periodic save; a quiet top-bar dot shows the state and last-saved time */
let autosaveHeartbeat = null;       // 1s tick: fires the periodic save and keeps the dot in step
let autosaveDeadline = 0;           // when the next save is due (epoch ms); 0 = nothing pending
let autosaveIntervalMs = 30000;     // how often to save while words are unsaved (configurable)
let lastSavedAt = 0;                // epoch ms of the last successful save, for the hover text
let indicatorState = '';            // last-rendered indicator state, to skip DOM churn
let pulseTimer = null;              // clears the save-pulse animation class
let deleting = false;               // a day removal is mid-flight; hold autosave off
let loadedTodayWritten = false;     // was today already written when this day was opened

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
function entryFeelings(entry) {
  return entry && Array.isArray(entry.__feelings) ? entry.__feelings.filter((f) => typeof f === 'string' && f.trim()) : [];
}
function entryActivities(entry) {
  return entry && Array.isArray(entry.__activities) ? entry.__activities.filter((a) => typeof a === 'string' && a.trim()) : [];
}
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
  if (entry.__trend) return true;
  if (entryTags(entry).length) return true;
  if (entryFeelings(entry).length) return true;
  if (entryActivities(entry).length) return true;
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
    b.textContent = 'This is added to the end of today, with the time in front of it. Press Enter to add it (Shift and Enter for a new line).';
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
      else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (ta.value.trim()) close(ta.value); }
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
    ta.addEventListener('input', () => { autosize(ta); scheduleAutosave(); });
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
// Offer the tags already in use. Without this, "migraine" and "migraines" become
// two tags that each stay below the threshold Patterns needs to show anything,
// and nothing ever explains why.
function renderTagSuggestions() {
  const box = $('tag-suggest'); if (!box) return;
  const counts = new Map();
  for (const entry of Object.values(data.entries)) {
    for (const t of entryTags(entry)) counts.set(t, (counts.get(t) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 50);
  box.textContent = '';
  for (const [tag] of sorted) { const o = document.createElement('option'); o.value = tag; box.append(o); }
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

/* feelings (optional emotion picker) */

const MAX_FEELINGS = 6;
const FEELING_WORDS = window.FEELINGS || [];
const FEELING_GROUPS = window.FEELING_QUADRANTS || [];

function renderFeelings() {
  const list = $('feelings-list'); if (!list) return;
  list.textContent = '';
  currentFeelings.forEach((word, i) => {
    const chip = document.createElement('span'); chip.className = 'tag-chip feeling-chip';
    const text = document.createElement('span'); text.textContent = word;
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'tag-remove';
    remove.setAttribute('aria-label', `Remove feeling ${word}`); remove.textContent = '×';
    remove.addEventListener('click', () => { currentFeelings.splice(i, 1); renderFeelings(); syncFeelingsPicker(); });
    chip.append(text, remove); list.append(chip);
  });
}

function buildFeelingsPicker() {
  const box = $('feelings-picker'); if (!box) return;
  box.textContent = '';
  for (const quad of FEELING_GROUPS) {
    const group = document.createElement('div'); group.className = 'feeling-group';
    const h = document.createElement('p'); h.className = 'feeling-group-label soft small'; h.textContent = quad.label;
    const words = document.createElement('div'); words.className = 'feeling-words';
    for (const f of FEELING_WORDS.filter((x) => x.quad === quad.key)) {
      const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'feeling-word'; btn.dataset.word = f.word; btn.textContent = f.word;
      const on = currentFeelings.includes(f.word);
      btn.setAttribute('aria-pressed', String(on)); btn.classList.toggle('is-on', on);
      btn.addEventListener('click', () => toggleFeeling(f.word, btn));
      words.append(btn);
    }
    group.append(h, words); box.append(group);
  }
}
function syncFeelingsPicker() {
  const box = $('feelings-picker'); if (!box || box.hidden) return;
  for (const btn of box.querySelectorAll('.feeling-word')) {
    const on = currentFeelings.includes(btn.dataset.word);
    btn.classList.toggle('is-on', on); btn.setAttribute('aria-pressed', String(on));
  }
}
function toggleFeeling(word, btn) {
  const i = currentFeelings.indexOf(word);
  if (i >= 0) currentFeelings.splice(i, 1);
  else { if (currentFeelings.length >= MAX_FEELINGS) return; currentFeelings.push(word); }
  if (btn) { const on = currentFeelings.includes(word); btn.classList.toggle('is-on', on); btn.setAttribute('aria-pressed', String(on)); }
  renderFeelings();
}
function toggleFeelingsPicker() {
  const box = $('feelings-picker'); if (!box) return;
  if (!box.hidden) { closeFeelingsPicker(); return; }
  buildFeelingsPicker();
  box.hidden = false;
  // The button reads "Done" while the list is open, so it is obvious that the
  // same button closes it again.
  const btn = $('feelings-add'); if (btn) { btn.setAttribute('aria-expanded', 'true'); btn.textContent = 'Done'; }
}
function closeFeelingsPicker() {
  const box = $('feelings-picker'); if (!box) return;
  box.hidden = true;
  const btn = $('feelings-add'); if (btn) { btn.setAttribute('aria-expanded', 'false'); btn.textContent = 'Add a feeling'; }
}

/* favourite (star a day) */

function renderFav() {
  const btn = $('fav-btn'); if (!btn) return;
  btn.classList.toggle('is-on', currentFav);
  btn.setAttribute('aria-pressed', String(currentFav));
}
function toggleFav() { currentFav = !currentFav; renderFav(); }

/* trajectory marker (how today compared with usual) */

function buildTrendMarker() {
  const holder = $('trend-marker'); if (!holder) return;
  holder.textContent = '';
  for (const m of TRAJ_MARKERS) {
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'marker-btn';
    btn.dataset.key = m.key; btn.textContent = m.short; btn.setAttribute('aria-pressed', 'false');
    btn.title = m.label;
    btn.addEventListener('click', () => { currentTrend = currentTrend === m.key ? '' : m.key; renderTrendMarker(); updateEmptyHelpers(); });
    holder.append(btn);
  }
}
function renderTrendMarker() {
  const holder = $('trend-marker'); if (!holder) return;
  for (const btn of holder.querySelectorAll('.marker-btn')) {
    const on = btn.dataset.key === currentTrend;
    btn.classList.toggle('is-on', on); btn.setAttribute('aria-pressed', String(on));
  }
}

/* activities (optional "what did today hold?" picker) */

function renderActivities() {
  const list = $('activities-list'); if (!list) return;
  list.textContent = '';
  currentActivities.forEach((label, i) => {
    const chip = document.createElement('span'); chip.className = 'tag-chip feeling-chip';
    const text = document.createElement('span'); text.textContent = label;
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'tag-remove';
    remove.setAttribute('aria-label', `Remove ${label}`); remove.textContent = '×';
    remove.addEventListener('click', () => { currentActivities.splice(i, 1); renderActivities(); syncActivitiesPicker(); });
    chip.append(text, remove); list.append(chip);
  });
}
function buildActivitiesPicker() {
  const box = $('activities-picker'); if (!box) return;
  box.textContent = '';
  const words = document.createElement('div'); words.className = 'feeling-words';
  for (const label of activityChoices) {
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'feeling-word'; btn.dataset.activity = label; btn.textContent = label;
    const on = currentActivities.includes(label);
    btn.setAttribute('aria-pressed', String(on)); btn.classList.toggle('is-on', on);
    btn.addEventListener('click', () => toggleActivity(label, btn));
    words.append(btn);
  }
  box.append(words);
}
function syncActivitiesPicker() {
  const box = $('activities-picker'); if (!box || box.hidden) return;
  for (const btn of box.querySelectorAll('.feeling-word')) {
    const on = currentActivities.includes(btn.dataset.activity);
    btn.classList.toggle('is-on', on); btn.setAttribute('aria-pressed', String(on));
  }
}
function toggleActivity(label, btn) {
  const i = currentActivities.indexOf(label);
  if (i >= 0) currentActivities.splice(i, 1);
  else currentActivities.push(label);
  if (btn) { const on = currentActivities.includes(label); btn.classList.toggle('is-on', on); btn.setAttribute('aria-pressed', String(on)); }
  renderActivities();
}
function toggleActivitiesPicker() {
  const box = $('activities-picker'); if (!box) return;
  if (!box.hidden) { closeActivitiesPicker(); return; }
  buildActivitiesPicker();
  box.hidden = false;
  const btn = $('activities-add'); if (btn) { btn.setAttribute('aria-expanded', 'true'); btn.textContent = 'Done'; }
}
function closeActivitiesPicker() {
  const box = $('activities-picker'); if (!box) return;
  box.hidden = true;
  const btn = $('activities-add'); if (btn) { btn.setAttribute('aria-expanded', 'false'); btn.textContent = 'Add activities'; }
}

function noteValue() { return $('note').value; }
function collectAnswers() {
  const v = {};
  if (guided) for (const q of questions) { const el = $(`box-${q.key}`); if (el) v[q.key] = el.value; }
  return v;
}
function currentState() { return { note: noteValue(), answers: collectAnswers(), day: currentDay, trend: currentTrend, tags: currentTags.slice(), feelings: currentFeelings.slice(), activities: currentActivities.slice(), fav: currentFav }; }

function isDirty() {
  if (!appReady) return false; // during the gate / onboarding there is nothing to save
  const s = currentState();
  if (s.note !== snapshot.note) return true;
  if (s.day !== snapshot.day) return true;
  if (s.trend !== (snapshot.trend || '')) return true;
  if (s.tags.join('\n') !== snapshot.tags.join('\n')) return true;
  if (s.feelings.join('\n') !== (snapshot.feelings || []).join('\n')) return true;
  if (s.activities.join('\n') !== (snapshot.activities || []).join('\n')) return true;
  if (s.fav !== Boolean(snapshot.fav)) return true;
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
  if (currentTrend) entry.__trend = currentTrend;
  if (currentTags.length) entry.__tags = currentTags.slice();
  if (currentFeelings.length) entry.__feelings = currentFeelings.slice();
  if (currentActivities.length) entry.__activities = currentActivities.slice();
  if (currentFav) entry.__fav = true;
  // Photos can no longer be added, but any attached by an older version are kept
  // as they were rather than dropped on the next save.
  if (prev && Array.isArray(prev.__media) && prev.__media.length) entry.__media = prev.__media.map((m) => ({ ...m }));
  return entry;
}
// A favourite flag on its own is not "content": you favourite a day you wrote,
// not an empty one, so a lone star never conjures a phantom entry.
function entryHasAny(entry) {
  if (entry.__day) return true;
  if (entry.__trend) return true;
  if (Array.isArray(entry.__tags) && entry.__tags.length) return true;
  if (Array.isArray(entry.__feelings) && entry.__feelings.length) return true;
  if (Array.isArray(entry.__activities) && entry.__activities.length) return true;
  if (Array.isArray(entry.__media) && entry.__media.length) return true;
  for (const k of Object.keys(entry)) { if (isReservedKey(k)) continue; if (typeof entry[k] === 'string' && entry[k].trim()) return true; }
  return false;
}

function loadEditor(dateIso) {
  cancelAutosave(); // a pending tick must not write the old day into the new one
  currentDate = dateIso;
  promptOffset = 0;
  const entry = data.entries[dateIso] || {};
  // Remember whether today was already written when opened, so the "that is
  // today done" milestone fires on the writer's own save, not on an autosave.
  loadedTodayWritten = dateIso === todayISO() && entryHasAnyContent(entry);
  $('note').value = entryNote(entry);
  autosize($('note'));
  currentDay = typeof entry.__day === 'string' ? entry.__day : '';
  currentTrend = typeof entry.__trend === 'string' ? entry.__trend : '';
  currentTags = entryTags(entry).slice();
  currentFeelings = entryFeelings(entry).slice();
  currentActivities = entryActivities(entry).slice();
  currentFav = entry.__fav === true;
  $('tag-input').value = '';
  renderDayMarker(); renderTrendMarker(); renderTags(); renderFeelings(); renderActivities(); renderFav(); closeFeelingsPicker(); closeActivitiesPicker();
  if (guided) { buildPromptSections(); for (const q of questions) { const el = $(`box-${q.key}`); if (el) { el.value = typeof entry[q.key] === 'string' ? entry[q.key] : ''; autosize(el); } } }
  snapshot = currentState();
  // keep the calendar showing the month of the day being edited
  const d = new Date(dateIso + 'T00:00:00'); calYear = d.getFullYear(); calMonth = d.getMonth();
  renderWriterHead();
  renderLookback();
  setExtrasOpen(false); // each day opens tidy; syncExtras reopens it if this day needs it
  renderTagSuggestions();
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
  renderPromptNudge(empty);
  renderWordCount();
  syncExtras();
}

// A running word count, quiet and never a target: it sits beside the date and
// says nothing at all until there is something to count.
function renderWordCount() {
  const el = $('word-count'); if (!el) return;
  const n = noteValue().split(/\s+/).filter(Boolean).length;
  el.textContent = n ? `${n} ${n === 1 ? 'word' : 'words'}` : '';
}

/* The writer's optional extras. Only "How was today?" is on show: the follow-up
   "compared with usual" question needs a baseline to compare against, so it
   appears once the day has a marker, and tags, feelings and activities sit
   behind one disclosure. A blank page should look like a blank page, not a
   form. A day that already carries any of them opens the disclosure itself, so
   nothing is ever hidden from the person who wrote it. */
let extrasOpen = false;
function setExtrasOpen(open) {
  extrasOpen = !!open;
  const more = $('extras-more'); if (more) more.hidden = !extrasOpen;
  const btn = $('extras-toggle');
  if (btn) {
    btn.setAttribute('aria-expanded', String(extrasOpen));
    btn.textContent = extrasOpen ? 'Hide tags, feelings and activities' : 'Add tags, a feeling, or what today held';
  }
}
function dayHasExtras() {
  return currentTags.length > 0 || currentFeelings.length > 0 || currentActivities.length > 0;
}
// Never closes what the writer opened, and never hides a day's own content.
function syncExtras() {
  const trend = $('trend-block');
  if (trend) trend.hidden = !(currentDay || currentTrend);
  if (dayHasExtras() && !extrasOpen) setExtrasOpen(true);
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
  // One welcome at a time. The greeting is already a warm word about the blank
  // page, and stacking the nudge under it made a blank day speak twice.
  const greeting = $('greeting');
  if (greeting && !greeting.hidden) { box.hidden = true; box.textContent = ''; return; }
  const p = nudgePrompt();
  if (!p) { box.hidden = true; box.textContent = ''; return; }
  box.textContent = '';
  const lead = document.createElement('span'); lead.className = 'nudge-lead'; lead.textContent = 'Not sure where to start?';
  const text = document.createElement('p'); text.className = 'nudge-text'; text.textContent = p.text;
  const row = document.createElement('div'); row.className = 'nudge-actions';
  const use = document.createElement('button'); use.type = 'button'; use.className = 'ghost small'; use.textContent = 'Start with this';
  use.addEventListener('click', () => useNudgePrompt(p.text));
  const another = document.createElement('button'); another.type = 'button'; another.className = 'linklike'; another.textContent = 'Show me another';
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
let hiddenAt = 0;          // when the window went to the tray. Memory only, never saved.
let suppressAwayOnce = false; // the gate already said it; do not say it twice
let trayReturnPending = false; // unlocking after a tray return should land on today

// Deliberately vague, and it gets vaguer with time rather than more precise.
// An exact day count turns this into a score against a target Flint never set,
// and someone coming back after a year needs the least arithmetic, not the most.
// This is a statement about where the window was, never about the person: it
// says "Flint has been in the tray", never "you have been away". If you are
// editing this copy, that distinction is the whole reason the line is allowed
// to exist. Never mention the streak here, and never build a notification on it.
const AWAY_MIN_MS = 8 * 60 * 60 * 1000;
function awayPhrase(ms) {
  const h = ms / 3600000, d = h / 24;
  if (h < 8) return '';
  if (h < 36) return 'since yesterday';
  if (d < 7) return 'for a few days';
  if (d < 14) return 'for about a week';
  if (d < 28) return 'for a couple of weeks';
  if (d < 56) return 'for about a month';
  if (d < 180) return 'for a few months';
  return 'for a while';
}

// A single, soft, dismissible line: warm if it has been a while, or a clean-page
// note on a new week. Never counts what was missed, never fires if today is
// already written or there is no history yet. Shown at most once per launch.
function maybeShowGreeting() {
  if (greetingShown || !appReady) return;
  const box = $('greeting'); if (!box) return;
  // Consume these BEFORE the early returns below. They used to be cleared at the
  // bottom, so on any day the greeting did not appear (today already written,
  // no history yet) the suppression flag survived and swallowed the away line on
  // a later tray return, which is the one place it would have been said.
  const awayMs = hiddenAt ? Date.now() - hiddenAt : 0;
  const suppressed = suppressAwayOnce;
  hiddenAt = 0;
  suppressAwayOnce = false;
  const today = todayISO();
  if (entryHasAnyContent(data.entries[today])) return;
  const written = Object.keys(data.entries).filter((d) => d < today && entryHasAnyContent(data.entries[d])).sort();
  if (!written.length) return;

  // Suppressed during the starter week, when someone is still finding their feet
  // and does not need to hear how long anything has been. awayMs and the
  // suppression flag were both consumed at the top of this function.
  const away = (suppressed || inStarterWeek()) ? '' : awayPhrase(awayMs);

  const last = written[written.length - 1];
  let msg = '';
  if (away) {
    msg = `Welcome back. Flint has been in the tray ${away}. Today's page is ready whenever you are.`;
  } else if (daysBetween(last, today) >= 4) {
    msg = 'Welcome back. It has been a little while, and that is completely fine. Your page is here whenever you are.';
  } else if (mondayOf(last) !== mondayOf(today)) {
    msg = 'A new week, and a clean page whenever you want it.';
  }
  if (!msg) return;
  greetingShown = true;
  box.textContent = '';
  const p = document.createElement('p'); p.className = 'greeting-text'; p.textContent = msg;
  if (away && awayMs) {
    // The exact moment lives here and nowhere else, for anyone who wants it.
    const when = new Date(Date.now() - awayMs);
    p.title = `Last open on ${when.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })} at ${when.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
  }
  const open = document.createElement('button');
  open.type = 'button'; open.className = 'ghost small greeting-open'; open.textContent = 'Open today';
  open.addEventListener('click', () => {
    box.hidden = true; box.textContent = '';
    selectDay(todayISO());
    $('note').focus();
    updateEmptyHelpers();
  });
  const close = document.createElement('button'); close.type = 'button'; close.className = 'greeting-close';
  close.setAttribute('aria-label', 'Dismiss'); close.textContent = '×';
  close.addEventListener('click', () => { box.hidden = true; box.textContent = ''; updateEmptyHelpers(); });
  box.append(p, open, close);
  box.hidden = false;
  updateEmptyHelpers(); // the nudge stands down while the greeting is showing, and returns when it goes
}

// The one place words reach disk. Ctrl+S uses the defaults; autosave and the
// checkpoint saves pass options:
//   quiet       - say nothing at all unless the day crosses into "written"
//   backup      - false on autosave ticks so the 30-copy ring is not churned
//   allowDelete - false on autosave ticks so a mid-rewrite clear never deletes
//                 the day on disk (a deliberate save/day-switch still does)
//   silentError - a legible status instead of a focus-stealing modal on failure
async function saveCurrent(opts = {}) {
  const { quiet = false, backup = true, allowDelete = true, silentError = false } = opts;
  if (saving) return false;
  if (loadFailed) {
    if (silentError) return false; // saving is deliberately off; do not nag on a tick
    await showModal({
      title: 'Saving is switched off for now', body: 'Your journal file could not be opened when the app started, so saving is blocked to protect the entries already on disk.\n\nEverything you typed is still on the page. Use "Try loading again" in the notice at the top.', buttons: [{ label: 'Back to my writing', value: 'ok', kind: 'primary' }]
    });
    return false;
  }
  saving = true;
  try {
    // Capture the page as it is NOW, in the same breath as the entry we are
    // about to write, and pin the date too. The snapshot used to be re-read from
    // the DOM after the await, so anything typed while the save was in flight
    // was recorded as saved without ever reaching disk: isDirty() then said
    // clean, autosave stood down, and the close guard let those words go with no
    // prompt. Autosave is a fixed ceiling, not a debounce, so it is designed to
    // fire mid-sentence and this was reachable every time it did.
    const savingDate = currentDate;
    const state = currentState();
    const existed = Object.prototype.hasOwnProperty.call(data.entries, savingDate);
    const previous = existed ? data.entries[savingDate] : undefined;
    const entry = buildEntry(previous);
    const hasContent = entryHasAny(entry);
    const isToday = savingDate === todayISO();
    if (!hasContent) {
      // Refresh the snapshot even here, or a page holding only whitespace stays
      // "unsaved" for the whole sitting, re-arming a no-op save every interval.
      if (!existed) { if (!quiet) setStatus('Nothing written for this day yet.'); if (savingDate === currentDate) snapshot = state; return true; }
      // A cleared note pausing mid-rewrite must not delete the day out from under
      // the writer. Only a deliberate save or day-switch removes an emptied day.
      if (!allowDelete) return true;
      delete data.entries[savingDate];
    } else {
      entry.updatedAt = new Date().toISOString();
      data.entries[savingDate] = entry;
    }
    const res = await safeCall(api.save, data, { backup });
    if (res.ok) {
      // Only claim the page is saved if it is still the page we saved. A day
      // switch during the write would otherwise mark the new day clean.
      if (savingDate === currentDate) snapshot = state;
      lastSavedAt = Date.now();
      if (hasContent) pulseIndicator(); // a soft flash on the top-bar dot when a write lands
      // A quiet, warmer note the first time today crosses into "written", however
      // that save happened. Routine saves now say nothing: the top-bar dot is the
      // running report, so a status line would only be noise. Understated: a nod,
      // not a fanfare.
      const madeTodayWritten = hasContent && isToday && !loadedTodayWritten;
      if (madeTodayWritten) {
        setStatus('Saved. That is today done.');
        loadedTodayWritten = true;
      } else if (!quiet) {
        setStatus(hasContent ? 'Saved.' : 'This day has been removed.');
      }
      // Tell main which day now has words in it, so the evening reminder does not
      // nag about a day already written. In tray mode the journal is usually
      // locked by then, and a locked journal cannot be checked. A date only.
      if (hasContent && isToday && api.noteWritten) api.noteWritten(savingDate);
      if (res.backupWarning) showNotice(res.backupWarning);
      renderWriterHead(); renderCount(); renderCalendar(); renderTagSuggestions(); updateEmptyHelpers();
      return true;
    }
    // Roll back the day we actually touched, not whichever day is open now.
    if (existed) data.entries[savingDate] = previous; else delete data.entries[savingDate];
    if (silentError) {
      setStatus('Not saved yet. Your words are safe on the page and will save on your next pause.', { error: true, sticky: true });
      return false;
    }
    setStatus('Not saved, see the message.', { error: true, sticky: true });
    await showModal({
      title: 'Your words could not be saved', body: (res.error || 'Something went wrong writing to disk.') + '\n\nNothing has been lost. Everything you typed is still on the page, so please try saving again.', buttons: [{ label: 'Back to my writing', value: 'ok', kind: 'primary' }]
    });
    return false;
  } finally { saving = false; }
}

// Autosave: a trailing debounce (a save shortly after you pause), a steady
// ceiling so continuous writing still lands, and immediate flushes at the
// moments words are most at risk (leaving the editor, hiding the window,
// switching day, closing). Every path funnels through saveCurrent() so it
// inherits the saving guard, the locked-vault and loadFailed refusals, the
// empty-day rule and the snapshot reset. Ticks suppress the backup.
function canAutosave() {
  if (!appReady || loadFailed || saving || deleting) return false;
  const gate = $('pin-gate'); if (gate && gate.hidden === false) return false;
  if (modalIsOpen() || openPanelEl) return false;
  return true;
}
// The heartbeat runs once a second for the app's lifetime. It fires the periodic
// save when the deadline is reached and keeps the top-bar dot in step. The
// deadline is set ONCE when the first unsaved second begins and is not pushed
// back by later keystrokes (that would be a debounce). Arming off isDirty()
// rather than off keystrokes keeps discrete edits (mood, tags, a star) covered.
// A window left open overnight kept writing into yesterday, with the header
// still reading "Today". currentDate was only ever reset by opening a day or by
// returning from the tray, and neither happens if nobody touches the window, so
// a morning entry was silently merged into the previous day: today looked
// unwritten and the streak broke. The heartbeat is the only thing running, so it
// is the only thing that can notice.
let heartbeatDay = todayISO();
function checkDayRollover() {
  const today = todayISO();
  if (today === heartbeatDay) return;
  heartbeatDay = today;
  if (currentDate === today) return;
  // A clean page can simply move. A page with unsaved words must not be yanked
  // out from under whoever is writing, so it keeps them and the heading stops
  // claiming to be today.
  if (!isDirty()) { selectDay(today); return; }
  renderWriterHead();
  setStatus('It is past midnight, so this page is yesterday now. It will save to that day.');
}

function tickAutosave() {
  checkDayRollover();
  if (!canAutosave()) { renderIndicator('paused'); return; }
  if (!isDirty()) { autosaveDeadline = 0; renderIndicator('saved'); return; }
  renderIndicator('dirty');
  if (!autosaveDeadline) autosaveDeadline = Date.now() + autosaveIntervalMs;
  if (Date.now() >= autosaveDeadline) flushAutosave();
}
function scheduleAutosave() {
  if (!appReady || loadFailed) return;
  if (!autosaveDeadline) autosaveDeadline = Date.now() + autosaveIntervalMs;
  renderIndicator('dirty');
}
function cancelAutosave() {
  autosaveDeadline = 0;
  renderIndicator('saved');
}
async function flushAutosave() {
  autosaveDeadline = 0;
  // "Cannot save right now" and "nothing to save" are different things, and
  // painting the saved dot for both told the writer their words were on disk
  // when the flush had actually declined.
  if (!canAutosave()) { renderIndicator(isDirty() ? 'paused' : 'saved'); return; }
  if (!isDirty()) { renderIndicator('saved'); return; }
  await saveCurrent({ quiet: true, backup: false, allowDelete: false, silentError: true });
  renderIndicator(isDirty() ? 'dirty' : 'saved');
}

// Closing to the tray is the one close with no save prompt behind it, so it has
// to save whatever the ordinary guard would hold back. An open panel or modal is
// a good reason to defer a routine tick (someone is still here) and a bad reason
// to let a window disappear with unsaved words in it. The error stays silent
// because the window is already gone: a modal nobody can see would also wedge
// canAutosave() for the rest of the session.
async function flushForHide() {
  autosaveDeadline = 0;
  if (!appReady || loadFailed || deleting) return;
  const gate = $('pin-gate'); if (gate && gate.hidden === false) return;
  for (let i = 0; i < 20 && saving; i++) await new Promise((r) => setTimeout(r, 15));
  if (saving || !isDirty()) return;
  await saveCurrent({ quiet: true, backup: true, allowDelete: false, silentError: true });
}

// The top-bar autosave dot: filled when everything is saved, a hollow outline
// while there are unsaved words, faint when saving is held off. Hovering it
// shows when the last save happened. A soft pulse marks each write.
function renderIndicator(state) {
  const ind = $('autosave-ind'); if (!ind) return;
  if (indicatorState === state) return;
  indicatorState = state;
  ind.classList.toggle('is-saved', state === 'saved');
  ind.classList.toggle('is-dirty', state === 'dirty');
  ind.classList.toggle('is-paused', state === 'paused');
  ind.setAttribute('aria-label', autosaveHoverText());
}
function pulseIndicator() {
  const ind = $('autosave-ind'); if (!ind) return;
  ind.classList.remove('is-flash'); void ind.offsetWidth; // restart the animation
  ind.classList.add('is-flash');
  clearTimeout(pulseTimer);
  pulseTimer = setTimeout(() => ind.classList.remove('is-flash'), 600);
}
// A plain-English "how long ago" for the last save, shown on hover.
function agoText(ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return s + ' seconds ago';
  const m = Math.round(s / 60);
  if (m < 60) return m + (m === 1 ? ' minute ago' : ' minutes ago');
  const h = Math.round(m / 60);
  return h + (h === 1 ? ' hour ago' : ' hours ago');
}
function autosaveHoverText() {
  if (loadFailed) return 'Saving is switched off just now';
  if (isDirty()) return lastSavedAt ? 'Unsaved words. Last saved ' + agoText(lastSavedAt) : 'Not saved yet';
  return lastSavedAt ? 'Saved ' + agoText(lastSavedAt) : 'Nothing to save yet';
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

// Called before leaving the open day (opening another day, searching, locking,
// importing, updating). With autosave on there is nothing to prompt about: any
// pending words are written as a real checkpoint (with a backup) before we move.
// If that write fails, saveCurrent shows its modal and we return false so the
// navigation is cancelled and nothing crosses into the wrong day.
async function guardDirty(_actionLabel) {
  cancelAutosave();
  // Let any autosave already in flight settle, so its saving-guard "false" is not
  // mistaken for a save failure that would wrongly block the navigation.
  for (let i = 0; i < 150 && saving; i++) await new Promise((r) => setTimeout(r, 20));
  if (!isDirty()) return true;
  if (saving) {
    // A save is still running after the wait (a stalled disk). Rather than
    // silently swallow the click, keep the writer where they are and say why.
    setStatus('Still saving your words. Give it a moment, then try again.', { error: true, sticky: true });
    return false;
  }
  return await saveCurrent({ quiet: true, backup: true, allowDelete: true });
}

async function deleteDay(date) {
  if (loadFailed) { await saveCurrent(); return; }
  // Hold autosave off across the whole removal: a debounce armed by the last
  // keystroke must not fire during the confirm or the write and re-add the day.
  cancelAutosave();
  deleting = true;
  try {
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
    offerUndoDelete(date, previous);
  } finally { deleting = false; }
}

// Deleting is the one action in Flint with no way back from inside the app:
// the copy in the backups folder is no help at all to someone whose journal is
// encrypted, because they cannot read it. The removed entry is already in hand,
// so hold on to it and offer it back until the writer moves on.
let undoTimer = null;
function clearUndoBar() {
  clearTimeout(undoTimer); undoTimer = null;
  const box = $('undo-bar'); if (!box) return;
  box.hidden = true; box.textContent = '';
}
function offerUndoDelete(date, previous) {
  const box = $('undo-bar'); if (!box || previous === undefined) return;
  clearUndoBar();
  box.textContent = '';
  const p = document.createElement('p'); p.className = 'greeting-text';
  p.textContent = `${longDate(date)} was removed.`;
  const undo = document.createElement('button');
  undo.type = 'button'; undo.className = 'linklike undo-btn'; undo.textContent = 'Undo';
  undo.addEventListener('click', () => undoDelete(date, previous));
  const close = document.createElement('button');
  close.type = 'button'; close.className = 'greeting-close';
  close.setAttribute('aria-label', 'Dismiss'); close.textContent = '×';
  close.addEventListener('click', clearUndoBar);
  box.append(p, undo, close);
  box.hidden = false;
  undoTimer = setTimeout(clearUndoBar, 30000);
}
async function undoDelete(date, previous) {
  clearUndoBar();
  const nowThere = data.entries[date];
  if (nowThere !== undefined && entryHasAnyContent(nowThere)) {
    // Clicking Undo is often enough to recreate the day by itself: the click
    // blurs the note, which flushes an autosave, which writes the entry back
    // before this handler runs. Returning in silence made Undo look broken in
    // exactly the case it is most used, so ask rather than do nothing. Someone
    // pressing Undo is asking for the older version.
    const choice = await showModal({
      title: `Put ${longDate(date)} back?`,
      body: 'Something has been written on that day since you deleted it.\n\nPutting the older version back will replace what is there now.',
      buttons: [
        { label: 'Put the older version back', value: 'replace', kind: 'danger' },
        { label: 'Leave it as it is', value: 'keep', kind: 'primary' }
      ],
      focusValue: 'keep'
    });
    if (choice !== 'replace') { setStatus('Left as it is.'); return; }
  }
  data.entries[date] = previous;
  const res = await safeCall(api.save, data);
  if (!res.ok) {
    if (nowThere === undefined) delete data.entries[date]; else data.entries[date] = nowThere;
    setStatus('That day could not be put back. Nothing else has changed.', { error: true, sticky: true });
    return;
  }
  if (date === currentDate) loadEditor(currentDate);
  renderCount(); renderCalendar(); renderWriterHead();
  setStatus(`${longDate(date)} is back.`);
}

/* guided prompts toggle */

async function setGuidedMode(on, persist = true) {
  // Save FIRST, while the prompt boxes are still on the page and still being
  // read. This function used to reset the snapshot unconditionally at the end,
  // which marked the whole editor clean without writing anything, so pressing
  // this button threw away unsaved work in two different ways:
  //
  //   Prompt answers were destroyed outright. collectAnswers returns {} while
  //   guided is false, and buildEntry then falls back to the stored entry, so no
  //   later save could recover them and toggling back on refilled the boxes from
  //   disk.
  //
  //   The note, mood, tags and feelings were merely declared clean. They stayed
  //   in memory, but isDirty() said false, so autosave stood down and the close
  //   guard let them go without a prompt.
  //
  // Note the fix is here and NOT in collectAnswers. Making it read the boxes
  // regardless of `guided` looks like the tidier root fix and corrupts data:
  // loadEditor only refills those boxes when guided is on, so with prompts off
  // they still hold the PREVIOUS day's answers, which would then be saved onto
  // whatever day is open. That was tested, and it does happen.
  if (persist && isDirty()) {
    const saved = await saveCurrent({ quiet: true, backup: false, allowDelete: false });
    if (!saved) return; // leave the mode, the boxes and the snapshot exactly as they were
  }
  guided = on;
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
  { min: 1, name: 'day one', color: 'oklch(70% 0.19 47)' },
  { min: 3, name: '3 days', color: 'oklch(78% 0.16 72)' },
  { min: 7, name: 'one week', color: 'oklch(83% 0.15 95)' },
  { min: 14, name: 'two weeks', color: 'oklch(66% 0.2 30)' },
  { min: 21, name: 'three weeks', color: 'oklch(72% 0.14 235)' },
  { min: 30, name: 'one month', color: 'oklch(60% 0.19 272)' }
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
  headText.append(title);
  if (count === 0) {
    const hint = document.createElement('p'); hint.className = 'streak-pop-tier';
    hint.textContent = 'Write today to start your streak';
    headText.append(hint);
  }
  head.append(flame, headText);
  pop.append(head);

  // Progress toward the next milestone: days done out of the days it needs, so a
  // 2-day run toward 3 days reads two thirds, not the position within a band.
  const pct = next ? Math.round((count / next.min) * 100) : 100;
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

  // The lifetime total lives in Patterns; repeating it here made the popover a
  // second, smaller stats panel.
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

/* jump to a month: paging one month at a time is fine for last week and useless
   for last year, and the month label was already the obvious thing to click. */
let jumpYear = 0;
function toggleCalJump() {
  const box = $('cal-jump');
  if (!box.hidden) { closeCalJump(); return; }
  jumpYear = calYear;
  renderCalJump();
  box.hidden = false;
  $('cal-label').setAttribute('aria-expanded', 'true');
  document.addEventListener('keydown', calJumpKey, true);
  document.addEventListener('click', calJumpOutside, true);
}
function closeCalJump() {
  const box = $('cal-jump'); if (!box || box.hidden) return;
  box.hidden = true;
  $('cal-label').setAttribute('aria-expanded', 'false');
  document.removeEventListener('keydown', calJumpKey, true);
  document.removeEventListener('click', calJumpOutside, true);
}
function calJumpKey(e) { if (e.key === 'Escape') { e.preventDefault(); closeCalJump(); $('cal-label').focus(); } }
function calJumpOutside(e) { if (!$('cal-jump').contains(e.target) && !$('cal-label').contains(e.target)) closeCalJump(); }
function renderCalJump() {
  const box = $('cal-jump'); box.textContent = '';
  const head = document.createElement('div'); head.className = 'cal-jump-head';
  const prev = document.createElement('button'); prev.type = 'button'; prev.className = 'icon-btn'; prev.setAttribute('aria-label', 'Previous year'); prev.textContent = '‹';
  prev.addEventListener('click', () => { jumpYear--; renderCalJump(); });
  const label = document.createElement('span'); label.className = 'cal-jump-year'; label.textContent = String(jumpYear);
  const next = document.createElement('button'); next.type = 'button'; next.className = 'icon-btn'; next.setAttribute('aria-label', 'Next year'); next.textContent = '›';
  next.addEventListener('click', () => { jumpYear++; renderCalJump(); });
  head.append(prev, label, next);
  const grid = document.createElement('div'); grid.className = 'cal-jump-grid';
  for (let m = 0; m < 12; m++) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'cal-jump-month';
    b.textContent = new Date(jumpYear, m, 1).toLocaleDateString('en-GB', { month: 'short' });
    if (jumpYear === calYear && m === calMonth) b.classList.add('is-on');
    b.addEventListener('click', () => { calYear = jumpYear; calMonth = m; closeCalJump(); renderCalendar(); });
    grid.append(b);
  }
  box.append(head, grid);
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
      if (entry.__fav) {
        cell.classList.add('is-fav');
        const star = document.createElement('span'); star.className = 'cal-star'; star.textContent = '★'; star.setAttribute('aria-hidden', 'true');
        cell.append(star);
      }
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
let favFilterOn = false;

function onSearch() {
  const term = $('search-input').value.trim().toLowerCase();
  if (term && favFilterOn) setFavFilter(false, true); // typing takes over from the favourites view
  if (!term) { if (favFilterOn) return; $('search-results').hidden = true; $('calendar').hidden = false; renderLookback(); return; }
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

// The favourites view reuses the search-results pane to list starred days.
function setFavFilter(on, keepSearch) {
  favFilterOn = Boolean(on);
  const btn = $('fav-filter-btn');
  if (btn) { btn.setAttribute('aria-pressed', String(favFilterOn)); btn.classList.toggle('is-on', favFilterOn); }
  if (!favFilterOn) {
    if (!keepSearch) { $('search-results').hidden = true; $('calendar').hidden = false; renderLookback(); }
    return;
  }
  $('search-input').value = '';
  $('calendar').hidden = true; $('search-results').hidden = false; $('lookback').hidden = true;
  const box = $('search-results'); box.textContent = '';
  const dates = Object.keys(data.entries).filter((d) => data.entries[d] && data.entries[d].__fav && entryHasAnyContent(data.entries[d])).sort().reverse();
  const head = document.createElement('p'); head.className = 'soft small search-count';
  head.textContent = dates.length ? `${dates.length} ${dates.length === 1 ? 'favourite' : 'favourites'}` : 'No favourites yet. Star a day with the Favourite button.';
  box.append(head);
  for (const d of dates) {
    const item = document.createElement('button'); item.type = 'button'; item.className = 'search-item';
    const dd = document.createElement('div'); dd.className = 'search-item-date'; dd.textContent = mediumDate(d);
    const sn = document.createElement('div'); sn.className = 'search-item-snip'; sn.textContent = snippet(data.entries[d], '');
    item.append(dd, sn);
    item.addEventListener('click', async () => {
      if (!(await guardDirty('opening that day'))) return;
      setFavFilter(false); loadEditor(d); renderCalendar(); $('note').focus();
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

function setReportStatus(msg, error = false) { const el = $('activities-report-status'); if (el) { el.textContent = msg; el.classList.toggle('error', error); } }
function exportActivities() {
  return runExport(api.exportActivities, (res) => {
    if (!res.ok) setReportStatus(`Could not write: ${res.error}`, true);
    else if (!res.canceled) setReportStatus(`Saved to ${res.path}`);
    else setReportStatus('');
  });
}
function exportActivitiesPdf() {
  return runExport(api.exportActivitiesPdf, (res) => {
    if (!res.ok) setReportStatus(`Could not write: ${res.error}`, true);
    else if (!res.canceled) setReportStatus(`Saved to ${res.path}`);
    else setReportStatus('');
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
    if (load.ok && !load.locked && load.data) {
      data = load.data; loadEditor(currentDate); renderCount(); renderCalendar();
    } else {
      // The days ARE on disk, but this page is still holding the copy from
      // before the import. Saying "Added N days" here was doubly wrong: the
      // calendar would show none of them, and the next ordinary save would write
      // this stale copy back, deleting the days we just said we added. Stop
      // saving until the page and the disk agree again.
      loadFailed = true;
      showLoadErrorNotice('the imported days were written, but the page could not be refreshed.');
      setExportStatus(`Added ${res.added} ${res.added === 1 ? 'day' : 'days'} to your journal file, but Flint could not refresh this page. Close and reopen Flint to see them. Saving is off until then, so nothing can overwrite them.`, true);
      return;
    }
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
  // A locked journal answers ok:true with no data. Treating that as success
  // cleared the notice and re-enabled saving while `data` was null, so every
  // autosave tick threw and the writer was told "Saving is back on" while
  // nothing at all was being written.
  if (res.locked || !res.data) {
    showLoadErrorNotice('it is locked, so it could not be opened. Unlock it with your PIN first.');
    return;
  }
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
let customTheme = { base: 'dark', primary: '#7aa2f7', accent: '#bb9af7' };
let themePresets = [];
const THEME_KEYS = ['system', 'light', 'dark', 'true-black', 'sepia', 'rose-pine-dawn', 'solarized-light', 'catppuccin-latte', 'nord', 'everforest', 'rose-pine', 'catppuccin-mocha', 'tokyo-night', 'gruvbox'];
const DARK_THEMES = ['dark', 'true-black', 'nord', 'everforest', 'rose-pine', 'catppuccin-mocha', 'tokyo-night', 'gruvbox'];

// Swatch previews (background, ink, accent) so a theme can be seen before use.
const THEME_META = [
  { key: 'system', label: 'System', sw: ['#faf7f2', '#2a2621', '#bd6a34'] },
  { key: 'light', label: 'Light', sw: ['#faf7f2', '#3a352d', '#bd6a34'] },
  { key: 'dark', label: 'Dark', sw: ['#2a2621', '#e9e4dc', '#e0915a'] },
  { key: 'true-black', label: 'True black', sw: ['#000000', '#f2ede6', '#e0915a'] },
  { key: 'sepia', label: 'Sepia', sw: ['#f4ecd8', '#5b4636', '#a5612b'] },
  { key: 'rose-pine-dawn', label: 'Dawn', sw: ['#faf4ed', '#575279', '#a8455f'] },
  { key: 'solarized-light', label: 'Solar', sw: ['#fdf6e3', '#4e6469', '#1c6fb0'] },
  { key: 'catppuccin-latte', label: 'Latte', sw: ['#eff1f5', '#4c4f69', '#7a2fe0'] },
  { key: 'nord', label: 'Nord', sw: ['#2e3440', '#e5e9f0', '#88c0d0'] },
  { key: 'everforest', label: 'Forest', sw: ['#2d353b', '#d3c6aa', '#a7c080'] },
  { key: 'rose-pine', label: 'Rose', sw: ['#191724', '#e0def4', '#ebbcba'] },
  { key: 'catppuccin-mocha', label: 'Mocha', sw: ['#1e1e2e', '#cdd6f4', '#cba6f7'] },
  { key: 'tokyo-night', label: 'Tokyo', sw: ['#1a1b26', '#c0caf5', '#7aa2f7'] },
  { key: 'gruvbox', label: 'Retro', sw: ['#282828', '#ebdbb2', '#fe8019'] }
];

function resolveTheme(pref) {
  if (pref === 'system') return darkMedia.matches ? 'dark' : 'light';
  return (THEME_KEYS.includes(pref) && pref !== 'system') ? pref : 'light';
}
// Ink that stays readable on a chosen colour: dark text on light colours, else white.
function readableInk(hex) {
  const c = String(hex).replace('#', ''); if (c.length < 6) return '#ffffff';
  const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55 ? '#1a1a1a' : '#ffffff';
}
function applyTheme(pref) {
  themePref = (THEME_KEYS.includes(pref) || pref === 'custom') ? pref : 'light';
  const root = document.documentElement;
  if (themePref === 'custom') {
    const base = ['light', 'dark', 'black'].includes(customTheme.base) ? customTheme.base : 'light';
    // A "black" base borrows the true-black neutrals; the chosen colours still layer on top.
    root.dataset.theme = base === 'black' ? 'true-black' : base;
    root.dataset.mode = base === 'light' ? 'light' : 'dark';
    root.dataset.accent = 'custom';
    // Re-check the colours are #rrggbb before they reach CSS, even though the store
    // already gates them: a stray value should fall back, never reach setProperty.
    const isHex = (c) => /^#[0-9a-fA-F]{6}$/.test(c);
    const prim = isHex(customTheme.primary) ? customTheme.primary : '#7aa2f7';
    const acc = isHex(customTheme.accent) ? customTheme.accent : '#bb9af7';
    root.style.setProperty('--accent', prim);
    root.style.setProperty('--accent-2', acc);
    root.style.setProperty('--accent-ink', readableInk(prim));
    root.style.setProperty('--accent-2-ink', readableInk(acc));
  } else {
    const resolved = resolveTheme(themePref);
    root.dataset.theme = resolved;
    root.dataset.mode = DARK_THEMES.includes(resolved) ? 'dark' : 'light';
    delete root.dataset.accent;
    root.style.removeProperty('--accent'); root.style.removeProperty('--accent-2'); root.style.removeProperty('--accent-ink'); root.style.removeProperty('--accent-2-ink');
  }
  syncThemeChoice();
}
function buildThemeChoices() {
  const box = $('theme-choice'); if (!box) return;
  box.textContent = '';
  for (const t of THEME_META) {
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'theme-opt'; btn.dataset.themePref = t.key; btn.setAttribute('aria-pressed', 'false');
    const sw = document.createElement('span'); sw.className = 'theme-swatch'; sw.setAttribute('aria-hidden', 'true');
    for (const c of t.sw) { const s = document.createElement('span'); s.style.background = c; sw.append(s); }
    const label = document.createElement('span'); label.className = 'theme-opt-label'; label.textContent = t.label;
    btn.append(sw, label);
    btn.addEventListener('click', () => setThemePref(t.key));
    box.append(btn);
  }
  syncThemeChoice();
}
function syncThemeChoice() {
  for (const btn of document.querySelectorAll('.theme-opt')) {
    const on = btn.dataset.themePref === themePref;
    btn.classList.toggle('is-selected', on);
    btn.setAttribute('aria-pressed', String(on));
  }
  const cust = $('custom-section'); if (cust) cust.classList.toggle('is-active', themePref === 'custom');
}
let themeToggleBack = '';   // named theme the top-bar toggle should restore next press
let customDarkBase = 'dark'; // which dark base a custom theme last used
async function setThemePref(pref) { themeToggleBack = ''; applyTheme(pref); await safeCall(api.setTheme, pref); }

/* custom theme builder (base + two colours, savable as named presets) */
function initCustomControls() {
  const prim = $('custom-primary'), acc = $('custom-accent');
  if (!prim || !acc) return;
  prim.value = customTheme.primary; acc.value = customTheme.accent;
  syncCustomBase();
  for (const b of document.querySelectorAll('#custom-base .seg-btn')) {
    b.addEventListener('click', () => { customTheme.base = ['dark', 'black'].includes(b.dataset.base) ? b.dataset.base : 'light'; syncCustomBase(); persistCustom(); });
  }
  const preview = () => { customTheme.primary = prim.value; customTheme.accent = acc.value; applyTheme('custom'); };
  prim.addEventListener('input', preview); acc.addEventListener('input', preview);
  prim.addEventListener('change', persistCustom); acc.addEventListener('change', persistCustom);
  $('custom-save').addEventListener('click', saveThemePreset);
  renderThemePresets();
}
function syncCustomBase() {
  for (const b of document.querySelectorAll('#custom-base .seg-btn')) {
    const on = b.dataset.base === customTheme.base;
    b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', String(on));
  }
}
async function persistCustom() {
  applyTheme('custom');
  await safeCall(api.setTheme, 'custom');
  await safeCall(api.setCustom, customTheme);
}
async function saveThemePreset() {
  const nameEl = $('custom-name');
  const name = ((nameEl && nameEl.value) || '').trim().slice(0, 30) || 'My theme';
  themePresets = [...themePresets.filter((p) => p.name !== name), { name, base: customTheme.base, primary: customTheme.primary, accent: customTheme.accent }].slice(-12);
  if (nameEl) nameEl.value = '';
  const res = await safeCall(api.setThemePresets, themePresets);
  if (res.ok && Array.isArray(res.presets)) themePresets = res.presets;
  renderThemePresets();
}
function renderThemePresets() {
  const box = $('theme-presets'); if (!box) return;
  box.textContent = '';
  themePresets.forEach((p) => {
    const chip = document.createElement('div'); chip.className = 'preset-chip';
    const baseLabel = p.base.charAt(0).toUpperCase() + p.base.slice(1);
    const use = document.createElement('button'); use.type = 'button'; use.className = 'preset-use'; use.title = `${p.name} (${baseLabel} base)`;
    const sw = document.createElement('span'); sw.className = 'preset-sw';
    sw.style.background = p.base === 'black' ? '#000' : p.base === 'dark' ? '#242424' : '#f4f0e8';
    const d1 = document.createElement('span'); d1.className = 'preset-sw-dot'; d1.style.background = p.primary; d1.title = 'Primary';
    const d2 = document.createElement('span'); d2.className = 'preset-sw-dot'; d2.style.background = p.accent; d2.title = 'Accent';
    sw.append(d1, d2);
    const nm = document.createElement('span'); nm.className = 'preset-name'; nm.textContent = p.name;
    use.append(sw, nm);
    use.addEventListener('click', () => {
      customTheme = { base: p.base, primary: p.primary, accent: p.accent };
      if ($('custom-primary')) $('custom-primary').value = p.primary;
      if ($('custom-accent')) $('custom-accent').value = p.accent;
      syncCustomBase(); persistCustom();
    });
    const del = document.createElement('button'); del.type = 'button'; del.className = 'preset-del'; del.textContent = '×'; del.setAttribute('aria-label', `Delete ${p.name}`);
    del.addEventListener('click', async () => {
      themePresets = themePresets.filter((x) => x !== p);
      const r = await safeCall(api.setThemePresets, themePresets);
      if (r.ok && Array.isArray(r.presets)) themePresets = r.presets;
      renderThemePresets();
    });
    chip.append(use, del); box.append(chip);
  });
}

function wireThemeChoice(container) {
  if (!container) return;
  for (const btn of container.querySelectorAll('.theme-opt')) {
    btn.addEventListener('click', () => setThemePref(btn.dataset.themePref));
  }
}
// The top-bar button flips between light and dark, and must never quietly throw
// away a chosen theme. A custom theme keeps its two colours and only flips its
// base; any other named preset is remembered so the next press puts it straight
// back. Choosing a theme in Settings clears that memory (see setThemePref).
async function toggleTheme() {
  const goingDark = document.documentElement.dataset.mode !== 'dark';
  if (themePref === 'custom') {
    if (!goingDark && customTheme.base !== 'light') customDarkBase = customTheme.base;
    customTheme.base = goingDark ? customDarkBase : 'light';
    syncCustomBase();
    await persistCustom();
    return;
  }
  const back = themeToggleBack;
  if (back) { await setThemePref(back); return; } // setThemePref clears the memory
  const remember = ['light', 'dark', 'system'].includes(themePref) ? '' : themePref;
  await setThemePref(goingDark ? 'dark' : 'light');
  themeToggleBack = remember;
}
// If the preference is 'system', follow the OS the moment it flips light/dark.
darkMedia.addEventListener('change', () => { if (themePref === 'system') applyTheme('system'); });

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
// The whole update flow is mirrored into Settings > Updates: message, a progress
// bar and the buttons, all in place. Pressing "Check now" there used to clear the
// status and put the only Download button on the main screen, so you had to leave
// Settings to find it.
function setUpdatePanel(message, opts = {}) {
  setUpdateSettingStatus(message);
  const bar = $('update-progress'), fill = $('update-progress-fill');
  if (bar && fill) {
    if (opts.percent == null) { bar.hidden = true; }
    else {
      const p = Math.max(0, Math.min(100, Math.round(opts.percent)));
      bar.hidden = false; fill.style.width = p + '%'; bar.setAttribute('aria-valuenow', String(p));
    }
  }
  const acts = $('update-actions');
  if (acts) {
    acts.textContent = '';
    for (const b of (opts.actions || [])) {
      const el = document.createElement('button'); el.type = 'button'; el.textContent = b.label;
      if (b.kind) el.className = b.kind;
      el.addEventListener('click', b.onClick);
      acts.append(el);
    }
    acts.hidden = !(opts.actions && opts.actions.length);
  }
}
function handleUpdateStatus({ status, info, manual }) {
  const version = info && info.version ? ` (version ${info.version})` : '';
  const v = info && info.version ? info.version : '';
  const startDownload = () => {
    setUpdatePanel('Starting the download…', { percent: 0 });
    showUpdateBanner('Downloading update…');
    api.updateDownload();
  };
  switch (status) {
    case 'checking': setUpdatePanel('Checking…'); break;
    case 'available':
      setUpdatePanel(`Version ${v || 'a new version'} is available.`, {
        actions: [{ label: 'Download', kind: 'primary', onClick: startDownload }]
      });
      showUpdateBanner(`A new version of Flint is available${version}.`, [
        { label: 'Download', kind: 'primary', onClick: startDownload }, { label: 'Not now', onClick: hideUpdateBanner }
      ]); break;
    case 'progress': {
      const pct = info && info.percent != null ? info.percent : 0;
      setUpdatePanel(`Downloading… ${pct}%`, { percent: pct });
      showUpdateBanner(`Downloading update… ${pct}%`);
      break;
    }
    case 'ready':
      setUpdatePanel(`Version ${v} is ready. Flint will close and reopen itself to finish.`, {
        percent: 100, actions: [{ label: 'Install and restart', kind: 'primary', onClick: installUpdateFlow }]
      });
      showUpdateBanner(`Update${version} downloaded and ready.`, [
        { label: 'Install and restart', kind: 'primary', onClick: installUpdateFlow }, { label: 'Later', onClick: hideUpdateBanner }
      ]); break;
    case 'none': if (manual) setUpdatePanel("You're on the latest version."); break;
    case 'error': if (manual) setUpdatePanel("Couldn't check just now, are you online?"); break;
    case 'unsupported': if (manual) setUpdatePanel('Updates apply to the installed app, not this test run.'); break;
  }
}
async function installUpdateFlow() {
  if (!(await guardDirty('installing the update'))) return;
  // quitAndInstall closes Flint and reopens it once the installer finishes, so the
  // restart is handled for the writer rather than asked of them.
  setUpdatePanel('Installing. Flint will close and reopen itself in a moment.', { percent: 100 });
  showUpdateBanner('Installing… Flint will close and reopen itself.');
  await safeCall(api.updateInstall);
}

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
  // Re-read the prompts, templates and activities now that a key exists. They
  // are only fetched at boot otherwise, so after a lock and unlock the editors
  // would still be holding whatever they had, and if THAT was the built-in
  // defaults (because the boot read happened while locked) the next Save would
  // write them over the person's real ones.
  loadContentIntoUi().catch(() => { /* the read-only flag already covers it */ });
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
  // One clause, not a paragraph. The full account is a click away in the privacy
  // panel: repeating it under every page reads as anxiety rather than calm.
  el.textContent = '';
  const txt = document.createElement('span');
  txt.textContent = encrypted ? 'Encrypted on this computer. ' : 'Stays on this computer. ';
  const link = document.createElement('button');
  link.type = 'button'; link.className = 'linklike'; link.id = 'privacy-link';
  link.textContent = 'What Flint shares';
  link.addEventListener('click', () => openPanel($('privacy-panel')));
  el.append(txt, link);
}

async function lockAndGate() {
  cancelAutosave(); // no tick may fire against the vault we are about to lock
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
    // If the date rolled over while Flint sat locked in the tray, come back to
    // today rather than to whatever page was open when it locked. Landing on a
    // week-old day with autosave live is a real way to lose writing.
    if (trayReturnPending && currentDate !== todayISO()) currentDate = todayISO();
    trayReturnPending = false;
    const away = $('pin-away'); if (away) { away.hidden = true; away.textContent = ''; }
    loadEditor(currentDate); renderCount(); renderCalendar(); renderWriterHead();
    $('note').focus();
  } else {
    // The reload after unlocking failed, or came back still locked. This branch
    // did not exist: the page kept the emptied `data` from the lock, so it looked
    // like a brand new journal, saving stayed on, and the first word typed wrote
    // that empty journal over the real one. Treat it exactly as init does.
    loadFailed = true;
    showLoadErrorNotice(res.locked
      ? 'Your journal is still locked, so it could not be opened. Saving is switched off until it opens, so nothing can be written over it. Please try unlocking again.'
      : res.error);
  }
  resetAutoLockTimer();
}

async function relock() {
  if (!(await guardDirty('locking Flint'))) return;
  await lockAndGate();
}

// One place for this wording, because two paths set it: the Settings toggle and
// the one-time question at close. Split copy is how the two quietly disagree.
function setBackgroundStatus(on, trayOk) {
  const st = $('background-status'); if (!st) return;
  if (on && !trayOk) {
    st.textContent = 'Flint could not add its icon near the clock, so it will fully close when you close the window.';
    return;
  }
  st.textContent = on
    ? 'Flint will tuck into the notification area when you close the window.'
    : 'Flint will fully close when you close the window.';
}

// Coming back from the tray. The window may have been away long enough for the
// date to roll over, and it may have locked itself while nobody could see it.
async function handleWindowShown() {
  const gate = $('pin-gate');
  if (gate && gate.hidden === false) {
    // The gate opened while the window was invisible, so openLockGate's focus
    // call went nowhere and any error on it predates the whole absence.
    const err = $('pin-error'); if (err) err.textContent = '';
    const away = $('pin-away');
    if (away) {
      const phrase = hiddenAt ? awayPhrase(Date.now() - hiddenAt) : '';
      away.textContent = phrase
        ? `Flint has been locked in the tray ${phrase}.`
        : 'Flint locked itself while it was in the tray.';
      away.hidden = false;
    }
    hiddenAt = 0;
    suppressAwayOnce = true; // the gate has said it; the greeting must not repeat it
    trayReturnPending = true;
    const input = $('pin-input'); if (input) input.focus();
    return;
  }
  await rollToTodayIfStale();
  greetingShown = false; // a return from the tray is a fresh arrival, not the same launch
  maybeShowGreeting();
}

// Landing on a week-old page with autosave live is a real way to lose writing,
// and "in the tray for about a week" beside last Tuesday's date is incoherent.
async function rollToTodayIfStale() {
  const today = todayISO();
  if (currentDate === today) return;
  if (!(await guardDirty('moving to today'))) return;
  selectDay(today);
}

/* auto-lock on idle */

let autoLockMinutes = 15;
let autoLockTimer = null;
let encryptedNow = false;
let windowPinNow = false;   // the older window-only PIN, which also deserves a re-lock

// Either kind of lock means there is a gate to come back to, so either must arm
// the idle timer. Before this, someone with the legacy window PIN and no
// encryption was asked once when Flint launched and never again. That was
// already weak, and keeping Flint in the tray turns "once per launch" into
// "once a week", with the journal open on screen the whole time in between.
function hasLock() { return encryptedNow || windowPinNow; }

function resetAutoLockTimer() {
  clearTimeout(autoLockTimer);
  // Null it as well as clear it. The timer is genuinely cancelled either way,
  // but leaving a spent id here makes the variable read as "a lock is pending"
  // when auto-lock is off, which is a trap for anyone who tests it later.
  autoLockTimer = null;
  if (!hasLock() || !autoLockMinutes || !appReady) return;
  autoLockTimer = setTimeout(autoLockNow, autoLockMinutes * 60 * 1000);
}

// The ONE safe way to lock, and every automatic lock path must come through it.
// Locking clears the page, so a lock that discards unsaved words is worse than a
// lock that arrives a moment late. The save lived in autoLockNow before, which
// meant a second lock path (the Windows lock-screen and sleep hook) was added
// later without it and quietly threw writing away. Keeping it here means a
// future caller cannot reintroduce that. Returns false if it did not lock.
async function lockSafely() {
  if (!hasLock() || !appReady) return false;
  if ($('pin-gate').hidden === false) return false; // already locked
  cancelAutosave();
  // Let any save already in flight finish rather than racing it.
  for (let i = 0; i < 50 && saving; i++) await new Promise((r) => setTimeout(r, 15));
  if (saving) return false;
  if (isDirty()) {
    const saved = await saveCurrent({ quiet: true, backup: true, allowDelete: true, silentError: true });
    if (!saved) return false; // stay unlocked rather than clear the page
  }
  await lockAndGate();
  return true;
}

async function autoLockNow() {
  if (!hasLock() || !appReady || $('pin-gate').hidden === false) return;
  // Don't lock out from under an open dialog or settings panel: being in one is a
  // sign someone is still here. The timer resumes once it is closed.
  if (modalIsOpen() || openPanelEl) { resetAutoLockTimer(); return; }
  if (!(await lockSafely())) resetAutoLockTimer();
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

// How many guesses a WORDLIST attacker needs, or null when this looks like
// nothing on the list. The character-set sum below is the right model for
// guessing blindly and badly wrong for the attacker Flint actually has: someone
// who copied the data folder and runs common passwords against it offline.
// Measured against a real vault built with this app's own crypto, "password1"
// fell in 2.29 seconds while the meter called it strong.
function wordlistGuesses(pin) {
  const s = String(pin || '');
  const lower = s.toLowerCase();
  const list = typeof COMMON_PINS !== 'undefined' ? COMMON_PINS : [];
  const sufs = typeof COMMON_SUFFIXES !== 'undefined' ? COMMON_SUFFIXES : [''];
  const prefs = typeof COMMON_PREFIXES !== 'undefined' ? COMMON_PREFIXES : [''];

  // A run of one repeated character, or a straight keyboard/number run.
  if (/^(.)\1*$/.test(s)) return 100;
  if (/^(?:0?123456789?0?|9876543210?|abcdefg?h?i?j?)$/.test(lower)) return 100;

  // A listed word, optionally wrapped in the decorations people add to it. The
  // cost is the list position times the small number of decorations tried, not
  // the whole character space.
  for (let i = 0; i < list.length; i++) {
    const w = list[i];
    for (const p of prefs) {
      for (const suf of sufs) {
        if (lower === p + w + suf || lower === p + w.charAt(0).toUpperCase() + w.slice(1) + suf) {
          return Math.max(50, (i + 1) * prefs.length * sufs.length);
        }
      }
    }
  }
  // A listed word with a simple capital and any short tail: still cheap.
  for (let i = 0; i < list.length; i++) {
    if (lower.startsWith(list[i]) && s.length - list[i].length <= 4) {
      return Math.max(200, (i + 1) * 5000);
    }
  }
  return null;
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
  const blind = Math.pow(charset, s.length) / 2 / GUESSES_PER_SEC;
  const known = wordlistGuesses(s);
  // Take the cheaper of the two routes, which is what an attacker would do.
  // Because this can only ever LOWER an estimate, it cannot introduce a new
  // overstatement: a genuinely strong PIN is unaffected.
  return known === null ? blind : Math.min(blind, known / GUESSES_PER_SEC);
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
  // Say WHY when the answer comes from the common-password route, or the number
  // looks arbitrary next to a PIN the user thinks is inventive.
  if (wordlistGuesses(s) !== null) {
    return { level, text: `This is a well-known password, or close to one, so it could be cracked in ${humanDuration(secs)}.` };
  }
  return { level, text: `This PIN could be cracked in roughly ${humanDuration(secs)}.` };
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
  // Set before updateLockButton, which re-arms the idle timer off hasLock().
  windowPinNow = Boolean(status.ok && status.windowPin && !encrypted);
  updateLockButton(encrypted);
  updatePrivacyEncryptionLine(encrypted);
  $('security-explain').textContent = encrypted
    ? 'Your journal is encrypted on this computer. Your PIN unlocks it each time Flint opens. Keep your recovery code safe: it is the only other way in if you forget your PIN.'
    : 'Turn on encryption to scramble your entries on disk. Your PIN unlocks them; if you ever forget it, a one-time recovery code is the only other way in, so keep it safe. Both lost means the journal cannot be recovered, by anyone. That is what makes it real.';
  const holder = $('security-settings'); holder.textContent = '';
  holder.append(encrypted ? buildChangePinForm() : buildEnableForm());
  if (encrypted) holder.append(buildAutoLockControl(), buildDisableForm());
  // A window PIN now re-locks on idle too, so it needs the same control. Without
  // it the timer would exist with no way to change or switch off.
  else if (windowPinNow) holder.append(buildAutoLockControl(), buildRemoveWindowPinForm());
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
    let res = await safeCall(api.changeEncryptionPin, cur.input.value, a.input.value);
    if (!res.ok && res.damagedPhotos && await confirmSkipDamaged(res, 'Change my PIN')) {
      msg.textContent = 'Re-locking your journal with a new key…';
      res = await safeCall(api.changeEncryptionPin, cur.input.value, a.input.value, { skipDamaged: true });
    }
    btn.disabled = false;
    // Changing the PIN rotates the key, which issues a new recovery code. The
    // old code stops working, so the user must be shown and keep the new one.
    if (res.ok && res.recoveryCode) showRecoveryReveal(res.recoveryCode, res.removedBackups);
    else { msg.textContent = res.error || 'The PIN could not be changed.'; msg.classList.add('error'); cur.input.value = ''; cur.input.focus(); }
  });
  return form;
}

// A photo that no longer decrypts blocks turning encryption off and changing the
// PIN, and no amount of retrying will fix it. Rather than repeating "please try
// again" for ever, say plainly that it cannot be recovered and offer to go on
// without it. The damaged file is left untouched either way.
async function confirmSkipDamaged(res, what) {
  const names = res.damagedPhotos || [];
  if (!names.length) return false;
  const n = names.length;
  const choice = await showModal({
    title: n === 1 ? 'One photo cannot be read' : `${n} photos cannot be read`,
    body: `${res.error}

${n === 1 ? 'File' : 'Files'}: ${names.join(', ')}

The damaged ${n === 1 ? 'file stays' : 'files stay'} in your journal folder untouched, in case you want to try to recover ${n === 1 ? 'it' : 'them'} another way.`,
    buttons: [
      { label: `${what} anyway`, value: 'skip', kind: 'danger' },
      { label: 'Leave things as they are', value: 'stop', kind: 'primary' }
    ],
    focusValue: 'stop'
  });
  return choice === 'skip';
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
  const wrap = document.createElement('div'); wrap.className = 'sec-disable';
  const head = document.createElement('p'); head.className = 'sec-disable-head'; head.textContent = 'Turn off encryption';
  const p = document.createElement('p'); p.className = 'soft small'; p.textContent = 'This writes your entries back as readable files on this computer. Only do it if you no longer need them protected.';
  const form = document.createElement('form'); form.className = 'sec-form';
  const cur = secField('Enter your PIN to confirm', 'enc-off-pin');
  const btn = document.createElement('button'); btn.type = 'submit'; btn.className = 'danger'; btn.textContent = 'Turn off encryption';
  const msg = document.createElement('p'); msg.className = 'status'; msg.setAttribute('role', 'status');
  form.append(cur.wrap, btn, msg);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); msg.classList.remove('error');
    btn.disabled = true;
    let res = await safeCall(api.disableEncryption, cur.input.value);
    if (!res.ok && res.damagedPhotos && await confirmSkipDamaged(res, 'Turn encryption off')) {
      res = await safeCall(api.disableEncryption, cur.input.value, { skipDamaged: true });
    }
    btn.disabled = false;
    if (res.ok) {
      const left = (res.damagedPhotos || []).length;
      renderSecuritySettings(left
        ? `Encryption is off. Your entries are readable files again. ${left} damaged ${left === 1 ? 'photo was' : 'photos were'} left as ${left === 1 ? 'it is' : 'they are'}.`
        : 'Encryption is off. Your entries are readable files again.');
    }
    else { msg.textContent = res.error || 'Encryption could not be turned off.'; msg.classList.add('error'); cur.input.value = ''; cur.input.focus(); }
  });
  wrap.append(head, p, form);
  return wrap;
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
// Fetches the three content sets and records whether what we hold is really the
// user's. Called at boot and again after every unlock: before the split these
// were read once at startup and never refreshed, so a lock/unlock cycle could
// leave an editor holding defaults that the next Save wrote through.
async function loadContentIntoUi() {
  contentReadOnly = false;
  contentReadError = '';
  const qRes = await safeCall(api.getQuestions);
  if (qRes.ok) {
    if (Array.isArray(qRes.questions) && qRes.questions.length) questions = qRes.questions;
    knownTitles = qRes.knownTitles || {};
  } else if (qRes.reason === 'locked' || qRes.reason === 'unreadable') {
    contentReadOnly = true;
    contentReadError = qRes.error || 'Your saved prompts could not be read.';
  }

  const tRes = await safeCall(api.getTemplates);
  if (tRes.ok && Array.isArray(tRes.templates) && tRes.templates.length) templates = tRes.templates;
  else if (!tRes.ok) contentReadOnly = true;

  const actRes = await safeCall(api.getActivities);
  if (actRes.ok && Array.isArray(actRes.activities) && actRes.activities.length) activityChoices = actRes.activities;
  else if (!actRes.ok) contentReadOnly = true;
}

// The one message every content editor shows when it must not save. Kept in one
// place so the three of them cannot drift into saying different things.
function contentBlockedMessage() {
  return contentReadError
    || 'Flint could not read your saved prompts and templates, so what you see here are the built-in ones. Saving now would replace yours. Unlock your journal and reopen this.';
}

async function savePrompts() {
  if (contentReadOnly) { renderPromptsEditor(contentBlockedMessage()); return; }
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
  if (backupCfg.enabled) $('backup-status').textContent = 'On. Flint will keep a copy there once a day.';
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

let statsView = 'pixels12';
let statsMonthRef = null;   // first-of-month Date for the month view
let statsYearRef = null;    // year number for the year view

// One heatmap cell for a date, shared by all three views.
function heatCell(iso) {
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
  return cell;
}

// A single month as a 7-column calendar heatmap (Monday-first, leading blanks).
function buildMonthGrid(monthDate) {
  const wrap = document.createElement('div'); wrap.className = 'pixel-cal';
  const head = document.createElement('div'); head.className = 'pixel-cal-head';
  for (const w of WEEKDAYS) { const s = document.createElement('span'); s.textContent = w[0]; s.title = w; head.append(s); }
  wrap.append(head);
  const grid = document.createElement('div'); grid.className = 'pixel-cal-grid';
  const y = monthDate.getFullYear(), mo = monthDate.getMonth();
  const startDow = (new Date(y, mo, 1).getDay() + 6) % 7; // Mon = 0
  for (let i = 0; i < startDow; i++) { const b = document.createElement('span'); b.className = 'pixel blank'; grid.append(b); }
  const days = new Date(y, mo + 1, 0).getDate();
  for (let d = 1; d <= days; d++) grid.append(heatCell(ymd(new Date(y, mo, d))));
  wrap.append(grid);
  return wrap;
}

// A whole year as GitHub-style week columns (Monday-first rows), Jan to Dec.
function buildYearGrid(year) {
  const wrap = document.createElement('div'); wrap.className = 'pixel-year';
  const grid = document.createElement('div'); grid.className = 'pixel-year-grid';
  const end = new Date(year, 11, 31).getTime();
  const cur = new Date(mondayOf(ymd(new Date(year, 0, 1))) + 'T00:00:00');
  while (cur.getTime() <= end) {
    const col = document.createElement('div'); col.className = 'pixel-week';
    for (let dow = 0; dow < 7; dow++) {
      if (cur.getFullYear() === year) col.append(heatCell(ymd(cur)));
      else { const b = document.createElement('span'); b.className = 'pixel blank'; col.append(b); }
      cur.setDate(cur.getDate() + 1);
    }
    grid.append(col);
  }
  wrap.append(grid);
  return wrap;
}

function heatNavBtn(txt, aria, fn) {
  const b = document.createElement('button'); b.type = 'button'; b.className = 'pixel-nav-btn'; b.textContent = txt; b.setAttribute('aria-label', aria);
  b.addEventListener('click', fn); return b;
}
function setStatsView(v) { statsView = v; renderHeatmapArea(); }
function renderHeatmapArea() {
  const host = $('stats-heatmap'); if (!host) return;
  host.textContent = '';
  for (const b of document.querySelectorAll('.stats-view-btn')) {
    const on = b.dataset.view === statsView;
    b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', String(on));
  }
  const today = new Date(todayISO() + 'T00:00:00');
  if (statsView === 'month') {
    if (!statsMonthRef) statsMonthRef = new Date(today.getFullYear(), today.getMonth(), 1);
    const nav = document.createElement('div'); nav.className = 'pixel-nav';
    const label = document.createElement('span'); label.className = 'pixel-nav-label';
    label.textContent = statsMonthRef.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    nav.append(
      heatNavBtn('‹', 'Previous month', () => { statsMonthRef = new Date(statsMonthRef.getFullYear(), statsMonthRef.getMonth() - 1, 1); renderHeatmapArea(); }),
      label,
      heatNavBtn('›', 'Next month', () => { statsMonthRef = new Date(statsMonthRef.getFullYear(), statsMonthRef.getMonth() + 1, 1); renderHeatmapArea(); })
    );
    host.append(nav, buildMonthGrid(statsMonthRef));
  } else if (statsView === 'year') {
    if (statsYearRef == null) statsYearRef = today.getFullYear();
    const nav = document.createElement('div'); nav.className = 'pixel-nav';
    const label = document.createElement('span'); label.className = 'pixel-nav-label'; label.textContent = String(statsYearRef);
    nav.append(
      heatNavBtn('‹', 'Previous year', () => { statsYearRef -= 1; renderHeatmapArea(); }),
      label,
      heatNavBtn('›', 'Next year', () => { statsYearRef += 1; renderHeatmapArea(); })
    );
    host.append(nav, buildYearGrid(statsYearRef));
  } else {
    const cap = document.createElement('p'); cap.className = 'soft small';
    cap.textContent = 'One square per day for the last twelve months, tinted by how the day went.';
    host.append(cap, buildPixels());
  }
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

  const h1 = document.createElement('h3'); h1.textContent = 'Your days at a glance';
  body.append(h1);
  const viewBar = document.createElement('div'); viewBar.className = 'stats-views'; viewBar.setAttribute('role', 'group'); viewBar.setAttribute('aria-label', 'Heatmap view');
  for (const [v, label] of [['pixels12', '12 months'], ['month', 'Month'], ['year', 'Year']]) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'stats-view-btn'; b.dataset.view = v; b.textContent = label;
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => setStatsView(v));
    viewBar.append(b);
  }
  body.append(viewBar);
  const host = document.createElement('div'); host.id = 'stats-heatmap'; host.className = 'stats-heatmap';
  body.append(host);
  renderHeatmapArea();

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
        const li = document.createElement('li');
        // A task item ("- [ ] ..." or "- [x] ...") becomes a real checkbox that
        // ticks the underlying line; anything else stays a plain bullet.
        const tm = lines[i].match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
        if (tm) {
          li.className = 'task-item';
          const box = document.createElement('input'); box.type = 'checkbox'; box.className = 'task-check';
          box.checked = tm[1].toLowerCase() === 'x';
          const idx = i;
          box.addEventListener('change', () => toggleTaskLine(idx, box.checked));
          const span = document.createElement('span'); span.className = 'task-text' + (box.checked ? ' done' : '');
          appendInline(span, tm[2]);
          li.append(box, span);
        } else {
          appendInline(li, lines[i].replace(/^\s*[-*+]\s+/, ''));
        }
        ul.append(li); i++;
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

// Toggle a task line in the note from a clicked preview checkbox, then re-render
// the preview and save so the tick sticks. The line index was captured when the
// preview was built (the note is a read-only view while the preview is showing).
function toggleTaskLine(idx, checked) {
  const ta = $('note');
  const lines = ta.value.split('\n');
  if (idx < 0 || idx >= lines.length) return;
  const m = lines[idx].match(/^(\s*[-*+]\s+\[)([ xX])(\].*)$/);
  if (!m) return;
  lines[idx] = m[1] + (checked ? 'x' : ' ') + m[3];
  ta.value = lines.join('\n');
  autosize(ta);
  if (previewOn) renderMarkdownInto($('note-preview'), noteValue());
  updateEmptyHelpers();
  saveCurrent();
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

/* the writer's overflow menu: the occasional action, and the destructive one,
   kept off the main row so the foot is not a wall of buttons. */
function toggleMoreMenu() {
  const menu = $('more-menu');
  if (!menu.hidden) { closeMoreMenu(); return; }
  menu.hidden = false;
  $('more-btn').setAttribute('aria-expanded', 'true');
  document.addEventListener('keydown', moreMenuKey, true);
  document.addEventListener('click', moreMenuOutside, true);
}
function closeMoreMenu() {
  const menu = $('more-menu'); if (!menu || menu.hidden) return;
  menu.hidden = true;
  $('more-btn').setAttribute('aria-expanded', 'false');
  document.removeEventListener('keydown', moreMenuKey, true);
  document.removeEventListener('click', moreMenuOutside, true);
}
function moreMenuKey(e) { if (e.key === 'Escape') { e.preventDefault(); closeMoreMenu(); $('more-btn').focus(); } }
function moreMenuOutside(e) { if (!$('more-menu').contains(e.target) && !$('more-btn').contains(e.target)) closeMoreMenu(); }

// Copy one day as plain text. Every export is otherwise all-or-nothing, so
// pasting a single day into a message meant producing a readable copy of the
// entire journal first, which is exactly what the encryption is there to stop.
function markerLabel(list, key) {
  const m = list.find((x) => x.key === key);
  return m ? (m.label || m.short) : '';
}
async function copyDay() {
  const lines = [longDate(currentDate)];
  const note = noteValue().trim();
  if (note) lines.push('', note);
  const day = markerLabel(MARKERS, currentDay);
  const trend = markerLabel(TRAJ_MARKERS, currentTrend);
  const extras = [];
  if (day) extras.push(`How it was: ${day}`);
  if (trend) extras.push(`Compared with usual: ${trend}`);
  if (currentTags.length) extras.push(`Tags: ${currentTags.join(', ')}`);
  if (currentFeelings.length) extras.push(`Feelings: ${currentFeelings.join(', ')}`);
  if (currentActivities.length) extras.push(`Today held: ${currentActivities.join(', ')}`);
  if (extras.length) lines.push('', ...extras);
  const text = lines.join('\n');
  if (await copyText(text)) setStatus('This day is on your clipboard.');
  else setStatus('That day could not be copied.', { error: true });
}
// Electron's own clipboard is the reliable path: the page-level APIs below need
// a trusted gesture and a permission that a packaged app cannot count on.
async function copyText(text) {
  if (api.copyText) {
    const res = await safeCall(api.copyText, text);
    if (res.ok) return true;
  }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the textarea */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed'; ta.style.opacity = '0'; ta.style.pointerEvents = 'none';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

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
  if (contentReadOnly) { renderTemplatesEditor(contentBlockedMessage()); return; }
  const cleaned = tplDraft.map((t) => ({ name: (t.name || '').trim(), body: t.body || '' })).filter((t) => t.name);
  if (!cleaned.length) { renderTemplatesEditor('Add at least one template with a name before saving.'); return; }
  const res = await safeCall(api.setTemplates, cleaned);
  if (!res.ok) { renderTemplatesEditor(res.error || 'Those templates could not be saved.'); return; }
  templates = res.templates;
  startTemplatesEditor(); renderTemplatesEditor('Saved. Your templates are updated.');
}

function startActivitiesEditor() {
  const ed = $('activities-editor'); if (!ed) return;
  ed.value = activityChoices.join('\n');
  const st = $('activities-status'); if (st) st.textContent = '';
}
async function saveActivitiesEdits() {
  if (contentReadOnly) { $('activities-status').textContent = contentBlockedMessage(); return; }
  const list = $('activities-editor').value.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!list.length) { $('activities-status').textContent = 'Add at least one activity before saving.'; return; }
  const res = await safeCall(api.setActivities, list);
  if (!res.ok) { $('activities-status').textContent = res.error || 'Those activities could not be saved.'; return; }
  activityChoices = res.activities;
  startActivitiesEditor();
  $('activities-status').textContent = 'Saved. Your activities are updated.';
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
    body: 'This deletes every entry, your settings and your PIN, and returns Flint to a brand-new setup. Flint will also remove the copies it made in your backup folder, if it can reach it. It cannot be undone.',
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
  if (!res.ok) { $('reset-status').textContent = res.error || 'That could not be completed.'; return; }
  // Reset deletes the settings that record where the backup folder was, so if
  // anything was left there this is the last moment Flint can name it.
  if (res.backupFolder && res.cleanedBackupFolder === false) {
    await showModal({
      title: 'Copies may still be in your backup folder',
      body: `Everything on this computer has been erased.\n\nFlint could not reach your backup folder to remove the copies it made there:\n\n${res.backupFolder}\n\nIf you want those gone too, delete the "Flint backups" folder inside it yourself. Flint will not be able to tell you where it was after this.`,
      buttons: [{ label: 'I understand', value: 'ok', kind: 'primary' }]
    });
  } else if (res.leftBehind) {
    await showModal({
      title: 'Some copies could not be removed',
      body: `Everything on this computer has been erased.\n\n${res.leftBehind} ${res.leftBehind === 1 ? 'file' : 'files'} in your backup folder could not be deleted, probably because something else has ${res.leftBehind === 1 ? 'it' : 'them'} open:\n\n${res.backupFolder}\n\nClose anything using that folder and delete the "Flint backups" folder inside it yourself.`,
      buttons: [{ label: 'I understand', value: 'ok', kind: 'primary' }]
    });
  }
  location.reload();
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
  const customRes = await safeCall(api.getCustom);
  if (customRes.ok) { if (customRes.custom) customTheme = customRes.custom; if (Array.isArray(customRes.presets)) themePresets = customRes.presets; }
  applyTheme(themeRes.ok ? themeRes.theme : 'light');

  // Custom title-bar window controls, wired early so they also work on the lock
  // gate and onboarding (which appear before the rest of init runs).
  const wireWin = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
  wireWin('win-min', () => api.minimizeWindow && api.minimizeWindow());
  wireWin('win-max', () => api.maximizeWindow && api.maximizeWindow());
  wireWin('win-close', () => api.closeWindow && api.closeWindow());
  wireWin('gate-close', () => api.closeWindow && api.closeWindow());
  wireWin('onboard-close', () => api.closeWindow && api.closeWindow());
  if (api.onWindowMaxState) api.onWindowMaxState((m) => document.body.classList.toggle('is-maximized', m));

  // Wire the lock gate and onboarding once; each is driven by a promise below.
  $('pin-form').addEventListener('submit', onGateSubmit);
  $('pin-forgot').addEventListener('click', onGateForgot);
  wireOnboarding();

  // Register the close guard now, before the gate or onboarding can hold up
  // init. Until the editor loads, isDirty() is false, so closing during the
  // gate or onboarding just closes cleanly instead of wrongly asking to save.
  // On close, actively save any unsaved words and report unsaved=true ONLY if the
  // save genuinely fails. So the "save before closing?" prompt appears only when
  // something is really at risk, and closing stays silent when autosave (or this
  // save) already has it covered.
  api.onQueryDirty(async () => {
    cancelAutosave();
    // let any in-flight flush settle, so its saving-guard is not read as a failure
    for (let i = 0; i < 20 && saving; i++) await new Promise((r) => setTimeout(r, 15));
    if (!isDirty()) { api.dirtyReply(false); return; }   // already saved -> close quietly
    if (saving) { api.dirtyReply(true); return; }         // a save is wedged -> be safe, prompt
    const ok = await saveCurrent({ quiet: true, backup: true, allowDelete: true, silentError: true });
    api.dirtyReply(!ok);                                  // prompt only if the save actually failed
  });
  api.onSaveThenClose(async () => { const ok = await saveCurrent(); if (ok) api.closeNow(); });

  // tray bridges
  api.onFlushNow(() => { flushForHide(); });
  // Locking Windows or sleeping the machine means the person has really gone, so
  // unlike the idle timer this does NOT stand down for an open panel or dialog.
  // It still goes through lockSafely, so the words reach disk first.
  api.onLockNow(() => { lockSafely(); });
  api.onWindowHidden((payload) => {
    // Only a hide into the tray counts as being away. Minimising is not.
    if (payload && payload.toTray) hiddenAt = Date.now();
  });
  api.onWindowShown(() => { handleWindowShown(); });
  api.onTrayOffer(async () => {
    // Asked once in Flint's life, on a clean close. The safe answer is last, so
    // Escape and the window X both land on "close fully": silence must never
    // switch on a background process.
    let body = 'Closing the window can either tuck Flint into the notification area, quietly, or close it completely.\n\nKept in the tray, Flint stays out of the way and reopens instantly. Either way nothing leaves this computer.\n\nYou can change this whenever you like, in Settings under System.';
    const rem = await safeCall(api.getReminder);
    if (rem.ok && rem.enabled) {
      body += '\n\nIt also means your daily reminder can still reach you while the window is shut.';
    }
    const choice = await showModal({
      title: 'Keep Flint in the tray?',
      body,
      buttons: [
        { label: 'Keep Flint in the tray', value: 'tray' },
        { label: 'Close it fully', value: 'full', kind: 'primary' }
      ],
      focusValue: 'full'
    });
    if (choice === 'tray') {
      const bg = $('background-toggle');
      if (bg) bg.checked = true; // the renderer reads this once at boot; keep it honest
      setBackgroundStatus(true, true);
    }
    api.trayAnswer(choice === 'tray' ? 'tray' : 'full');
  });

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
  // Set before updateLockButton, which arms the idle timer off hasLock().
  windowPinNow = Boolean(secStatus.ok && secStatus.windowPin && !secStatus.encrypted);
  updateLockButton(secStatus.ok && secStatus.encrypted);
  updatePrivacyEncryptionLine(secStatus.ok && secStatus.encrypted);

  // Prompts, templates and activities live in the encrypted content file now, so
  // these can legitimately come back ok:false while the journal is locked. The
  // built-in defaults are fine to SHOW in that case, but saving them back would
  // replace the person's real ones, so the editors are held read-only until a
  // successful read proves we know what is actually in there.
  await loadContentIntoUi();

  const gRes = await safeCall(api.getGuided);
  const guidedPref = gRes.ok ? gRes.guided : false;

  const alRes = await safeCall(api.getAutoLock);
  autoLockMinutes = alRes.ok ? alRes.minutes : 15;
  const asRes = await safeCall(api.getAutosave);
  autosaveIntervalMs = (asRes.ok ? asRes.seconds : 30) * 1000;
  const asSel = $('autosave-select');
  if (asSel) {
    asSel.value = String(autosaveIntervalMs / 1000);
    asSel.addEventListener('change', async () => {
      const r = await safeCall(api.setAutosave, Number(asSel.value));
      if (r.ok) { autosaveIntervalMs = r.seconds * 1000; autosaveDeadline = 0; indicatorState = ''; }
    });
  }

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
  const bgRes = await safeCall(api.getRunInBackground);
  if (bgRes.ok && $('background-toggle')) $('background-toggle').checked = bgRes.enabled;
  const swRes = await safeCall(api.getStartWithWindows);
  if (swRes.ok && $('startup-toggle')) $('startup-toggle').checked = swRes.enabled;
  const hwRes = await safeCall(api.getHardwareAcceleration);
  if (hwRes.ok && $('hwaccel-toggle')) $('hwaccel-toggle').checked = hwRes.enabled;

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
  buildTrendMarker();
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
  $('note').addEventListener('input', () => { autosize($('note')); updateEmptyHelpers(); scheduleAutosave(); });
  // Immediate autosave at the moments words are most at risk: attention leaving
  // the editor or Flint, and the window being hidden (including close-to-tray).
  $('note').addEventListener('blur', flushAutosave);
  window.addEventListener('blur', flushAutosave);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushAutosave(); });
  // One heartbeat fires the periodic save and keeps the top-bar dot in step.
  autosaveHeartbeat = setInterval(tickAutosave, 1000);
  renderIndicator('saved');
  const asInd = $('autosave-ind');
  if (asInd) { const setTip = () => { asInd.title = autosaveHoverText(); }; asInd.addEventListener('mouseenter', setTip); asInd.addEventListener('focus', setTip); }
  $('delete-btn').addEventListener('click', () => { closeMoreMenu(); deleteDay(currentDate); });
  $('copy-day-btn').addEventListener('click', () => { closeMoreMenu(); copyDay(); });
  $('more-btn').addEventListener('click', toggleMoreMenu);
  $('extras-toggle').addEventListener('click', () => setExtrasOpen(!extrasOpen));
  $('tag-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTagFromInput(); }
    else if (e.key === 'Backspace' && !e.target.value && currentTags.length) { currentTags.pop(); renderTags(); }
  });
  $('tag-input').addEventListener('blur', addTagFromInput);
  $('guided-btn').addEventListener('click', () => setGuidedMode(!guided));
  $('tpl-btn').addEventListener('click', toggleTplMenu);
  $('preview-btn').addEventListener('click', () => setPreview(!previewOn));
  $('feelings-add').addEventListener('click', toggleFeelingsPicker);
  $('activities-add').addEventListener('click', toggleActivitiesPicker);
  $('fav-btn').addEventListener('click', toggleFav);
  $('fav-filter-btn').addEventListener('click', () => setFavFilter(!favFilterOn));

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
  $('cal-label').addEventListener('click', toggleCalJump);
  let searchTimer = null;
  $('search-input').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(onSearch, 150); });

  // top bar
  $('theme-btn').addEventListener('click', toggleTheme);
  $('settings-btn').addEventListener('click', () => { renderSecuritySettings(); renderDaysOff(); startPromptsEditor(); startTemplatesEditor(); startActivitiesEditor(); showSettingsCat('appearance'); openPanel($('settings-panel')); });
  for (const btn of document.querySelectorAll('#settings-nav .settings-nav-item')) btn.addEventListener('click', () => showSettingsCat(btn.dataset.cat));
  $('quick-btn').addEventListener('click', quickCapture);
  $('stats-btn').addEventListener('click', () => { renderStats(); openPanel($('stats-panel')); });
  $('lock-btn').addEventListener('click', relock);
  $('streak').addEventListener('click', toggleStreakPop);
  $('panel-scrim').addEventListener('click', closePanel);
  for (const btn of document.querySelectorAll('[data-close]')) btn.addEventListener('click', closePanel);

  // settings panel controls
  buildThemeChoices();
  initCustomControls();
  $('reminder-toggle').addEventListener('change', saveReminder);
  $('reminder-time').addEventListener('change', saveReminder);
  $('background-toggle').addEventListener('change', async () => {
    const on = $('background-toggle').checked;
    const res = await safeCall(api.setRunInBackground, on);
    if (!res.ok) { const st = $('background-status'); if (st) st.textContent = 'That could not be changed.'; return; }
    // Report what actually happened, not what was asked for. If the tray icon
    // could not be created, promising one is a lie found out the hard way.
    $('background-toggle').checked = res.enabled;
    setBackgroundStatus(res.enabled, res.trayOk !== false);
    // Keep the startup checkbox honest: it is read once at boot, and this is the
    // setting it used to be silently inferred from, so re-read it rather than
    // letting the UI claim something the registry disagrees with.
    const sw = await safeCall(api.getStartWithWindows);
    if (sw.ok && $('startup-toggle')) $('startup-toggle').checked = sw.enabled;
  });
  $('startup-toggle').addEventListener('change', async () => {
    const on = $('startup-toggle').checked;
    const res = await safeCall(api.setStartWithWindows, on);
    const st = $('startup-status');
    if (!st) return;
    if (!res.ok) { st.textContent = 'That could not be changed.'; return; }
    if (res.startupOk === false) {
      // Windows can refuse this silently, for example under a managed policy.
      st.textContent = 'Windows did not accept that change, so Flint will not start when you sign in. This computer may be managed by someone else.';
      $('startup-toggle').checked = !on;
      return;
    }
    st.textContent = res.enabled
      ? 'Flint will open quietly in the notification area when you sign in.'
      : 'Flint will only open when you open it.';
  });
  $('hwaccel-toggle').addEventListener('change', async () => {
    const on = $('hwaccel-toggle').checked;
    const res = await safeCall(api.setHardwareAcceleration, on);
    const st = $('hwaccel-status');
    if (!st) return;
    st.textContent = res.ok ? 'Saved. This takes effect the next time Flint opens.' : 'That could not be changed.';
  });
  $('goto-system').addEventListener('click', () => showSettingsCat('system'));
  $('backup-toggle').addEventListener('change', () => saveBackupCfg({ ...backupCfg, enabled: $('backup-toggle').checked }));
  $('backup-choose-btn').addEventListener('click', async () => {
    // Main picks and stores the folder itself; we only get back the result.
    const res = await safeCall(api.chooseBackupFolder);
    if (res.canceled) return;
    if (!res.ok) { $('backup-status').textContent = res.error || 'That folder could not be used.'; return; }
    backupCfg = res.backup;
    renderBackup();
    $('backup-status').textContent = 'On. Flint will keep a copy there once a day.';
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
  $('activities-save-btn').addEventListener('click', saveActivitiesEdits);
  $('activities-reset-btn').addEventListener('click', () => { $('activities-editor').value = (window.DEFAULT_ACTIVITIES || []).join('\n'); $('activities-status').textContent = 'Defaults restored. Press Save to keep them.'; });
  $('export-file-btn').addEventListener('click', exportToFile);
  $('export-pdf-btn').addEventListener('click', exportToPdf);
  $('export-md-btn').addEventListener('click', exportToMarkdown);
  $('export-json-btn').addEventListener('click', exportToJson);
  $('export-copy-btn').addEventListener('click', copyAll);
  $('export-activities-btn').addEventListener('click', exportActivities);
  $('export-activities-pdf-btn').addEventListener('click', exportActivitiesPdf);
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
  $('update-toggle').addEventListener('change', async () => {
    const on = $('update-toggle').checked;
    const res = await safeCall(api.setUpdateSetting, on);
    // Do not promise "stays fully offline" without knowing the setting saved.
    // If it did not, Flint would still check on the next launch, and that is
    // precisely the promise a privacy-minded user would rely on.
    if (!res.ok) {
      $('update-toggle').checked = !on;
      setUpdateSettingStatus('That could not be changed, so it is unchanged.');
      return;
    }
    setUpdateSettingStatus(on ? 'Flint will check for a new version when it opens.' : 'Update checks are off, Flint stays fully offline.');
  });
  $('update-check-btn').addEventListener('click', () => { setUpdatePanel('Checking…'); api.updateCheck(); });

  renderWriterHead();
}

init();
