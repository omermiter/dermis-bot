// encrypt.js — AES-256-GCM helpers for at-rest file encryption
// Set ENCRYPTION_KEY env var to a 64-char hex string (32 bytes).
// Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
// If ENCRYPTION_KEY is not set, data is stored as plain JSON (backward-compatible).

const crypto = require('crypto');
const ALGO = 'aes-256-gcm';

function getKey() {
  const k = process.env.ENCRYPTION_KEY;
  if (!k) return null;
  const buf = Buffer.from(k, 'hex');
  if (buf.length !== 32) throw new Error('ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
  return buf;
}

// Returns base64-encoded [IV(16) + GCM tag(16) + ciphertext], or plaintext if no key
function encrypt(plaintext) {
  const key = getKey();
  if (!key) return plaintext;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

// Decrypts base64 payload; falls back to returning data as-is for migration from plaintext
function decrypt(data) {
  const key = getKey();
  if (!key) return data;
  try {
    const buf = Buffer.from(data, 'base64');
    if (buf.length < 33) return data; // too short to be encrypted — legacy plaintext
    const iv  = buf.subarray(0, 16);
    const tag = buf.subarray(16, 32);
    const enc = buf.subarray(32);
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(enc) + decipher.final('utf8');
  } catch {
    return data; // plaintext written before encryption was enabled
  }
}

module.exports = { encrypt, decrypt };
