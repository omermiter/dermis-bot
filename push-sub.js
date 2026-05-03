const fs = require('fs');
const path = require('path');
const { encrypt, decrypt } = require('./encrypt');

const DATA_DIR = process.env.DATA_DIR || '.';
fs.mkdirSync(DATA_DIR, { recursive: true });
const STORE_FILE = path.resolve(DATA_DIR, 'push-subs.json');

function load() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      return JSON.parse(decrypt(fs.readFileSync(STORE_FILE, 'utf8')));
    }
  } catch (e) { console.warn('Could not load push subscriptions:', e.message); }
  return [];
}

let subs = load();

function persist() {
  try {
    fs.writeFileSync(STORE_FILE, encrypt(JSON.stringify(subs)));
  } catch (e) { console.warn('Could not save push subscriptions:', e.message); }
}

function addSub(sub) {
  subs = subs.filter(s => s.endpoint !== sub.endpoint); // replace if re-subscribing
  subs.push(sub);
  if (subs.length > 5) subs = subs.slice(-5);
  persist();
}

function removeSub(endpoint) {
  const before = subs.length;
  subs = subs.filter(s => s.endpoint !== endpoint);
  if (subs.length < before) persist();
}

function getSubs() {
  return [...subs];
}

module.exports = { addSub, removeSub, getSubs };
