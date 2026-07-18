// The starter set for the optional "What did today hold?" activity picker.
//
// These are only the seed. Once the user edits them (Settings, "Your
// activities"), the list they actually see is whatever is saved in
// settings.json. This file is the first-run default and the fallback if
// settings cannot be read.
//
// Each activity is a plain label; a leading emoji is just part of the text and
// works offline (system emoji font). A day stores the chosen labels as strings
// under the reserved __activities key, so editing the list later never disturbs
// days already written.

const DEFAULT_ACTIVITIES = [
  '🛏️ Rest', '💼 Work', '📚 Study', '🧹 Chores',
  '🍳 Cooked', '🏃 Exercise', '🚶 Walk', '🌳 Outdoors',
  '👥 Socialised', '📞 Kept in touch', '📅 Appointment', '🛒 Errands',
  '🎨 Hobby', '🍽️ Good meal', '😴 Poor sleep', '🤕 Pain or fatigue'
];

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DEFAULT_ACTIVITIES };
}
if (typeof window !== 'undefined') {
  window.DEFAULT_ACTIVITIES = DEFAULT_ACTIVITIES;
}
