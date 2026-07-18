// Optional writing prompts: a small nudge when the page is blank.
//
// These never replace free-form writing. They are only offered when a day has
// no note yet, and are always cyclable and dismissible, never drip-fed or
// time-locked. Each carries a category so the picker can lean away from
// gratitude or looking-ahead prompts on a day the writer has marked Hard, where
// a self-kind or plain-reflection prompt fits better.

const PROMPT_LIBRARY = [
  { cat: 'reflect', text: 'What is one moment from today you want to remember, and why?' },
  { cat: 'reflect', text: 'What took most of your energy today? Was it worth it?' },
  { cat: 'reflect', text: 'If today had a title, what would it be?' },
  { cat: 'reflect', text: 'What is one thing you handled better than you would have a year ago?' },
  { cat: 'gratitude', text: 'What is one good thing from today, and what made it happen?' },
  { cat: 'gratitude', text: 'Who or what made today a little easier, and how?' },
  { cat: 'gratitude', text: 'Name a small comfort you had today, and why it helped.' },
  { cat: 'forward', text: 'What is one small thing you could do tomorrow that your future self would thank you for?' },
  { cat: 'forward', text: 'What are you quietly looking forward to?' },
  { cat: 'forward', text: 'If tomorrow held one good moment, what would you want it to be?' },
  { cat: 'savor', text: 'Describe a good moment from today slowly, as if you were back in it.' },
  { cat: 'savor', text: 'What did you see, hear, or taste today that you enjoyed?' },
  { cat: 'kind', text: 'What would you say to a friend who had the day you just had?' },
  { cat: 'kind', text: 'Where were you hard on yourself today? What is a kinder way to see it?' },
  { cat: 'kind', text: 'What do you need right now, and can you give yourself a little of it?' },
  { cat: 'hard', text: 'What felt heavy today? Naming it can take some of its weight.' },
  { cat: 'hard', text: 'What is one thing that is hard right now, and one thing that is still okay?' },
  { cat: 'hard', text: 'If today was hard, what got you through to the end of it?' },
  { cat: 'connect', text: 'Who crossed your mind today, and why?' },
  { cat: 'connect', text: 'Was there a moment of connection today, however small?' },
  { cat: 'distance', text: 'Write about today as if a friend were looking on. What would they notice?' },
  { cat: 'distance', text: 'Step back a moment. What would you tell someone you cared about who was in your position?' },
  { cat: 'values', text: 'What matters to you that showed up in today, even a little?' },
  { cat: 'values', text: 'Did today move you toward the kind of person you want to be, in some small way?' }
];

// A whole-day count, so the offered prompt is stable for a given day but shifts
// from one day to the next. Parsed from the YYYY-MM-DD string in UTC so it does
// not wobble with the local clock.
function dayNumber(iso) {
  const parts = String(iso).split('-').map(Number);
  const t = Date.UTC(parts[0] || 1970, (parts[1] || 1) - 1, parts[2] || 1);
  return Math.floor(t / 86400000);
}

// The prompt to offer for a day. `offset` advances it (the "Another" button);
// `avoidCats` lets the caller skip whole categories (Hard days skip the cheery
// ones). Cycling by offset walks the entire library, so nothing is ever hidden.
function promptForDay(iso, offset, avoidCats) {
  const lib = PROMPT_LIBRARY;
  if (!lib.length) return null;
  const avoid = new Set(avoidCats || []);
  const base = dayNumber(iso) + (Number(offset) || 0);
  for (let i = 0; i < lib.length; i++) {
    const idx = (((base + i) % lib.length) + lib.length) % lib.length;
    if (!avoid.has(lib[idx].cat)) return lib[idx];
  }
  const idx = ((base % lib.length) + lib.length) % lib.length;
  return lib[idx];
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PROMPT_LIBRARY, promptForDay };
}
if (typeof window !== 'undefined') {
  window.PROMPT_LIBRARY = PROMPT_LIBRARY;
  window.promptForDay = promptForDay;
}
