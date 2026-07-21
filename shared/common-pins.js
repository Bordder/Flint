// Common passwords and patterns, used ONLY to stop the PIN strength meter
// overstating. It is not a blocklist: nothing here is refused, the estimate is
// just told the truth.
//
// Why this exists. The meter used to price a PIN purely by its character set
// and length, which is the right model for an attacker guessing blindly and the
// wrong one for the attacker actually in Flint's threat model: someone who
// copied the data folder and runs a wordlist against it offline. Measured
// against a real vault built with this app's own crypto, the PIN "password1"
// was found in 2.29 seconds while the meter called it strong and said
// "thousands of years".
//
// The list is deliberately small and hand-kept rather than a dependency: Flint
// ships no third-party code and must work with the internet off. Journal and
// diary compounds are included on purpose, because those are exactly what
// somebody naming a PIN for THIS app reaches for.
'use strict';

const COMMON_PINS = [
  // the perennial top of every breach corpus
  'password', 'passw0rd', 'p@ssword', 'p@ssw0rd', 'letmein', 'welcome', 'admin',
  'iloveyou', 'princess', 'sunshine', 'monkey', 'dragon', 'football', 'baseball',
  'superman', 'batman', 'trustno1', 'master', 'shadow', 'michael', 'jennifer',
  'jordan', 'harley', 'ranger', 'buster', 'hunter', 'thomas', 'charlie',
  'freedom', 'whatever', 'starwars', 'computer', 'internet', 'samsung', 'google',
  'chocolate', 'cookie', 'flower', 'summer', 'winter', 'spring', 'autumn',
  'london', 'liverpool', 'arsenal', 'chelsea', 'england', 'scotland', 'wales',
  'ireland', 'manchester', 'newcastle', 'rangers', 'celtic',
  // keyboard walks
  'qwerty', 'qwertyuiop', 'asdfgh', 'asdfghjkl', 'zxcvbn', 'zxcvbnm', '1qaz2wsx',
  'qazwsx', 'qweasd', 'q1w2e3', 'a1b2c3', '1q2w3e4r', 'zaq12wsx',
  // pure digits and repeats
  '123456', '1234567', '12345678', '123456789', '1234567890', '111111', '000000',
  '121212', '123123', '654321', '112233', '696969', '159753', '147258',
  // words a diary keeper reaches for, which a wordlist attack would too
  'journal', 'diary', 'mydiary', 'myjournal', 'notebook', 'secret', 'private',
  'personal', 'thoughts', 'feelings', 'memories', 'flint', 'myflint',
  'dearjournal', 'deardiary', 'writing', 'mywriting', 'mynotes', 'notes',
  'openup', 'letmewrite', 'safeplace', 'myplace', 'mysecret', 'mystory'
];

// Endings people add to make a word "strong". Each one multiplies the work an
// attacker does by a tiny amount, not by the orders of magnitude the plain
// character-set model assumes.
const COMMON_SUFFIXES = [
  '', '1', '2', '3', '12', '123', '1234', '!', '!!', '?', '.', '01', '007',
  '69', '99', '00', '11', '22', '2020', '2021', '2022', '2023', '2024', '2025',
  '2026', '123!', '1!', '@', '#'
];

const COMMON_PREFIXES = ['', 'my', 'the', 'i'];

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { COMMON_PINS, COMMON_SUFFIXES, COMMON_PREFIXES };
}
