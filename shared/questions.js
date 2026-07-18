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
    key: 'highlight', title: 'A good moment', hint: 'Something that went well, made you smile, or that you want to remember from today.'
  }, {
    key: 'challenge', title: 'Something hard', hint: 'A challenge, a worry, or anything that weighed on you. Naming it can help.'
  }, {
    key: 'grateful', title: 'Grateful for', hint: 'One or two things, big or small, that you felt thankful for today.'
  }, {
    key: 'mind', title: 'On your mind', hint: 'Whatever you are turning over right now, sorted or not.'
  }, {
    key: 'learned', title: 'Something you learned', hint: 'A lesson, an idea, or something you noticed about yourself or the world.'
  }, {
    key: 'ahead', title: 'Looking ahead', hint: 'What is next, what you are hoping for, or one small thing for tomorrow.'
  }
];

// The optional "How was today?" marker. Deliberately just three calm choices,
// with no numbers and no scores. Kept so the app and the export agree on wording.
// The key stays 'hard' so days already marked keep working; only the wording shown
// to the reader changes.
const DAY_MARKERS = [
  { key: 'good', label: 'Good day', short: 'Good' }, { key: 'mixed', label: 'Mixed day', short: 'Mixed' }, { key: 'hard', label: 'Bad day', short: 'Bad' }
];

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DEFAULT_QUESTIONS, DAY_MARKERS };
}
if (typeof window !== 'undefined') {
  window.DEFAULT_QUESTIONS = DEFAULT_QUESTIONS;
  window.DAY_MARKERS = DAY_MARKERS;
}
