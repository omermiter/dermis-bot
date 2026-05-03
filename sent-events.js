// sent-events.js — Tracks which calendar event+message combos have been sent
// Prevents duplicate sends if a job re-runs (e.g. health-check, server restart)

const fs = require('fs');
const path = require('path');
const { encrypt, decrypt } = require('./encrypt');

const DATA_DIR = process.env.DATA_DIR || '.';
fs.mkdirSync(DATA_DIR, { recursive: true });
const STORE_FILE = path.resolve(DATA_DIR, 'sent-events.json');

function load() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      return JSON.parse(decrypt(fs.readFileSync(STORE_FILE, 'utf8')));
    }
  } catch (e) { console.warn('Could not load sent-events:', e.message); }
  return {};
}

let store = load();

function persist() {
  try {
    const cutoff = Date.now() - 60 * 24 * 60 * 60 * 1000; // drop entries older than 60 days
    for (const key of Object.keys(store)) {
      if (new Date(store[key]).getTime() < cutoff) delete store[key];
    }
    fs.writeFileSync(STORE_FILE, encrypt(JSON.stringify(store)));
  } catch (e) { console.warn('Could not save sent-events:', e.message); }
}

function wasAlreadySent(eventId, messageType) {
  return !!(store[`${eventId}_${messageType}`]);
}

function markSent(eventId, messageType) {
  store[`${eventId}_${messageType}`] = new Date().toISOString();
  persist();
}

// Force the 60-day cleanup (normally runs on every write)
function pruneOldEntries() {
  const before = Object.keys(store).length;
  persist();
  return before - Object.keys(store).length;
}

// Returns stats for the current calendar month (Israel timezone)
function getMonthlyStats() {
  const monthKey = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }).slice(0, 7);
  const isThisMonth = ts => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }).startsWith(monthKey);
  let sessions = 0, dayThree = 0;
  for (const [key, ts] of Object.entries(store)) {
    if (!isThisMonth(ts)) continue;
    if (key.endsWith('_reminder')) sessions++;
    else if (key.endsWith('_day_three')) dayThree++;
  }
  return { sessions, dayThree };
}

module.exports = { wasAlreadySent, markSent, pruneOldEntries, getMonthlyStats };
