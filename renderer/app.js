'use strict';

/* Flint renderer. All persistence goes through window.journal (preload IPC);
   this file owns the page, the editor, the past-days list and the modals. */

const api = window.journal;

// The prompts the user sees are loaded from disk at boot (Settings lets them
// change these); until then, fall back to the built-in defaults.
let questions = (window.DEFAULT_QUESTIONS || []).map((q) => ({ ...q }));
let knownTitles = {};
// window.DAY_MARKERS is defined by shared/questions.js (a classic script that
// also declares a global `const DAY_MARKERS`), so this local must NOT reuse
// that name or the two collide with a fatal redeclaration SyntaxError.
const MARKERS = window.DAY_MARKERS || [
  { key: 'good', label: 'Good day', short: 'Good' },
  { key: 'mixed', label: 'Mixed day', short: 'Mixed' },
  { key: 'hard', label: 'Hard day', short: 'Hard' }
];

const MAX_TAGS = 20;
const MAX_TAG_LEN = 40;

let data = { version: 1, entries: {} };
let paths = null;
let currentDate = todayISO();
let currentDay = ''; // the optional day marker: '' | 'good' | 'mixed' | 'hard'
let currentTags = []; // this day's tags
let snapshot = { answers: {}, day: '', tags: [] }; // last loaded/saved state, for dirty checks
let loadFailed = false; // when true, saving is blocked so a broken load can never overwrite the real journal
let saving = false;

const $ = (id) => document.getElementById(id);

// IPC calls must never throw into nowhere — a rejected invoke would
// otherwise be a silent save failure.
async function safeCall(fn, ...args) {
  try {
    return await fn(...args);
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

/* ———————————————————————————————————————————— little helpers */

function todayISO() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0')
  ].join('-');
}

function longDate(iso) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
}

function isReservedKey(k) {
  return k === 'updatedAt' || k.startsWith('__');
}

function entryTags(entry) {
  return entry && Array.isArray(entry.__tags)
    ? entry.__tags.filter((t) => typeof t === 'string' && t.trim())
    : [];
}

function dayMarker(key) {
  return MARKERS.find((m) => m.key === key) || null;
}

// One day's filled-in answers, in prompt order, then any answers whose prompt
// has since been removed (labelled from knownTitles). Mirrors store.js.
function orderedAnswers(entry) {
  const out = [];
  const qkeys = new Set(questions.map((q) => q.key));
  for (const q of questions) {
    const v = entry[q.key];
    if (typeof v === 'string' && v.trim()) out.push({ key: q.key, title: q.title, text: v });
  }
  for (const k of Object.keys(entry)) {
    if (isReservedKey(k) || qkeys.has(k)) continue;
    const v = entry[k];
    if (typeof v === 'string' && v.trim()) {
      out.push({ key: k, title: knownTitles[k] || 'Note', text: v });
    }
  }
  return out;
}

/* ———————————————————————————————————————————— modal */

function modalIsOpen() {
  return $('modal-root').childElementCount > 0;
}

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

    const h = document.createElement('h2');
    h.id = 'modal-title';
    h.textContent = title;
    const b = document.createElement('p');
    b.className = 'modal-body';
    b.id = 'modal-body';
    b.textContent = body;
    modal.setAttribute('aria-describedby', 'modal-body');
    const row = document.createElement('div');
    row.className = 'btn-row';

    modal.append(h, b, row);
    overlay.append(modal);
    root.append(overlay);

    function close(value) {
      root.removeChild(overlay);
      document.removeEventListener('keydown', onKey, true);
      if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
      resolve(value);
    }

    const btnEls = buttons.map((spec) => {
      const btn = document.createElement('button');
      btn.textContent = spec.label;
      if (spec.kind) btn.className = spec.kind;
      btn.addEventListener('click', () => close(spec.value));
      row.append(btn);
      return btn;
    });

    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(buttons[buttons.length - 1].value); // last button = safe choice
      } else if (e.key === 'Tab') {
        // keep focus inside the dialog — including when focus has wandered
        // off the buttons entirely (idx === -1, e.g. after clicking the text)
        const focusables = btnEls;
        const idx = focusables.indexOf(document.activeElement);
        if (idx === -1) {
          e.preventDefault();
          focusables[e.shiftKey ? focusables.length - 1 : 0].focus();
        } else if (e.shiftKey && idx === 0) {
          e.preventDefault();
          focusables[focusables.length - 1].focus();
        } else if (!e.shiftKey && idx === focusables.length - 1) {
          e.preventDefault();
          focusables[0].focus();
        }
      }
    }
    document.addEventListener('keydown', onKey, true);
    const initial = buttons.findIndex((s) => s.value === focusValue);
    btnEls[initial === -1 ? 0 : initial].focus();
  });
}

/* ———————————————————————————————————————————— status line */

let statusTimer = null;
function setStatus(msg, { error = false, sticky = false } = {}) {
  const el = $('status');
  el.textContent = msg;
  el.classList.toggle('error', error);
  clearTimeout(statusTimer);
  if (msg && !sticky && !error) {
    statusTimer = setTimeout(() => {
      el.textContent = '';
    }, 8000);
  }
}

/* ———————————————————————————————————————————— editor */

function buildEditorSections() {
  const holder = $('sections');
  holder.textContent = '';
  for (const q of questions) {
    const wrap = document.createElement('div');
    wrap.className = 'q-section';

    const label = document.createElement('label');
    label.setAttribute('for', `box-${q.key}`);
    label.textContent = q.title;

    const hint = document.createElement('p');
    hint.className = 'q-hint';
    hint.id = `hint-${q.key}`;
    hint.textContent = q.hint || '';
    if (!q.hint) hint.hidden = true;

    const ta = document.createElement('textarea');
    ta.id = `box-${q.key}`;
    if (q.hint) ta.setAttribute('aria-describedby', `hint-${q.key}`);
    ta.rows = 3;
    ta.addEventListener('input', () => autosize(ta));

    wrap.append(label, hint, ta);
    holder.append(wrap);
  }
}

function buildDayMarker() {
  const holder = $('day-marker');
  holder.textContent = '';
  for (const m of MARKERS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'marker-btn';
    btn.dataset.key = m.key;
    btn.textContent = m.short;
    btn.setAttribute('aria-pressed', 'false');
    btn.addEventListener('click', () => {
      currentDay = currentDay === m.key ? '' : m.key; // click again to clear
      renderDayMarker();
    });
    holder.append(btn);
  }
}

function renderDayMarker() {
  for (const btn of $('day-marker').querySelectorAll('.marker-btn')) {
    const on = btn.dataset.key === currentDay;
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-pressed', String(on));
  }
}

function renderTags() {
  const list = $('tag-list');
  list.textContent = '';
  currentTags.forEach((tag, i) => {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    const text = document.createElement('span');
    text.textContent = tag;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'tag-remove';
    remove.setAttribute('aria-label', `Remove tag ${tag}`);
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      currentTags.splice(i, 1);
      renderTags();
      $('tag-input').focus();
    });
    chip.append(text, remove);
    list.append(chip);
  });
}

function addTagFromInput() {
  const input = $('tag-input');
  const raw = input.value.trim().replace(/\s+/g, ' ');
  input.value = '';
  if (!raw) return;
  for (const part of raw.split(',')) {
    const tag = part.trim().slice(0, MAX_TAG_LEN);
    if (!tag) continue;
    if (currentTags.length >= MAX_TAGS) break;
    if (currentTags.some((t) => t.toLowerCase() === tag.toLowerCase())) continue;
    currentTags.push(tag);
  }
  renderTags();
}

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight + 2, 600) + 'px';
}

function collectAnswers() {
  const vals = {};
  for (const q of questions) {
    const el = $(`box-${q.key}`);
    vals[q.key] = el ? el.value : '';
  }
  return vals;
}

function currentState() {
  return { answers: collectAnswers(), day: currentDay, tags: currentTags.slice() };
}

function isDirty() {
  const s = currentState();
  if (s.day !== snapshot.day) return true;
  if (s.tags.join('\n') !== snapshot.tags.join('\n')) return true;
  const keys = new Set([...Object.keys(s.answers), ...Object.keys(snapshot.answers)]);
  for (const k of keys) {
    if ((s.answers[k] || '') !== (snapshot.answers[k] || '')) return true;
  }
  return false;
}

function refreshDateMax() {
  $('entry-date').max = todayISO();
}

// Builds the entry to store, preserving answers to prompts that are no longer
// shown (so editing a day never drops words the user wrote under an old prompt).
function buildEntry(prev, answers) {
  const entry = {};
  const qkeys = new Set(questions.map((q) => q.key));
  if (prev) {
    for (const k of Object.keys(prev)) {
      if (isReservedKey(k) || qkeys.has(k)) continue;
      const v = prev[k];
      if (typeof v === 'string' && v.trim()) entry[k] = v; // orphaned answer, kept
    }
  }
  for (const q of questions) {
    const v = answers[q.key] || '';
    if (v.trim()) entry[q.key] = v;
  }
  if (currentDay) entry.__day = currentDay;
  if (currentTags.length) entry.__tags = currentTags.slice();
  return entry;
}

function entryHasAnyContent(entry) {
  if (entry.__day) return true;
  if (Array.isArray(entry.__tags) && entry.__tags.length) return true;
  for (const k of Object.keys(entry)) {
    if (isReservedKey(k)) continue;
    if (typeof entry[k] === 'string' && entry[k].trim()) return true;
  }
  return false;
}

function loadEditor(dateIso) {
  currentDate = dateIso;
  refreshDateMax();
  $('entry-date').value = dateIso;
  const entry = data.entries[dateIso] || {};
  for (const q of questions) {
    const ta = $(`box-${q.key}`);
    if (!ta) continue;
    ta.value = typeof entry[q.key] === 'string' ? entry[q.key] : '';
    autosize(ta);
  }
  currentDay = typeof entry.__day === 'string' ? entry.__day : '';
  currentTags = entryTags(entry).slice();
  $('tag-input').value = '';
  renderDayMarker();
  renderTags();
  snapshot = currentState();
  renderEditorSub();
}

function renderEditorSub() {
  const entry = data.entries[currentDate];
  let suffix = 'not written yet';
  if (entry) {
    suffix = 'written';
    if (entry.updatedAt) {
      const d = new Date(entry.updatedAt);
      if (!isNaN(d)) {
        suffix = `last saved ${d.toLocaleDateString('en-GB', {
          day: 'numeric',
          month: 'short'
        })}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
      }
    }
  }
  $('editor-sub').textContent = `${longDate(currentDate)} — ${suffix}`;
}

/* Saves whatever is in the editor for the current date.
   Returns true when the words are safely on disk (or there was nothing to do). */
async function saveCurrent() {
  if (saving) return false;

  // If the journal never loaded, its history exists only on disk — writing
  // our near-empty in-memory copy over it would silently erase everything.
  if (loadFailed) {
    await showModal({
      title: 'Saving is switched off for now',
      body:
        'Your journal file could not be opened when the app started, so saving ' +
        'is blocked to protect the entries already on disk.\n\n' +
        'Everything you typed is still on the page. Use "Try loading again" in ' +
        'the yellow notice at the top — once your journal opens, saving comes ' +
        'straight back.',
      buttons: [{ label: 'Go back to my words', value: 'ok', kind: 'primary' }]
    });
    return false;
  }

  saving = true;
  $('save-btn').disabled = true;
  try {
    const existed = Object.prototype.hasOwnProperty.call(data.entries, currentDate);
    const previous = existed ? data.entries[currentDate] : undefined;
    const entry = buildEntry(previous, collectAnswers());
    const hasContent = entryHasAnyContent(entry);

    if (!hasContent && !existed) {
      setStatus('Nothing written for this day yet — nothing to save.');
      return true;
    }

    if (hasContent) {
      entry.updatedAt = new Date().toISOString();
      data.entries[currentDate] = entry;
    } else {
      delete data.entries[currentDate];
    }

    const res = await safeCall(api.save, data);
    if (res.ok) {
      snapshot = currentState();
      setStatus(hasContent ? 'Saved.' : 'This day has been removed.');
      if (res.backupWarning) showNotice(res.backupWarning);
      renderEditorSub();
      renderCount();
      renderList();
      return true;
    }

    // The save failed: put the in-memory data back the way the disk still has
    // it, keep the words safely in the boxes, and say so clearly.
    if (existed) data.entries[currentDate] = previous;
    else delete data.entries[currentDate];
    setStatus('Not saved — see the message.', { error: true, sticky: true });
    await showModal({
      title: 'Your words could not be saved',
      body:
        (res.error || 'Something went wrong writing to disk.') +
        '\n\nNothing has been lost — everything you typed is still on the page. ' +
        'Please try saving again. If it keeps failing, check that the disk is not ' +
        'full and that the folder shown in Settings is writable.',
      buttons: [{ label: 'Go back to my words', value: 'ok', kind: 'primary' }]
    });
    return false;
  } finally {
    saving = false;
    $('save-btn').disabled = false;
  }
}

/* If there are unsaved words, ask before doing something that would leave
   them behind. Returns true when it is OK to continue. */
async function guardDirty(actionLabel) {
  if (!isDirty()) return true;
  const choice = await showModal({
    title: 'You have unsaved words',
    body: `Save ${longDate(currentDate)} before ${actionLabel}?`,
    buttons: [
      { label: 'Save first', value: 'save', kind: 'primary' },
      { label: "Don't save", value: 'discard' },
      { label: 'Stay here', value: 'stay' }
    ]
  });
  if (choice === 'save') return await saveCurrent();
  return choice === 'discard';
}

/* ———————————————————————————————————————————— past days list */

function activeFilters() {
  return {
    term: $('search-input').value.trim().toLowerCase(),
    from: $('from-date').value,
    to: $('to-date').value
  };
}

function entryMatches(entry, term) {
  if (!term) return true;
  for (const k of Object.keys(entry)) {
    if (isReservedKey(k)) continue;
    const v = entry[k];
    if (typeof v === 'string' && v.toLowerCase().includes(term)) return true;
  }
  return entryTags(entry).some((t) => t.toLowerCase().includes(term));
}

function previewAround(text, term, width = 240) {
  const flat = text.trim();
  if (flat.length <= width) return flat;
  let start = 0;
  if (term) {
    const at = flat.toLowerCase().indexOf(term);
    if (at > width / 2) start = Math.max(0, at - Math.floor(width / 2));
  }
  const slice = flat.slice(start, start + width);
  return (start > 0 ? '… ' : '') + slice + (start + width < flat.length ? ' …' : '');
}

// Builds text + <mark> nodes directly — no innerHTML, so neither the entry
// text nor the search term can ever be interpreted as markup, and matches
// can never land inside an escaped entity.
function highlightInto(parent, text, term) {
  if (!term) {
    parent.textContent = text;
    return;
  }
  const lower = text.toLowerCase();
  const needle = term.toLowerCase();
  let i = 0;
  for (;;) {
    const at = lower.indexOf(needle, i);
    if (at === -1) {
      parent.append(text.slice(i));
      return;
    }
    if (at > i) parent.append(text.slice(i, at));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(at, at + needle.length);
    parent.append(mark);
    i = at + needle.length;
  }
}

function renderCount() {
  const n = Object.keys(data.entries).length;
  $('day-count').textContent =
    n === 0 ? '' : n === 1 ? "You've written 1 day." : `You've written ${n} days.`;
}

function renderList() {
  const { term, from, to } = activeFilters();
  const holder = $('days-list');
  holder.textContent = '';

  const allDates = Object.keys(data.entries).sort().reverse();
  const shown = allDates.filter((date) => {
    if (from && date < from) return false;
    if (to && date > to) return false;
    return entryMatches(data.entries[date], term);
  });

  const summary = $('list-summary');
  if (allDates.length === 0) {
    summary.textContent = '';
    const p = document.createElement('p');
    p.className = 'empty-state';
    p.textContent = 'Nothing here yet. The first day you save will appear here.';
    holder.append(p);
    return;
  }
  const filtering = term || from || to;
  summary.textContent = filtering
    ? `Showing ${shown.length} of ${allDates.length} ${allDates.length === 1 ? 'day' : 'days'}.`
    : '';

  if (shown.length === 0) {
    const p = document.createElement('p');
    p.className = 'empty-state';
    p.textContent = 'No days match. Try different words or dates.';
    holder.append(p);
    return;
  }

  for (const date of shown) {
    holder.append(dayCard(date, term));
  }
}

function dayCard(date, term) {
  const entry = data.entries[date];
  const card = document.createElement('article');
  card.className = 'day-card';

  const head = document.createElement('div');
  head.className = 'day-card-head';
  const h = document.createElement('h3');
  h.textContent = longDate(date);
  const actions = document.createElement('div');
  actions.className = 'day-card-actions';

  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.textContent = 'Open';
  openBtn.setAttribute('aria-label', `Open ${longDate(date)}`);
  openBtn.addEventListener('click', async () => {
    if (!(await guardDirty('opening another day'))) return;
    loadEditor(date);
    $('editor').scrollIntoView();
    const first = questions[0] && $(`box-${questions[0].key}`);
    if (first) first.focus();
  });

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'danger';
  delBtn.textContent = 'Delete';
  delBtn.setAttribute('aria-label', `Delete ${longDate(date)}`);
  delBtn.addEventListener('click', () => deleteDay(date));

  actions.append(openBtn, delBtn);
  head.append(h, actions);
  card.append(head);

  // day marker + tags row
  const marker = dayMarker(entry.__day);
  const tags = entryTags(entry);
  if (marker || tags.length) {
    const meta = document.createElement('div');
    meta.className = 'day-card-meta';
    if (marker) {
      const badge = document.createElement('span');
      badge.className = `day-badge day-badge-${marker.key}`;
      badge.textContent = marker.label;
      meta.append(badge);
    }
    for (const tag of tags) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tag-chip tag-chip-clickable';
      chip.textContent = tag;
      chip.title = `Show days tagged “${tag}”`;
      chip.addEventListener('click', () => {
        $('search-input').value = tag;
        renderList();
        $('past-heading').scrollIntoView();
      });
      meta.append(chip);
    }
    card.append(meta);
  }

  for (const sec of orderedAnswers(entry)) {
    if (term && !sec.text.toLowerCase().includes(term)) {
      continue; // when searching, only show the boxes that contain the term
    }
    const secEl = document.createElement('div');
    secEl.className = 'day-section';
    const h4 = document.createElement('h4');
    h4.textContent = sec.title;
    const p = document.createElement('p');
    highlightInto(p, previewAround(sec.text, term), term);
    secEl.append(h4, p);
    card.append(secEl);
  }
  return card;
}

async function deleteDay(date) {
  if (loadFailed) {
    await saveCurrent(); // shows the saving-is-blocked explanation
    return;
  }

  // Deleting the day that is open in the editor also clears the boxes — if
  // there are unsaved words sitting in them, say so before they go.
  const alsoLosesUnsaved = date === currentDate && isDirty();
  const choice = await showModal({
    title: `Delete ${longDate(date)}?`,
    body:
      "This removes that day's notes from your journal. " +
      'A backup copy from before this change stays in your backups folder.' +
      (alsoLosesUnsaved
        ? '\n\nThis day is open on the page with unsaved words in the boxes — ' +
          'deleting will discard those words too, and they are not in any backup.'
        : ''),
    buttons: [
      { label: 'Delete this day', value: 'delete', kind: 'danger' },
      { label: 'Keep it', value: 'keep', kind: 'primary' }
    ],
    focusValue: 'keep' // never let a reflex Enter land on the destructive choice
  });
  if (choice !== 'delete') return;

  const previous = data.entries[date];
  delete data.entries[date];
  const res = await safeCall(api.save, data);
  if (!res.ok) {
    data.entries[date] = previous; // disk unchanged, stay consistent with it
    await showModal({
      title: 'That day could not be removed',
      body:
        (res.error || 'Something went wrong writing to disk.') +
        '\n\nNothing was changed.',
      buttons: [{ label: 'OK', value: 'ok', kind: 'primary' }]
    });
    renderList();
    return;
  }
  if (date === currentDate) loadEditor(currentDate);
  renderCount();
  renderList();
  renderEditorSub();
  setStatus(`${longDate(date)} removed.`);
  // the Delete button that had focus no longer exists; land somewhere sensible
  $('past-heading').focus();
}

/* ———————————————————————————————————————————— export */

function setExportStatus(msg, error = false) {
  const el = $('export-status');
  el.textContent = msg;
  el.classList.toggle('error', error);
}

async function ensureSavedForExport() {
  if (!isDirty()) return true;
  const choice = await showModal({
    title: 'Include what you just wrote?',
    body: 'You have unsaved words on the page. Save first so they are included?',
    buttons: [
      { label: 'Save, then continue', value: 'save', kind: 'primary' },
      { label: 'Continue without them', value: 'skip' },
      { label: 'Cancel', value: 'cancel' }
    ]
  });
  if (choice === 'save') return await saveCurrent();
  return choice === 'skip';
}

async function exportToFile() {
  if (!(await ensureSavedForExport())) return;
  setExportStatus('');
  const res = await safeCall(api.exportToFile);
  if (!res.ok) {
    setExportStatus(`The file could not be written: ${res.error}`, true);
  } else if (res.canceled) {
    setExportStatus('');
  } else {
    setExportStatus(`Saved to ${res.path}`);
  }
}

async function exportToPdf() {
  if (!(await ensureSavedForExport())) return;
  setExportStatus('Making the PDF…');
  const res = await safeCall(api.exportToPdf);
  if (!res.ok) {
    setExportStatus(`The PDF could not be written: ${res.error}`, true);
  } else if (res.canceled) {
    setExportStatus('');
  } else {
    setExportStatus(`Saved to ${res.path}`);
  }
}

async function copyAll() {
  if (!(await ensureSavedForExport())) return;
  const res = await safeCall(api.copyAll);
  if (!res.ok) {
    setExportStatus(`Could not copy: ${res.error}`, true);
  } else {
    setExportStatus(
      res.days === 1
        ? 'Copied 1 day to the clipboard.'
        : `Copied ${res.days} days to the clipboard.`
    );
  }
}

/* ———————————————————————————————————————————— notices */

function showNotice(msg) {
  const el = $('load-notice');
  el.textContent = msg;
  el.hidden = false;
}

// Load-failure notice with a retry button. Saving stays blocked until a
// retry succeeds, so a broken start can never overwrite the journal.
function showLoadErrorNotice(errorMsg) {
  const el = $('load-notice');
  el.textContent = '';
  const p = document.createElement('p');
  p.style.margin = '0 0 0.6rem';
  p.textContent =
    `Your journal could not be opened: ${errorMsg} ` +
    'To protect the entries already on disk, saving is switched off until it opens properly. ' +
    'You can safely keep writing — your words stay on the page.';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Try loading again';
  btn.addEventListener('click', retryLoad);
  el.append(p, btn);
  el.hidden = false;
}

async function retryLoad() {
  const res = await safeCall(api.load);
  if (!res.ok) {
    showLoadErrorNotice(res.error);
    return;
  }
  loadFailed = false;
  data = res.data;
  paths = res.paths;
  if (paths) $('data-path').textContent = paths.dataFile;
  const el = $('load-notice');
  el.textContent = '';
  el.hidden = true;
  if (res.warning) showNotice(res.warning);
  // keep anything typed in the boxes; if they are untouched, show the day
  // as it exists on disk
  if (!isDirty()) loadEditor(currentDate);
  renderCount();
  renderList();
  renderEditorSub();
  setStatus('Your journal is open again — saving is back on.');
}

/* ———————————————————————————————————————————— theme */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
}

/* ———————————————————————————————————————————— updates
   "Notify, ask before installing". The banner only appears when there is
   genuinely a newer version; a failed or empty check shows nothing (except a
   quiet line when the user pressed "Check now" themselves). */

function updBanner() { return $('update-banner'); }

function hideUpdateBanner() {
  const el = updBanner();
  el.textContent = '';
  el.hidden = true;
}

function showUpdateBanner(message, buttons) {
  const el = updBanner();
  el.textContent = '';
  const p = document.createElement('p');
  p.className = 'update-text';
  p.textContent = message;
  el.append(p);
  if (buttons && buttons.length) {
    const row = document.createElement('div');
    row.className = 'btn-row';
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = b.label;
      if (b.kind) btn.className = b.kind;
      btn.addEventListener('click', b.onClick);
      row.append(btn);
    }
    el.append(row);
  }
  el.hidden = false;
}

function setUpdateSettingStatus(msg) {
  $('update-setting-status').textContent = msg || '';
}

function handleUpdateStatus({ status, info, manual }) {
  const version = info && info.version ? ` (version ${info.version})` : '';
  switch (status) {
    case 'checking':
      if (manual) setUpdateSettingStatus('Checking…');
      break;
    case 'available':
      if (manual) setUpdateSettingStatus('');
      showUpdateBanner(`A new version of Flint is available${version}.`, [
        {
          label: 'Download',
          kind: 'primary',
          onClick: () => {
            showUpdateBanner('Downloading update…');
            api.updateDownload();
          }
        },
        { label: 'Not now', onClick: hideUpdateBanner }
      ]);
      break;
    case 'progress':
      showUpdateBanner(
        `Downloading update… ${info && info.percent != null ? info.percent + '%' : ''}`.trim()
      );
      break;
    case 'ready':
      showUpdateBanner(`Update${version} downloaded and ready.`, [
        { label: 'Install and restart', kind: 'primary', onClick: installUpdateFlow },
        { label: 'Later', onClick: hideUpdateBanner }
      ]);
      break;
    case 'none':
      if (manual) setUpdateSettingStatus("You're on the latest version.");
      break;
    case 'error':
      if (manual) setUpdateSettingStatus("Couldn't check just now — are you online?");
      break;
    case 'unsupported':
      if (manual) setUpdateSettingStatus('Updates apply to the installed app, not this test run.');
      break;
  }
}

async function installUpdateFlow() {
  // installing restarts the app — never lose unsaved words to it
  if (!(await guardDirty('installing the update'))) return;
  showUpdateBanner('Installing… Flint will restart.');
  await safeCall(api.updateInstall);
}

/* ———————————————————————————————————————————— PIN gate + settings */

function showPinGate(dataDir) {
  return new Promise((resolve) => {
    const gate = $('pin-gate');
    gate.hidden = false;
    $('skip-link').hidden = true; // nothing behind the gate to skip to yet
    $('pin-recovery-path').textContent = dataDir || '';
    const input = $('pin-input');
    input.focus();

    $('pin-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const res = await safeCall(api.pinVerify, input.value);
      if (res.ok && res.valid) {
        gate.hidden = true;
        $('skip-link').hidden = false;
        resolve();
      } else {
        $('pin-error').textContent = res.ok
          ? "That PIN doesn't match. Try again, or use “Forgotten your PIN?” below."
          : `Something went wrong checking the PIN: ${res.error}`;
        input.value = '';
        input.focus();
      }
    });

    $('pin-forgot').addEventListener('click', () => {
      const panel = $('pin-recovery');
      const btn = $('pin-forgot');
      panel.hidden = !panel.hidden;
      btn.setAttribute('aria-expanded', String(!panel.hidden));
    });
  });
}

async function renderPinSettings(announce) {
  const status = await safeCall(api.pinStatus);
  const hasPin = status.ok && status.set;
  $('pin-explain').textContent = hasPin
    ? 'A PIN is set. It is asked for when Flint opens. It only hides the window — ' +
      'your words on disk stay readable, so a forgotten PIN can never lock you out: ' +
      'deleting settings.json in your data folder removes the PIN and touches nothing else.'
    : 'Optional. If you set a PIN, Flint asks for it when it opens. It is a privacy ' +
      'curtain, not encryption — your words on disk stay readable, so a forgotten PIN ' +
      'can never lock you out.';

  const holder = $('pin-settings');
  holder.textContent = '';

  const form = document.createElement('form');
  form.className = 'pin-form-grid';

  function field(labelText, id) {
    const label = document.createElement('label');
    label.setAttribute('for', id);
    label.textContent = labelText;
    const input = document.createElement('input');
    input.type = 'password';
    input.id = id;
    input.inputMode = 'numeric';
    input.autocomplete = 'off';
    input.maxLength = 10;
    return { label, input };
  }

  const msg = document.createElement('p');
  msg.className = 'status';
  msg.setAttribute('role', 'status');

  if (!hasPin) {
    const a = field('New PIN (4–10 digits)', 'pin-new');
    const b = field('Type it again', 'pin-confirm');
    const btn = document.createElement('button');
    btn.type = 'submit';
    btn.textContent = 'Set PIN';
    form.append(a.label, a.input, b.label, b.input, btn, msg);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.classList.remove('error');
      if (a.input.value !== b.input.value) {
        msg.textContent = 'Those two PINs are not the same.';
        msg.classList.add('error');
        return;
      }
      const res = await safeCall(api.pinSet, a.input.value);
      if (res.ok) {
        renderPinSettings('PIN set. Flint will ask for it next time it opens.');
      } else {
        msg.textContent = res.error;
        msg.classList.add('error');
      }
    });
  } else {
    const cur = field('Current PIN', 'pin-current');
    const removeBtn = document.createElement('button');
    removeBtn.type = 'submit';
    removeBtn.textContent = 'Remove PIN';
    form.append(cur.label, cur.input, removeBtn, msg);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.classList.remove('error');
      const res = await safeCall(api.pinRemove, cur.input.value);
      if (res.ok && res.valid) {
        renderPinSettings('PIN removed. Flint will open without asking.');
      } else {
        msg.textContent = res.ok ? "That PIN doesn't match." : res.error;
        msg.classList.add('error');
        cur.input.value = '';
      }
    });
  }
  holder.append(form);

  // announce the outcome and keep keyboard focus in the settings area — the
  // form the user was in has just been rebuilt
  $('pin-status').textContent = announce || '';
  if (announce) {
    const next = holder.querySelector('input, button');
    if (next) next.focus();
  }
}

/* ———— prompt (question) editor in Settings ———— */

// A working copy the user edits; only written to disk on Save.
let promptDraft = [];

function renderPromptsEditor(announce) {
  const holder = $('prompts-list');
  holder.textContent = '';

  promptDraft.forEach((q, i) => {
    const row = document.createElement('div');
    row.className = 'prompt-row';

    const titleLabel = document.createElement('label');
    titleLabel.className = 'visually-hidden';
    titleLabel.setAttribute('for', `prompt-title-${i}`);
    titleLabel.textContent = `Prompt ${i + 1} title`;
    const title = document.createElement('input');
    title.type = 'text';
    title.id = `prompt-title-${i}`;
    title.className = 'prompt-title';
    title.value = q.title;
    title.placeholder = 'Prompt title (e.g. Work, Exercise, Gratitude)';
    title.maxLength = 200;
    title.addEventListener('input', () => { promptDraft[i].title = title.value; });

    const hintLabel = document.createElement('label');
    hintLabel.className = 'visually-hidden';
    hintLabel.setAttribute('for', `prompt-hint-${i}`);
    hintLabel.textContent = `Prompt ${i + 1} helper text`;
    const hint = document.createElement('input');
    hint.type = 'text';
    hint.id = `prompt-hint-${i}`;
    hint.className = 'prompt-hint';
    hint.value = q.hint || '';
    hint.placeholder = 'Optional helper line shown under the box';
    hint.maxLength = 1000;
    hint.addEventListener('input', () => { promptDraft[i].hint = hint.value; });

    const controls = document.createElement('div');
    controls.className = 'prompt-controls';
    const up = iconBtn('↑', `Move “${q.title || 'prompt'}” up`, () => movePrompt(i, -1));
    up.disabled = i === 0;
    const down = iconBtn('↓', `Move “${q.title || 'prompt'}” down`, () => movePrompt(i, 1));
    down.disabled = i === promptDraft.length - 1;
    const del = iconBtn('×', `Remove “${q.title || 'prompt'}”`, () => {
      promptDraft.splice(i, 1);
      renderPromptsEditor();
    });
    del.classList.add('danger');
    controls.append(up, down, del);

    row.append(titleLabel, title, hintLabel, hint, controls);
    holder.append(row);
  });

  $('prompts-status').textContent = announce || '';
}

function iconBtn(symbol, label, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'prompt-icon';
  btn.textContent = symbol;
  btn.setAttribute('aria-label', label);
  btn.addEventListener('click', onClick);
  return btn;
}

function movePrompt(i, delta) {
  const j = i + delta;
  if (j < 0 || j >= promptDraft.length) return;
  const tmp = promptDraft[i];
  promptDraft[i] = promptDraft[j];
  promptDraft[j] = tmp;
  renderPromptsEditor();
}

function startPromptsEditor() {
  promptDraft = questions.map((q) => ({ key: q.key, title: q.title, hint: q.hint || '' }));
  renderPromptsEditor();
}

async function savePrompts() {
  const cleaned = promptDraft
    .map((q) => ({ key: q.key, title: (q.title || '').trim(), hint: (q.hint || '').trim() }))
    .filter((q) => q.title);
  if (!cleaned.length) {
    renderPromptsEditor('Add at least one prompt with a title before saving.');
    return;
  }
  // Changing the prompts rebuilds the editor, which would drop anything unsaved
  // in the boxes — save or discard it first.
  if (!(await guardDirty('changing your prompts'))) return;

  const res = await safeCall(api.setQuestions, cleaned);
  if (!res.ok) {
    renderPromptsEditor(res.error || 'Those prompts could not be saved.');
    return;
  }
  questions = res.questions;
  const fresh = await safeCall(api.getQuestions);
  if (fresh.ok) knownTitles = fresh.knownTitles || {};
  buildEditorSections();
  loadEditor(currentDate);
  renderList();
  startPromptsEditor();
  renderPromptsEditor('Saved. Your prompts are updated.');
}

/* ———————————————————————————————————————————— boot */

async function init() {
  // theme first, so the PIN gate and page appear in the right colours
  const themeRes = await safeCall(api.getTheme);
  applyTheme(themeRes.ok ? themeRes.theme : 'light');

  const pinStatus = await safeCall(api.pinStatus);
  const gateShown = pinStatus.ok && pinStatus.set;
  if (gateShown) {
    await showPinGate(pinStatus.dataDir);
  }

  // load the user's prompts (falls back to defaults already in `questions`)
  const qRes = await safeCall(api.getQuestions);
  if (qRes.ok && Array.isArray(qRes.questions) && qRes.questions.length) {
    questions = qRes.questions;
    knownTitles = qRes.knownTitles || {};
  }

  const res = await safeCall(api.load);
  $('app').hidden = false;

  if (!res.ok) {
    loadFailed = true;
    showLoadErrorNotice(res.error);
  } else {
    data = res.data;
    paths = res.paths;
    if (res.warning) showNotice(res.warning);
  }

  if (paths) $('data-path').textContent = paths.dataFile;

  buildEditorSections();
  buildDayMarker();

  const dateInput = $('entry-date');
  loadEditor(todayISO());

  // 'today' moves at midnight while the app sits open; keep the picker's
  // ceiling fresh whenever the window comes back into use
  window.addEventListener('focus', refreshDateMax);

  if (gateShown) {
    const first = questions[0] && $(`box-${questions[0].key}`);
    if (first) first.focus(); // hand focus from the unlocked gate to the page
  }

  dateInput.addEventListener('change', async () => {
    refreshDateMax();
    const chosen = dateInput.value;
    if (!chosen || chosen === currentDate) return;
    if (chosen > todayISO()) {
      dateInput.value = currentDate;
      return;
    }
    if (!(await guardDirty('moving to another day'))) {
      dateInput.value = currentDate;
      return;
    }
    loadEditor(chosen);
  });

  $('today-btn').addEventListener('click', async () => {
    if (currentDate === todayISO()) return;
    if (!(await guardDirty('going back to today'))) return;
    loadEditor(todayISO());
  });

  $('save-btn').addEventListener('click', () => saveCurrent());

  // tags: Enter or comma adds; Backspace on empty input removes the last one
  $('tag-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTagFromInput();
    } else if (e.key === 'Backspace' && !e.target.value && currentTags.length) {
      currentTags.pop();
      renderTags();
    }
  });
  $('tag-input').addEventListener('blur', addTagFromInput);

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (!modalIsOpen()) saveCurrent();
    }
  });

  let searchTimer = null;
  $('search-input').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderList, 150);
  });
  $('from-date').addEventListener('change', renderList);
  $('to-date').addEventListener('change', renderList);
  $('clear-filters').addEventListener('click', () => {
    $('search-input').value = '';
    $('from-date').value = '';
    $('to-date').value = '';
    renderList();
  });

  $('export-file-btn').addEventListener('click', exportToFile);
  $('export-pdf-btn').addEventListener('click', exportToPdf);
  $('export-copy-btn').addEventListener('click', copyAll);
  $('open-folder-btn').addEventListener('click', () => api.openDataFolder());

  // appearance
  const themeToggle = $('theme-toggle');
  themeToggle.checked = document.documentElement.dataset.theme === 'dark';
  themeToggle.addEventListener('change', async () => {
    const theme = themeToggle.checked ? 'dark' : 'light';
    applyTheme(theme);
    await safeCall(api.setTheme, theme);
  });

  // updates
  api.onUpdateStatus(handleUpdateStatus);
  const verRes = await safeCall(api.appVersion);
  $('version-line').textContent = verRes.ok ? `Flint version ${verRes.version}` : 'Flint';
  const updSetting = await safeCall(api.getUpdateSetting);
  $('update-toggle').checked = updSetting.ok ? updSetting.enabled : true;
  $('update-toggle').addEventListener('change', async () => {
    const on = $('update-toggle').checked;
    await safeCall(api.setUpdateSetting, on);
    setUpdateSettingStatus(
      on
        ? 'Flint will check for a new version when it opens.'
        : 'Update checks are off — Flint stays fully offline.'
    );
  });
  $('update-check-btn').addEventListener('click', () => {
    setUpdateSettingStatus('Checking…');
    api.updateCheck();
  });

  // prompts editor
  startPromptsEditor();
  $('prompt-add-btn').addEventListener('click', () => {
    promptDraft.push({ key: null, title: '', hint: '' });
    renderPromptsEditor();
    const inputs = $('prompts-list').querySelectorAll('.prompt-title');
    if (inputs.length) inputs[inputs.length - 1].focus();
  });
  $('prompt-save-btn').addEventListener('click', savePrompts);
  $('prompt-reset-btn').addEventListener('click', () => {
    startPromptsEditor();
    renderPromptsEditor('Changes discarded.');
  });

  api.onMenu((action) => {
    if (modalIsOpen()) return; // a dialog is asking something — let it finish
    if (action === 'save') saveCurrent();
    if (action === 'export') exportToFile();
    if (action === 'export-pdf') exportToPdf();
  });

  api.onQueryDirty(() => api.dirtyReply(isDirty()));

  api.onSaveThenClose(async () => {
    const ok = await saveCurrent();
    if (ok) api.closeNow();
    // if the save failed, the error modal is showing and the window stays open
  });

  renderCount();
  renderList();
  renderPinSettings();
}

init();
