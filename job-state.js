// job-state.js — Tracks which scheduled jobs ran successfully today
// Used by the health-check to detect missed jobs (e.g. server downtime)

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.resolve('./job-state.json');

function load() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) { console.warn('Could not load job state:', e.message); }
  return {};
}

let state = load();

function persist() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) { console.warn('Could not save job state:', e.message); }
}

// Returns YYYY-MM-DD string for today in Israel timezone
function todayKey() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}

// Mark a job as completed for today
function markJobCompleted(jobName) {
  const key = todayKey();
  if (!state[key]) state[key] = {};
  state[key][jobName] = new Date().toISOString();
  // Cleanup: keep only the last 14 days
  const allKeys = Object.keys(state).sort();
  if (allKeys.length > 14) {
    for (const k of allKeys.slice(0, allKeys.length - 14)) delete state[k];
  }
  persist();
}

// Has this job run today?
function hasJobRunToday(jobName) {
  const key = todayKey();
  return !!(state[key] && state[key][jobName]);
}

// Get summary of today's jobs
function getTodayStatus() {
  return state[todayKey()] || {};
}

module.exports = { markJobCompleted, hasJobRunToday, getTodayStatus };
