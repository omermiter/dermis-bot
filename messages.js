// messages.js — Templates loader
//
// Each message now has TWO parts:
// 1. body — the rendered text (for previews in /test, /templates, /inbox)
// 2. templateSid + variables — what Twilio actually sends (must be approved by Meta)
//
// The `body` is built locally for display only. The actual message Meta
// delivers is the approved template — they should match word-for-word.

const fs = require('fs');
const path = require('path');

const TEMPLATES_FILE = path.resolve('./templates.json');
const DEFAULT_TEMPLATES_FILE = path.resolve('./templates.default.json');

function loadTemplates() {
  try {
    return JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8'));
  } catch (e) {
    console.warn('⚠️  Could not load templates.json, falling back to defaults');
    return JSON.parse(fs.readFileSync(DEFAULT_TEMPLATES_FILE, 'utf8'));
  }
}

function saveTemplates(templates) {
  fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(templates, null, 2));
}

function getTemplates() {
  return loadTemplates();
}

// Replace placeholders for display preview
function fill(template, vars) {
  let out = template;
  for (const [key, val] of Object.entries(vars)) {
    out = out.replaceAll(`{${key}}`, val ?? '');
  }
  return out;
}

// ─── Each message function returns { body, templateSid, variables } ──────────
// `templateSid` and `variables` are used by Twilio to send the approved template.
// The `body` is the rendered preview text — used for inbox display, /test preview etc.

module.exports = {

  reminder: (name, time) => {
    const t = loadTemplates();
    return {
      body: fill(t.reminder, { name, time }),
      templateSid: process.env.TEMPLATE_SID_REMINDER,
      // Variables map {1: ..., 2: ...} — must match placeholder order in your Meta template
      variables: { 1: name, 2: time },
    };
  },

  aftercare: (name) => {
    const t = loadTemplates();
    return {
      body: fill(t.aftercare, { name }),
      templateSid: process.env.TEMPLATE_SID_AFTERCARE,
      variables: { 1: name },
    };
  },

  dayThree: (name) => {
    const t = loadTemplates();
    return {
      body: fill(t.dayThree, { name }),
      templateSid: process.env.TEMPLATE_SID_DAY_THREE,
      variables: { 1: name },
    };
  },

  healingCheckIn: (name, sessionNum) => {
    const t = loadTemplates();
    return {
      body: fill(t.healingCheckIn, { name, sessionNum: sessionNum || '' }),
      templateSid: process.env.TEMPLATE_SID_HEALING_CHECKIN,
      variables: { 1: name },
    };
  },

  reviewRequest: (name) => {
    const t = loadTemplates();
    return {
      body: fill(t.reviewRequest, { name }),
      templateSid: process.env.TEMPLATE_SID_REVIEW_REQUEST,
      variables: { 1: name },
    };
  },

  // Editor helpers
  getTemplates,
  saveTemplates,
};
