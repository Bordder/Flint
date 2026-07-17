// Encryption for Flint (envelope scheme).
//
// The journal is encrypted at rest with AES-256-GCM under a random 256-bit
// data key (DK). The DK is never stored directly; it is wrapped (encrypted)
// twice, so the journal can be opened by EITHER:
//   * the PIN            (day to day), or
//   * the recovery code  (shown once when encryption is turned on).
//
// So a forgotten PIN is not fatal: the recovery code still opens it. Losing
// BOTH the PIN and the recovery code means the journal cannot be recovered by
// anyone, which is the point of real encryption.
//
// On-disk vault shape (this is what entries.json becomes when encrypted):
//   {
//     flintEncrypted: 1, kdf: "scrypt",
//     pin:      { salt, iv, tag, ct },   // DK wrapped under scrypt(PIN)
//     recovery: { salt, iv, tag, ct },   // DK wrapped under scrypt(recovery code)
//     body:     { iv, tag, ct }          // the entries JSON, encrypted under DK
//   }
// Backups are copies of this file, so backups stay encrypted too.

'use strict';

const crypto = require('crypto');
const { promisify } = require('util');

// Async on purpose. Derivation is meant to be slow, and the synchronous version
// runs it on the main process, so a slow (or tampered) cost would freeze the
// whole app with no UI and no way to cancel. This hands it to the threadpool.
const scryptAsync = promisify(crypto.scrypt);

// scrypt cost used for NEW wraps. Every wrap records the cost it was made with
// (see slotParams), so this can be raised later without locking anyone out of a
// vault written under the old cost. N=2^16 needs ~64 MB per attempt, which is
// what makes guessing a PIN expensive.
const SCRYPT = { N: 65536, r: 8, p: 1 };
// Wraps written before the cost was recorded were all made with these.
const LEGACY_SCRYPT = { N: 32768, r: 8, p: 1 };
const KEYLEN = 32;
const MAXMEM = 192 * 1024 * 1024;

// The cost lives in the file, so it is attacker-editable. Lowering it is
// harmless (a different cost derives a different key, which then fails the GCM
// tag), but RAISING it is not: work scales with N*r*p, so a tampered vault could
// otherwise ask for hours of it. Only accept costs we would ever have written.
const SCRYPT_BOUNDS = { minN: 16384, maxN: 262144, minR: 8, maxR: 16, minP: 1, maxP: 4 };
const isPowerOfTwo = (n) => Number.isInteger(n) && n > 1 && (n & (n - 1)) === 0;

function slotParams(slot) {
  const n = slot && slot.N, r = slot && slot.r, p = slot && slot.p;
  const params = {
    N: Number.isInteger(n) ? n : LEGACY_SCRYPT.N,
    r: Number.isInteger(r) ? r : LEGACY_SCRYPT.r,
    p: Number.isInteger(p) ? p : LEGACY_SCRYPT.p
  };
  const b = SCRYPT_BOUNDS;
  const sane = isPowerOfTwo(params.N) && params.N >= b.minN && params.N <= b.maxN
    && params.r >= b.minR && params.r <= b.maxR
    && params.p >= b.minP && params.p <= b.maxP;
  if (!sane) {
    const err = new Error('The journal file asks for key settings Flint does not recognise.');
    err.code = 'FLINT_DAMAGED';
    throw err;
  }
  return params;
}

// True when a wrap was made with a weaker cost than we use now, so it can be
// quietly rewritten at the current cost next time we hold the secret.
function isStaleWrap(slot) {
  const p = slotParams(slot);
  return p.N < SCRYPT.N || p.r < SCRYPT.r || p.p < SCRYPT.p;
}

function deriveKey(secret, salt, params) {
  return scryptAsync(Buffer.from(String(secret), 'utf8'), salt, KEYLEN, {
    N: params.N, r: params.r, p: params.p, maxmem: MAXMEM
  });
}

const b64 = (buf) => buf.toString('base64');
const unb64 = (s) => Buffer.from(String(s), 'base64');

function aesEncrypt(key, plaintextBuf) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  return { iv: b64(iv), tag: b64(cipher.getAuthTag()), ct: b64(ct) };
}

// Throws if the key is wrong or the data was tampered with (GCM auth failure).
// The tag length is pinned: without it Node would accept a short tag, and an
// attacker who can rewrite the file could truncate it to weaken forgery odds.
function aesDecrypt(key, slot) {
  const tag = unb64(slot.tag);
  if (tag.length !== 16) throw new Error('bad auth tag');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, unb64(slot.iv), { authTagLength: 16 });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(unb64(slot.ct)), decipher.final()]);
}

// Attachment bytes are encrypted under the same data key as the words, so a
// photo is no more readable than the entry it belongs to. One self-contained
// blob: iv (12) | tag (16) | ciphertext.
function encryptBuffer(dk, buf) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dk, iv);
  const ct = Buffer.concat([cipher.update(buf), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

function decryptBuffer(dk, blob) {
  if (blob.length < 28) throw new Error('attachment too short to be valid');
  const decipher = crypto.createDecipheriv('aes-256-gcm', dk, blob.subarray(0, 12), { authTagLength: 16 });
  decipher.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]);
}

// A readable one-time recovery code, e.g. "K7M2-9QXR-4TWP-8HJN-6RSD".
// Crockford-ish alphabet: no 0/O/1/I to avoid transcription mistakes.
function generateRecoveryCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const n = 20;
  const out = new Array(n);
  const bytes = crypto.randomBytes(n);
  for (let i = 0; i < n; i++) out[i] = alphabet[bytes[i] % alphabet.length];
  return out.join('').match(/.{1,4}/g).join('-');
}

// Accept the code however the user types it (spaces, dashes, lower-case).
function normalizeCode(code) {
  return String(code).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function wrapDk(dk, secret) {
  const salt = crypto.randomBytes(16);
  const key = await deriveKey(secret, salt, SCRYPT);
  try {
    return { salt: b64(salt), N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, ...aesEncrypt(key, dk) };
  } finally { key.fill(0); }
}

async function unwrapDk(slot, secret) {
  const key = await deriveKey(secret, unb64(slot.salt), slotParams(slot));
  try { return aesDecrypt(key, slot); } // throws on wrong secret
  finally { key.fill(0); }
}

function encryptBody(dk, dataObj) {
  return aesEncrypt(dk, Buffer.from(JSON.stringify(dataObj), 'utf8'));
}

function isVault(obj) {
  return Boolean(obj && obj.flintEncrypted === 1 && obj.pin && obj.recovery && obj.body);
}

// Turn a plaintext data object into an encrypted vault. Returns the vault plus
// the fresh recovery code (the ONLY time the code exists in the clear).
async function createVault(dataObj, pin) {
  const dk = crypto.randomBytes(32);
  const recoveryCode = generateRecoveryCode();
  const vault = {
    flintEncrypted: 1,
    kdf: 'scrypt',
    pin: await wrapDk(dk, pin),
    recovery: await wrapDk(dk, normalizeCode(recoveryCode)),
    body: encryptBody(dk, dataObj)
  };
  return { vault, recoveryCode, dk };
}

// Decrypting the BODY is a different failure from failing to unwrap the key.
// If the wrap opened, the secret was right and any later failure means the file
// is damaged. Callers must be able to tell those apart, because telling someone
// their PIN is wrong when the file is corrupt sends them to burn their recovery
// code on a journal that a backup would have restored.
function openBody(vault, dk) {
  try {
    return JSON.parse(aesDecrypt(dk, vault.body).toString('utf8'));
  } catch {
    const err = new Error('The journal body could not be decrypted.');
    err.code = 'FLINT_DAMAGED';
    throw err;
  }
}

// Open a vault with the PIN. Returns { dk, data }. Throws a plain error on the
// wrong PIN, or one tagged FLINT_DAMAGED if the PIN was right but the body is not.
async function openWithPin(vault, pin) {
  const dk = await unwrapDk(vault.pin, pin);
  return { dk, data: openBody(vault, dk) };
}

// Open a vault with the recovery code. Same contract as openWithPin.
async function openWithRecovery(vault, code) {
  const dk = await unwrapDk(vault.recovery, normalizeCode(code));
  return { dk, data: openBody(vault, dk) };
}

// Unwrap the data key only, without touching the body. This is what a yes/no
// PIN check needs: it must not decrypt the whole journal into memory.
function unwrapWithPin(vault, pin) {
  return unwrapDk(vault.pin, pin);
}

// Decrypt a vault's body when the data key is already held (session unlocked).
function openWithDk(vault, dk) {
  return openBody(vault, dk);
}

// Rebuild a vault around new body bytes, reusing the existing key wraps (for a
// normal save while unlocked, the DK and both wraps stay the same).
function resealBody(vault, dk, dataObj) {
  return { ...vault, body: encryptBody(dk, dataObj) };
}

// Replace only the PIN wrap, keeping the same key. This is ONLY for re-wrapping
// at a newer cost when we already hold the right PIN. It is NOT a way to change
// a PIN: the key would not rotate, so the old PIN would still open older backups
// and recover the same key. Changing a PIN goes through a full rotation instead.
async function rewrapPin(vault, dk, samePin) {
  return { ...vault, pin: await wrapDk(dk, samePin) };
}

module.exports = {
  isVault,
  createVault,
  openWithPin,
  openWithRecovery,
  unwrapWithPin,
  openWithDk,
  resealBody,
  rewrapPin,
  isStaleWrap,
  encryptBuffer,
  decryptBuffer,
  normalizeCode,
  generateRecoveryCode
};
