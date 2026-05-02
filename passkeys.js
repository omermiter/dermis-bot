// passkeys.js — Stores WebAuthn credentials for Face ID / biometric login

const fs = require('fs');
const path = require('path');
const { encrypt, decrypt } = require('./encrypt');

const DATA_DIR = process.env.DATA_DIR || '.';
fs.mkdirSync(DATA_DIR, { recursive: true });
const STORE_FILE = path.resolve(DATA_DIR, 'passkeys.json');

function load() {
  try {
    if (fs.existsSync(STORE_FILE)) return JSON.parse(decrypt(fs.readFileSync(STORE_FILE, 'utf8')));
  } catch (e) { console.warn('Could not load passkeys:', e.message); }
  return [];
}

let credentials = load();

function persist() {
  try { fs.writeFileSync(STORE_FILE, encrypt(JSON.stringify(credentials))); }
  catch (e) { console.warn('Could not save passkeys:', e.message); }
}

function getAll() { return credentials; }

function getById(credentialID) {
  return credentials.find(c => c.id === credentialID) || null;
}

function save(cred) {
  const existing = credentials.findIndex(c => c.id === cred.id);
  if (existing >= 0) { credentials[existing] = cred; }
  else { credentials.push(cred); }
  persist();
}

function remove(credentialID) {
  credentials = credentials.filter(c => c.id !== credentialID);
  persist();
}

module.exports = { getAll, getById, save, remove };
