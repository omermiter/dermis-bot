// replies-store.js — Stores incoming client replies in memory + a local JSON file
// So replies survive server restarts

const fs = require('fs');
const path = require('path');
const { encrypt, decrypt } = require('./encrypt');

const DATA_DIR = process.env.DATA_DIR || '.';
fs.mkdirSync(DATA_DIR, { recursive: true });
const STORE_FILE = path.resolve(DATA_DIR, 'replies.json');

// Load existing replies from disk on startup
function loadReplies() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      return JSON.parse(decrypt(fs.readFileSync(STORE_FILE, 'utf8')));
    }
  } catch (e) {
    console.warn('Could not load replies store:', e.message);
  }
  return [];
}

let replies = loadReplies();

// Save to disk
function persist() {
  try {
    fs.writeFileSync(STORE_FILE, encrypt(JSON.stringify(replies)));
  } catch (e) {
    console.warn('Could not save replies store:', e.message);
  }
}

// Add a new reply — returns null if duplicate (same Twilio MessageSid)
function addReply({ from, clientName, body, messageSid, timestamp }) {
  if (messageSid && replies.some(r => r.messageSid === messageSid)) return null;
  const reply = {
    id: Date.now(),
    messageSid,
    from,         // phone number e.g. whatsapp:+972501234567
    clientName,   // matched from calendar or "Unknown"
    body,
    timestamp: timestamp || new Date().toISOString(),
    read: false,
  };
  replies.unshift(reply); // newest first
  if (replies.length > 200) replies = replies.slice(0, 200);
  persist();
  return reply;
}

// Mark a reply as read
function markRead(id) {
  const reply = replies.find(r => r.id === Number(id));
  if (reply) {
    reply.read = true;
    persist();
  }
}

// Mark all as read
function markAllRead() {
  replies.forEach(r => r.read = true);
  persist();
}

// Get all replies
function getReplies() {
  return replies;
}

// Count unread
function unreadCount() {
  return replies.filter(r => !r.read).length;
}

// Remove read replies older than `days` days
function pruneOldReplies(days = 30) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const before = replies.length;
  replies = replies.filter(r => !r.read || new Date(r.timestamp).getTime() > cutoff);
  if (replies.length < before) persist();
  return before - replies.length;
}

module.exports = { addReply, markRead, markAllRead, getReplies, unreadCount, pruneOldReplies };
