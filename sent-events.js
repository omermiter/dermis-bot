// sent-events.js — Tracks which calendar event+message combos have been sent
// Prevents duplicate sends if a job re-runs (e.g. health-check, server restart)

const fs = require('fs');
const path = require('path');

const STORE_FILE = path.resolve('./sent-events.json');

function load() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
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
    fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
  } catch (e) { console.warn('Could not save sent-events:', e.message); }
}

function wasAlreadySent(eventId, messageType) {
  return !!(store[`${eventId}_${messageType}`]);
}

function markSent(eventId, messageType) {
  store[`${eventId}_${messageType}`] = new Date().toISOString();
  persist();
}

module.exports = { wasAlreadySent, markSent };
