// An optional richer vocabulary for naming a feeling, a deeper layer on top of
// the plain Good/Mixed/Bad day marker. Words are grouped into four quadrants by
// energy (high or low) and pleasantness (pleasant or unpleasant), the same shape
// as the well-known mood-meter idea. Naming a feeling precisely is a small,
// evidence-backed help, so this is offered but never required.
//
// A day stores only the chosen words (an array of strings under __feelings); the
// quadrant grouping here is just for showing the picker.

const FEELING_QUADRANTS = [
  { key: 'hp', label: 'Higher energy, pleasant' },
  { key: 'hu', label: 'Higher energy, unpleasant' },
  { key: 'lu', label: 'Lower energy, unpleasant' },
  { key: 'lp', label: 'Lower energy, pleasant' }
];

const FEELINGS = [
  { word: 'excited', quad: 'hp' }, { word: 'joyful', quad: 'hp' }, { word: 'energised', quad: 'hp' }, { word: 'hopeful', quad: 'hp' }, { word: 'proud', quad: 'hp' }, { word: 'inspired', quad: 'hp' }, { word: 'playful', quad: 'hp' }, { word: 'motivated', quad: 'hp' }, { word: 'cheerful', quad: 'hp' }, { word: 'optimistic', quad: 'hp' }, { word: 'enthusiastic', quad: 'hp' }, { word: 'delighted', quad: 'hp' }, { word: 'confident', quad: 'hp' }, { word: 'elated', quad: 'hp' }, { word: 'upbeat', quad: 'hp' }, { word: 'eager', quad: 'hp' }, { word: 'thrilled', quad: 'hp' }, { word: 'empowered', quad: 'hp' }, { word: 'curious', quad: 'hp' }, { word: 'amused', quad: 'hp' }, { word: 'lively', quad: 'hp' }, { word: 'invigorated', quad: 'hp' },

  { word: 'anxious', quad: 'hu' }, { word: 'angry', quad: 'hu' }, { word: 'frustrated', quad: 'hu' }, { word: 'stressed', quad: 'hu' }, { word: 'restless', quad: 'hu' }, { word: 'overwhelmed', quad: 'hu' }, { word: 'irritable', quad: 'hu' }, { word: 'tense', quad: 'hu' }, { word: 'nervous', quad: 'hu' }, { word: 'worried', quad: 'hu' }, { word: 'annoyed', quad: 'hu' }, { word: 'panicked', quad: 'hu' }, { word: 'furious', quad: 'hu' }, { word: 'agitated', quad: 'hu' }, { word: 'jittery', quad: 'hu' }, { word: 'embarrassed', quad: 'hu' }, { word: 'jealous', quad: 'hu' }, { word: 'defensive', quad: 'hu' }, { word: 'shocked', quad: 'hu' }, { word: 'pressured', quad: 'hu' }, { word: 'apprehensive', quad: 'hu' }, { word: 'uneasy', quad: 'hu' },

  { word: 'sad', quad: 'lu' }, { word: 'tired', quad: 'lu' }, { word: 'lonely', quad: 'lu' }, { word: 'discouraged', quad: 'lu' }, { word: 'flat', quad: 'lu' }, { word: 'drained', quad: 'lu' }, { word: 'numb', quad: 'lu' }, { word: 'hopeless', quad: 'lu' }, { word: 'low', quad: 'lu' }, { word: 'gloomy', quad: 'lu' }, { word: 'disappointed', quad: 'lu' }, { word: 'bored', quad: 'lu' }, { word: 'weary', quad: 'lu' }, { word: 'empty', quad: 'lu' }, { word: 'guilty', quad: 'lu' }, { word: 'ashamed', quad: 'lu' }, { word: 'insecure', quad: 'lu' }, { word: 'exhausted', quad: 'lu' }, { word: 'melancholy', quad: 'lu' }, { word: 'deflated', quad: 'lu' }, { word: 'down', quad: 'lu' }, { word: 'spent', quad: 'lu' },

  { word: 'calm', quad: 'lp' }, { word: 'content', quad: 'lp' }, { word: 'relaxed', quad: 'lp' }, { word: 'grateful', quad: 'lp' }, { word: 'secure', quad: 'lp' }, { word: 'at ease', quad: 'lp' }, { word: 'rested', quad: 'lp' }, { word: 'reflective', quad: 'lp' }, { word: 'peaceful', quad: 'lp' }, { word: 'serene', quad: 'lp' }, { word: 'comfortable', quad: 'lp' }, { word: 'mellow', quad: 'lp' }, { word: 'thoughtful', quad: 'lp' }, { word: 'tender', quad: 'lp' }, { word: 'satisfied', quad: 'lp' }, { word: 'tranquil', quad: 'lp' }, { word: 'cosy', quad: 'lp' }, { word: 'settled', quad: 'lp' }, { word: 'safe', quad: 'lp' }, { word: 'gentle', quad: 'lp' }, { word: 'soothed', quad: 'lp' }, { word: 'balanced', quad: 'lp' }
];

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { FEELINGS, FEELING_QUADRANTS };
}
if (typeof window !== 'undefined') {
  window.FEELINGS = FEELINGS;
  window.FEELING_QUADRANTS = FEELING_QUADRANTS;
}
