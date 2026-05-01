// pending-reviews.js — Tracks clients who replied positively to day-7 check-in
// and schedules a review request to go out the next day

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '.';
fs.mkdirSync(DATA_DIR, { recursive: true });
const STORE_FILE = path.resolve(DATA_DIR, 'pending-reviews.json');

function load() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    }
  } catch (e) { console.warn('Could not load pending reviews:', e.message); }
  return [];
}

let pending = load();

function persist() {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(pending, null, 2));
  } catch (e) { console.warn('Could not save pending reviews:', e.message); }
}

// Schedule a review request for tomorrow
function schedule({ phone, firstName, fullName }) {
  const sendAt = new Date();
  sendAt.setDate(sendAt.getDate() + 1);
  sendAt.setHours(11, 0, 0, 0); // 11 AM next day

  // Don't double-schedule for the same phone
  if (pending.some(p => p.phone === phone && !p.sent)) return false;

  pending.push({
    phone,
    firstName,
    fullName,
    sendAt: sendAt.toISOString(),
    sent: false,
  });
  persist();
  return true;
}

// Get all pending reviews that are due to send (sendAt <= now and not sent)
function getDueReviews() {
  const now = new Date();
  return pending.filter(p => !p.sent && new Date(p.sendAt) <= now);
}

// Mark a review as sent
function markSent(phone) {
  const item = pending.find(p => p.phone === phone && !p.sent);
  if (item) {
    item.sent = true;
    item.sentAt = new Date().toISOString();
    persist();
  }
  // Cleanup: keep only the last 100 records
  if (pending.length > 100) {
    pending = pending.slice(-100);
    persist();
  }
}

// Check if a client already has a review request scheduled or sent
function hasReviewBeenHandled(phone) {
  return pending.some(p => p.phone === phone);
}

// Remove sent review records older than `days` days
function pruneOldRecords(days = 90) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const before = pending.length;
  pending = pending.filter(p => !p.sent || new Date(p.sentAt || p.sendAt).getTime() > cutoff);
  if (pending.length < before) persist();
  return before - pending.length;
}

module.exports = { schedule, getDueReviews, markSent, hasReviewBeenHandled, pruneOldRecords };
