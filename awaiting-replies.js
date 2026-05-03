const fs = require('fs');
const path = require('path');
const { encrypt, decrypt } = require('./encrypt');

const DATA_DIR = process.env.DATA_DIR || '.';
fs.mkdirSync(DATA_DIR, { recursive: true });
const STORE_FILE = path.resolve(DATA_DIR, 'awaiting-replies.json');

const TTL_MS = 5 * 24 * 60 * 60 * 1000; // 5 days

function load() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw = JSON.parse(decrypt(fs.readFileSync(STORE_FILE, 'utf8')));
      const now = Date.now();
      return Object.fromEntries(
        Object.entries(raw).filter(([, v]) => now - v.sentAt < TTL_MS)
      );
    }
  } catch (e) { console.warn('Could not load awaiting-replies:', e.message); }
  return {};
}

let store = load();

function persist() {
  try {
    fs.writeFileSync(STORE_FILE, encrypt(JSON.stringify(store)));
  } catch (e) { console.warn('Could not save awaiting-replies:', e.message); }
}

function markAwaiting(phone, firstName, fullName) {
  store[phone] = { firstName, fullName, sentAt: Date.now() };
  persist();
}

function getAwaiting(phone) {
  const entry = store[phone];
  if (!entry) return null;
  if (Date.now() - entry.sentAt > TTL_MS) { delete store[phone]; persist(); return null; }
  return entry;
}

function deleteAwaiting(phone) {
  if (store[phone]) { delete store[phone]; persist(); }
}

function cleanup() {
  const now = Date.now();
  const before = Object.keys(store).length;
  for (const phone of Object.keys(store)) {
    if (now - store[phone].sentAt > TTL_MS) delete store[phone];
  }
  if (Object.keys(store).length < before) persist();
}

module.exports = { markAwaiting, getAwaiting, deleteAwaiting, cleanup };
