// The DEFAULT daily prompts and the day-marker options.
//
// These are only the starting point. Once the app has run, the prompts the
// user actually sees are whatever they have saved in settings.json (editable
// under Settings → "Your daily prompts"). This file is the seed used the very
// first time, and the fallback if settings can't be read.
//
// `key` is how an answer is stored in entries.json. Never reuse or repurpose a
// key that already has real answers behind it, or old writing stops showing.

const DEFAULT_QUESTIONS = [
  {
    key: 'food',
    title: 'Food and cooking',
    hint: 'How did preparing or cooking food go today? Anything you could not face, needed help with, or did differently?'
  },
  {
    key: 'eating',
    title: 'Eating and drinking',
    hint: 'How was eating and drinking today? Appetite, managing meals, anything you skipped or found hard.'
  },
  {
    key: 'washing',
    title: 'Washing and getting ready',
    hint: 'Washing, bathing, dressing, looking after yourself — how did it go today?'
  },
  {
    key: 'people',
    title: 'Being around people',
    hint: 'Any time with other people today — in person, on the phone, online. How did it feel?'
  },
  {
    key: 'out',
    title: 'Going out',
    hint: 'Did you go out, or plan to? How did journeys and places — familiar or new — go today?'
  },
  {
    key: 'walking',
    title: 'Walking and standing',
    hint: 'Walking, standing and moving about, indoors or outside. Distances, rests, aids, pain.'
  },
  {
    key: 'other',
    title: 'Anything else',
    hint: 'Anything else about today you want to keep — sleep, pain, mood, good moments, hard moments.'
  }
];

// The optional "How was today?" marker. Deliberately just three calm choices —
// no numbers, no scores. Kept here so the app and the export agree on wording.
const DAY_MARKERS = [
  { key: 'good', label: 'Good day', short: 'Good' },
  { key: 'mixed', label: 'Mixed day', short: 'Mixed' },
  { key: 'hard', label: 'Hard day', short: 'Hard' }
];

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DEFAULT_QUESTIONS, DAY_MARKERS };
}
if (typeof window !== 'undefined') {
  window.DEFAULT_QUESTIONS = DEFAULT_QUESTIONS;
  window.DAY_MARKERS = DAY_MARKERS;
}
