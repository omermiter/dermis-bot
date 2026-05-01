// whatsapp.js — Sends WhatsApp messages via Twilio
//
// IMPORTANT — WhatsApp Business Platform rules:
// • FREE-FORM messages can ONLY be sent within 24h of the client's last message TO YOU.
// • Outside that 24h window, you MUST use an APPROVED CONTENT TEMPLATE registered with Meta.
// • DERMIS uses content templates for all proactive reminders (business-initiated).
// • DERMIS uses free-form only for messages to YOURSELF (not subject to the rule).
//
// Twilio: https://www.twilio.com/docs/content/getting-started

const twilio = require('twilio');

let client;
function getClient() {
  if (!client) {
    client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return client;
}

// ─── Template-based message (for clients) ────────────────────────────────────
// `templateSid` is the Twilio Content SID (HX...) for an approved template
// `variables` is an object mapping {1: "name", 2: "time"} — must match the template placeholders
async function sendTemplateMessage(to, templateSid, variables = {}) {
  try {
    const message = await getClient().messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to,
      contentSid: templateSid,
      contentVariables: JSON.stringify(variables),
    });
    console.log(`✅ Template message sent to ${to} — SID: ${message.sid}`);
    return { success: true, sid: message.sid };
  } catch (err) {
    console.error(`❌ Failed to send template to ${to}:`, err.message);
    return { success: false, error: err.message };
  }
}

// ─── Free-form message (only safe within 24h of customer's last message) ─────
async function sendFreeformMessage(to, body) {
  try {
    const message = await getClient().messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to,
      body,
    });
    console.log(`✅ Free-form message sent to ${to} — SID: ${message.sid}`);
    return { success: true, sid: message.sid };
  } catch (err) {
    if (err.code === 63016) {
      console.error(`❌ 24h window closed for ${to} — must use template instead.`);
      return { success: false, error: '24h window closed — template required', code: 63016 };
    }
    console.error(`❌ Failed to send to ${to}:`, err.message);
    return { success: false, error: err.message };
  }
}

// ─── Send to a client using a template (recommended) ─────────────────────────
async function sendToClient(phone, templateSid, variables = {}) {
  if (!templateSid || templateSid.includes('xxx')) {
    return { success: false, error: `Template SID not configured (got: ${templateSid}) — set the correct HX... SID in .env` };
  }
  return sendTemplateMessage(phone, templateSid, variables);
}

// ─── Send to YOURSELF (free-form is fine — Meta doesn't restrict messages to yourself) ──
async function sendToArtist(body) {
  return sendFreeformMessage(process.env.YOUR_WHATSAPP_NUMBER, body);
}

// ─── Send to YOURSELF using an approved template (works anytime, no 24h restriction) ───
async function sendToArtistTemplate(templateSid, variables = {}) {
  return sendTemplateMessage(process.env.YOUR_WHATSAPP_NUMBER, templateSid, variables);
}

module.exports = { sendToClient, sendToArtist, sendToArtistTemplate, sendTemplateMessage, sendFreeformMessage };
