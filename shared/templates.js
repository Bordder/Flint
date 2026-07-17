// The starter entry templates: reusable scaffolds you can drop into a day.
//
// These are only the seed. Once the user edits them, the list they actually see
// is whatever is saved in settings.json (Settings, "Entry templates"). This file
// is the first-run default and the fallback if settings cannot be read.

const DEFAULT_TEMPLATES = [
  {
    name: 'Daily review', body: 'What went well today?\n\n\nWhat was hard?\n\n\nOne thing for tomorrow:\n'
  }, {
    name: 'Gratitude', body: 'Three things I am grateful for:\n\n1. \n2. \n3. \n'
  }, {
    name: 'Decision log', body: 'The decision:\n\n\nWhy I chose it:\n\n\nWhat I expect to happen:\n\n\nWorth revisiting on:\n'
  }, {
    name: 'Brain dump', body: 'Everything on my mind, unsorted:\n\n'
  }
];

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DEFAULT_TEMPLATES };
}
if (typeof window !== 'undefined') {
  window.DEFAULT_TEMPLATES = DEFAULT_TEMPLATES;
}
