// server.js — Express server with:
//   1. POST /webhook    — Twilio incoming WhatsApp messages (no auth)
//   2. GET  /login      — Login page
//   3. POST /login      — Verify password & create session
//   4. GET  /logout     — Destroy session
//   5. GET  /           — Dashboard (auth required)
//   6. GET  /inbox      — Reply inbox (auth required)
//   7. GET  /templates  — Edit message templates (auth required)
//   8. POST /templates  — Save edited templates (auth required)

const express = require('express');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const { addReply, markRead, markAllRead, getReplies, unreadCount } = require('./replies-store');
const { analyze } = require('./sentiment');
const pendingReviews = require('./pending-reviews');
const messages = require('./messages');
const { createSession, destroySession, checkPassword, requireAuth } = require('./auth');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cookieParser());

// ─── Phone-to-name registry ──────────────────────────────────────────────────
const phoneToName = new Map();
function registerClientPhone(phone, name) {
  const clean = phone.replace('whatsapp:', '').replace(/[\s\-]/g, '');
  phoneToName.set(clean, name);
}
function lookupName(from) {
  const clean = from.replace('whatsapp:', '').replace(/[\s\-]/g, '');
  return phoneToName.get(clean) || phoneToName.get(clean.replace('+972', '0')) || 'Unknown client';
}

// ─── Day-7 awaiting reply tracker (smart trigger) ────────────────────────────
const awaitingDay7Reply = new Map();
function markAwaitingDay7(phone, firstName, fullName) {
  awaitingDay7Reply.set(phone, { firstName, fullName, sentAt: Date.now() });
}
function cleanupAwaiting() {
  const fiveDays = 5 * 24 * 60 * 60 * 1000;
  for (const [phone, data] of awaitingDay7Reply.entries()) {
    if (Date.now() - data.sentAt > fiveDays) awaitingDay7Reply.delete(phone);
  }
}

// ─── HTML escape helper ──────────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ─── Shared CSS ──────────────────────────────────────────────────────────────
const SHARED_CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; color: #1a1a1a; min-height: 100vh; }
.header { background: #1a1a1a; color: white; padding: 16px 20px; position: sticky; top: 0; z-index: 10; }
.header-row { display: flex; align-items: center; justify-content: space-between; }
.header-title { font-size: 18px; font-weight: 600; }
.header-sub { font-size: 12px; opacity: 0.6; margin-top: 2px; }
.nav { display: flex; gap: 4px; margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.1); }
.nav a { padding: 6px 12px; font-size: 12px; color: white; text-decoration: none; border-radius: 6px; opacity: 0.7; transition: all 0.15s; }
.nav a.active { background: rgba(255,255,255,0.15); opacity: 1; }
.nav a:hover { opacity: 1; }
.logout { font-size: 11px; opacity: 0.5; color: white; text-decoration: none; }
.logout:hover { opacity: 1; }
.container { padding: 0 12px 80px; max-width: 600px; margin: 0 auto; }
.btn { padding: 8px 14px; border-radius: 8px; border: 1px solid #ddd; background: white; font-size: 13px; cursor: pointer; color: #1a1a1a; font-family: inherit; }
.btn:hover { background: #f0f0f0; }
.btn.primary { background: #1a1a1a; color: white; border-color: #1a1a1a; }
.btn.primary:hover { background: #333; }
`;

const HEADER = (active = '') => `
<div class="header">
  <div class="header-row">
    <div>
      <div class="header-title">🖤 DERMIS</div>
      <div class="header-sub">Studio Assistant</div>
    </div>
    <a class="logout" href="/logout">Logout</a>
  </div>
  <div class="nav">
    <a href="/inbox" class="${active === 'inbox' ? 'active' : ''}">Inbox</a>
    <a href="/templates" class="${active === 'templates' ? 'active' : ''}">Templates</a>
    <a href="/test" class="${active === 'test' ? 'active' : ''}">Test</a>
    <a href="/status" class="${active === 'status' ? 'active' : ''}">Status</a>
  </div>
</div>
`;

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC ROUTES
// ════════════════════════════════════════════════════════════════════════════

app.post('/webhook', async (req, res) => {
  const from = req.body.From || '';
  const body = req.body.Body || '';
  if (!from || !body) return res.status(200).send('<Response></Response>');

  cleanupAwaiting();
  const clientName = lookupName(from);
  const rawPhone = from.replace('whatsapp:', '');
  const messageSid = req.body.MessageSid || '';
  const reply = addReply({ from, clientName, body, messageSid });
  if (!reply) return res.set('Content-Type', 'text/xml').send('<Response></Response>'); // duplicate webhook
  console.log(`📩 Reply from ${clientName} (${rawPhone}): "${body}"`);

  const day7Data = awaitingDay7Reply.get(from);
  if (day7Data) {
    awaitingDay7Reply.delete(from);
    const buttonPayload = req.body.ButtonPayload || '';
    // Button payload takes priority; fall back to text sentiment for free-form replies
    const sentiment = buttonPayload === 'positive' ? 'positive'
      : buttonPayload === 'concerned' ? 'negative'
      : analyze(body);
    if (sentiment === 'positive') {
      pendingReviews.schedule({ phone: from, firstName: day7Data.firstName, fullName: day7Data.fullName });
      console.log(`✅ Positive healing reply from ${clientName} — review request scheduled`);
    } else if (sentiment === 'negative') {
      console.log(`⚠️ Concern detected in reply from ${clientName} — no review request`);
    }
  }

  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');
});

app.get('/login', (req, res) => {
  const error = req.query.error ? '<div class="error">Incorrect password</div>' : '';
  const returnTo = req.query.returnTo || '/inbox';
  res.send(`<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DERMIS — Login</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #1a1a1a; color: white; height: 100vh; display: flex; align-items: center; justify-content: center; }
    .login-card { background: #2a2a2a; border-radius: 16px; padding: 32px 28px; width: 90%; max-width: 360px; box-shadow: 0 20px 60px rgba(0,0,0,0.4); }
    .logo { font-size: 32px; text-align: center; margin-bottom: 8px; }
    .title { text-align: center; font-size: 22px; font-weight: 600; margin-bottom: 4px; }
    .subtitle { text-align: center; font-size: 12px; opacity: 0.5; margin-bottom: 24px; }
    label { display: block; font-size: 11px; opacity: 0.7; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.05em; }
    input[type="password"] { width: 100%; padding: 12px 14px; background: #1a1a1a; border: 1px solid #444; border-radius: 8px; color: white; font-size: 15px; font-family: inherit; }
    input[type="password"]:focus { outline: none; border-color: #888; }
    button { width: 100%; padding: 12px; background: white; color: #1a1a1a; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; margin-top: 16px; font-family: inherit; }
    button:hover { background: #eee; }
    .error { background: #4a1f1f; color: #ff8a8a; padding: 10px; border-radius: 6px; font-size: 12px; text-align: center; margin-bottom: 16px; }
  </style>
</head><body>
  <form class="login-card" method="POST" action="/login">
    <div class="logo">🖤</div>
    <div class="title">DERMIS</div>
    <div class="subtitle">Studio Assistant</div>
    ${error}
    <label>Password</label>
    <input type="password" name="password" autofocus required>
    <input type="hidden" name="returnTo" value="${escHtml(returnTo)}">
    <button type="submit">Sign in</button>
  </form>
</body></html>`);
});

app.post('/login', (req, res) => {
  const password = req.body.password || '';
  const returnTo = req.body.returnTo || '/inbox';
  if (!checkPassword(password)) {
    return res.redirect(`/login?error=1&returnTo=${encodeURIComponent(returnTo)}`);
  }
  const token = createSession();
  res.cookie('dermis_session', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
  const safeReturn = returnTo.startsWith('/') ? returnTo : '/inbox';
  res.redirect(safeReturn);
});

app.get('/logout', (req, res) => {
  const token = req.cookies && req.cookies.dermis_session;
  if (token) destroySession(token);
  res.clearCookie('dermis_session');
  res.redirect('/login');
});

// ════════════════════════════════════════════════════════════════════════════
// PROTECTED ROUTES
// ════════════════════════════════════════════════════════════════════════════

app.get('/', requireAuth, (req, res) => res.redirect('/inbox'));

app.get('/inbox', requireAuth, (req, res) => {
  const replies = getReplies();
  const unread = unreadCount();

  const rows = replies.map(r => {
    const time = new Date(r.timestamp).toLocaleString('he-IL', {
      day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit'
    });
    const readClass = r.read ? 'read' : 'unread';
    return `
      <div class="reply ${readClass}" onclick="markRead(${r.id}, this)">
        <div class="reply-header">
          <span class="client-name">${escHtml(r.clientName)}</span>
          <span class="reply-time">${time}</span>
          ${!r.read ? '<span class="dot"></span>' : ''}
        </div>
        <div class="reply-phone">${escHtml(r.from.replace('whatsapp:', ''))}</div>
        <div class="reply-body">${escHtml(r.body)}</div>
      </div>`;
  }).join('');

  res.send(`<!DOCTYPE html>
<html lang="he"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DERMIS — Inbox</title>
  <style>
    ${SHARED_CSS}
    .badge { background: #E24B4A; color: white; font-size: 11px; font-weight: 700; padding: 3px 8px; border-radius: 20px; }
    .badge.zero { background: #3B6D11; }
    .actions { padding: 12px 0; display: flex; gap: 8px; align-items: center; }
    .empty { text-align: center; padding: 60px 20px; color: #999; font-size: 14px; }
    .reply { background: white; border-radius: 12px; padding: 14px 16px; margin-bottom: 10px; border-left: 3px solid transparent; cursor: pointer; transition: all 0.15s; }
    .reply.unread { border-left-color: #1a1a1a; }
    .reply.read { opacity: 0.7; }
    .reply:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .reply-header { display: flex; align-items: center; gap: 8px; margin-bottom: 3px; }
    .client-name { font-size: 14px; font-weight: 600; flex: 1; }
    .reply-time { font-size: 11px; color: #999; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #1a1a1a; flex-shrink: 0; }
    .reply-phone { font-size: 11px; color: #999; margin-bottom: 6px; }
    .reply-body { font-size: 13px; color: #333; line-height: 1.5; background: #f8f8f8; padding: 8px 10px; border-radius: 8px; white-space: pre-wrap; }
  </style>
</head><body>
  ${HEADER('inbox')}
  <div class="container">
    <div class="actions">
      <span class="badge ${unread === 0 ? 'zero' : ''}">${unread === 0 ? 'All read' : unread + ' unread'}</span>
      <div style="flex:1;"></div>
      <button class="btn" onclick="fetch('/mark-all-read').then(()=>location.reload())">Mark all read</button>
      <button class="btn" onclick="location.reload()">↻</button>
    </div>
    ${replies.length === 0
      ? '<div class="empty">No replies yet 🖤<br>They will show up here when clients respond.</div>'
      : rows
    }
  </div>
  <script>
    function markRead(id, el) {
      fetch('/mark-read/' + id).then(() => {
        el.classList.remove('unread'); el.classList.add('read');
        const dot = el.querySelector('.dot'); if (dot) dot.remove();
      });
    }
    setTimeout(() => location.reload(), 30000);
  </script>
</body></html>`);
});

app.get('/mark-read/:id', requireAuth, (req, res) => { markRead(req.params.id); res.send('ok'); });
app.get('/mark-all-read', requireAuth, (req, res) => { markAllRead(); res.send('ok'); });

// ─── Templates editor ────────────────────────────────────────────────────────
const TEMPLATE_INFO = {
  reminder: {
    label: '24h Session Reminder',
    desc: 'Sent to clients 24 hours before their appointment.',
    placeholders: ['{name}', '{time}'],
  },
  aftercare: {
    label: 'Same-day Aftercare',
    desc: 'Sent to clients in the evening after their session.',
    placeholders: ['{name}'],
  },
  dayThree: {
    label: 'Day 3 Check-in',
    desc: 'Sent 3 days after the session.',
    placeholders: ['{name}'],
  },
  healingCheckIn: {
    label: 'Day 7 Healing Check-in',
    desc: 'Sent 7 days after the session. Their reply triggers the smart review logic.',
    placeholders: ['{name}', '{sessionNum}'],
  },
  reviewRequest: {
    label: 'Review Request',
    desc: 'Sent automatically the day after a positive day-7 reply.',
    placeholders: ['{name}'],
  },
};

app.get('/templates', requireAuth, (req, res) => {
  const templates = messages.getTemplates();
  const saved = req.query.saved === '1';

  const cards = Object.entries(TEMPLATE_INFO).map(([key, info]) => {
    const value = templates[key] || '';
    const placeholderTags = info.placeholders.map(p => `<span class="ph">${p}</span>`).join(' ');
    return `
      <div class="card">
        <div class="card-header">
          <div>
            <div class="tmpl-label">${info.label}</div>
            <div class="tmpl-desc">${info.desc}</div>
          </div>
        </div>
        <div class="placeholders">Click to insert: ${placeholderTags}</div>
        <textarea name="${key}" rows="6">${escHtml(value)}</textarea>
      </div>`;
  }).join('');

  res.send(`<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DERMIS — Templates</title>
  <style>
    ${SHARED_CSS}
    .saved-toast { background: #EAF3DE; color: #3B6D11; padding: 10px 14px; border-radius: 8px; font-size: 13px; margin: 16px 0; text-align: center; }
    .card { background: white; border-radius: 12px; padding: 16px; margin-bottom: 14px; }
    .card-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px; }
    .tmpl-label { font-size: 14px; font-weight: 600; color: #1a1a1a; }
    .tmpl-desc { font-size: 12px; color: #666; margin-top: 2px; line-height: 1.4; }
    .placeholders { font-size: 11px; color: #666; margin-bottom: 8px; }
    .ph { display: inline-block; background: #f0f0f0; padding: 2px 6px; border-radius: 4px; font-family: ui-monospace, SF Mono, monospace; color: #1a1a1a; font-size: 11px; margin-right: 4px; cursor: pointer; }
    .ph:hover { background: #1a1a1a; color: white; }
    textarea { width: 100%; border: 1px solid #ddd; border-radius: 8px; padding: 10px 12px; font-family: inherit; font-size: 13px; line-height: 1.5; resize: vertical; direction: rtl; text-align: right; }
    textarea:focus { outline: none; border-color: #1a1a1a; }
    .save-bar { position: sticky; bottom: 0; background: white; border-top: 1px solid #ddd; padding: 14px 12px; margin: 16px -12px 0; display: flex; gap: 10px; justify-content: space-between; align-items: center; }
    .save-bar .info { font-size: 12px; color: #666; }
  </style>
</head><body>
  ${HEADER('templates')}
  <div class="container">
    ${saved ? '<div class="saved-toast">✅ Templates saved successfully</div>' : ''}
    <form method="POST" action="/templates">
      ${cards}
      <div class="save-bar">
        <div class="info">Edits apply to the next message sent.</div>
        <div style="display:flex; gap:8px;">
          <button type="button" class="btn" onclick="if(confirm('Reset all templates to defaults?')) location.href='/templates/reset'">Reset</button>
          <button type="submit" class="btn primary">Save changes</button>
        </div>
      </div>
    </form>
  </div>
  <script>
    let lastTextarea = null;
    document.querySelectorAll('textarea').forEach(t => t.addEventListener('focus', () => lastTextarea = t));
    document.querySelectorAll('.ph').forEach(ph => {
      ph.addEventListener('click', () => {
        if (!lastTextarea) return;
        const start = lastTextarea.selectionStart;
        const end = lastTextarea.selectionEnd;
        const text = lastTextarea.value;
        lastTextarea.value = text.slice(0, start) + ph.textContent + text.slice(end);
        lastTextarea.focus();
        lastTextarea.selectionStart = lastTextarea.selectionEnd = start + ph.textContent.length;
      });
    });
  </script>
</body></html>`);
});

app.post('/templates', requireAuth, (req, res) => {
  const current = messages.getTemplates();
  const updated = { ...current };
  for (const key of Object.keys(TEMPLATE_INFO)) {
    if (typeof req.body[key] === 'string') updated[key] = req.body[key];
  }
  messages.saveTemplates(updated);
  res.redirect('/templates?saved=1');
});

app.get('/templates/reset', requireAuth, (req, res) => {
  const defaults = JSON.parse(fs.readFileSync('./templates.default.json', 'utf8'));
  messages.saveTemplates(defaults);
  res.redirect('/templates?saved=1');
});

// ─── Test message page ───────────────────────────────────────────────────────
app.get('/test', requireAuth, (req, res) => {
  const sent = req.query.sent;
  const error = req.query.error;

  let banner = '';
  if (sent) banner = `<div class="success-toast">✅ Test message sent to your number — check WhatsApp!</div>`;
  if (error) banner = `<div class="error-toast">❌ Failed to send: ${escHtml(error)}</div>`;

  // Build options for template dropdown
  const options = Object.entries(TEMPLATE_INFO)
    .map(([key, info]) => `<option value="${key}">${info.label}</option>`)
    .join('');

  res.send(`<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DERMIS — Test Message</title>
  <style>
    ${SHARED_CSS}
    .card { background: white; border-radius: 12px; padding: 20px; margin-bottom: 14px; }
    .card-title { font-size: 16px; font-weight: 600; margin-bottom: 6px; }
    .card-desc { font-size: 12px; color: #666; line-height: 1.5; margin-bottom: 16px; }
    label { display: block; font-size: 11px; color: #666; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 12px; }
    label:first-of-type { margin-top: 0; }
    select, input[type="text"] { width: 100%; padding: 10px 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; font-family: inherit; background: white; }
    select:focus, input:focus { outline: none; border-color: #1a1a1a; }
    .preview { background: #DCF8C6; border-radius: 12px 12px 0 12px; padding: 12px 14px; font-size: 13px; line-height: 1.5; white-space: pre-wrap; margin-top: 8px; max-width: 95%; min-height: 50px; }
    .preview-label { font-size: 11px; color: #666; margin-top: 14px; margin-bottom: 4px; }
    .success-toast { background: #EAF3DE; color: #3B6D11; padding: 12px 14px; border-radius: 8px; font-size: 13px; margin: 16px 0; text-align: center; }
    .error-toast { background: #FCEBEB; color: #A32D2D; padding: 12px 14px; border-radius: 8px; font-size: 13px; margin: 16px 0; text-align: center; }
    .info-row { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #666; padding: 10px 12px; background: #f8f8f8; border-radius: 8px; margin-bottom: 12px; }
    .info-row .icon { font-size: 16px; }
  </style>
</head><body>
  ${HEADER('test')}
  <div class="container">
    ${banner}

    <div class="card">
      <div class="card-title">🧪 Send a test message</div>
      <div class="card-desc">Pick a template and send it to your own WhatsApp number to verify everything is working. The message will be prefixed with <strong>[TEST]</strong> so you'll know it's not a real client message.</div>

      <div class="info-row">
        <span class="icon">📱</span>
        <span>Test messages are always sent to <strong>${escHtml((process.env.YOUR_WHATSAPP_NUMBER || '').replace('whatsapp:', '') || 'your number from .env')}</strong></span>
      </div>

      <form method="POST" action="/test">
        <label>Template</label>
        <select name="template" id="template" onchange="updatePreview()">
          ${options}
        </select>

        <label>Sample client first name</label>
        <input type="text" name="name" id="name" value="נועה" oninput="updatePreview()">

        <label>Sample appointment time</label>
        <input type="text" name="time" id="time" value="10:00" oninput="updatePreview()">

        <div class="preview-label">Preview:</div>
        <div class="preview" id="preview">Loading preview...</div>

        <button type="submit" class="btn primary" style="width:100%; margin-top:16px;">📤 Send test message to my WhatsApp</button>
      </form>
    </div>

    <div class="card">
      <div class="card-title">🩺 What this checks</div>
      <div class="card-desc" style="margin-bottom:0;">
        ✓ Twilio credentials are valid<br>
        ✓ Your WhatsApp Business number is connected<br>
        ✓ Templates render correctly with your sample data<br>
        ✓ Messages reach your phone
      </div>
    </div>
  </div>

  <script>
    const templates = ${JSON.stringify(messages.getTemplates())};
    function updatePreview() {
      const tpl = document.getElementById('template').value;
      const name = document.getElementById('name').value || 'נועה';
      const time = document.getElementById('time').value || '10:00';
      let text = templates[tpl] || '';
      text = text.replaceAll('{name}', name)
                 .replaceAll('{fullName}', name + ' לקוח')
                 .replaceAll('{time}', time)
                 .replaceAll('{phone}', '0501234567')
                 .replaceAll('{sessionNum}', '#1');
      document.getElementById('preview').textContent = '[TEST] ' + text;
    }
    updatePreview();
  </script>
</body></html>`);
});

app.post('/test', requireAuth, async (req, res) => {
  const template = req.body.template;
  const name = (req.body.name || 'נועה').trim();
  const time = (req.body.time || '10:00').trim();

  try {
    let msgObj;
    switch (template) {
      case 'reminder': msgObj = messages.reminder(name, time); break;
      case 'aftercare': msgObj = messages.aftercare(name); break;
      case 'dayThree': msgObj = messages.dayThree(name); break;
      case 'healingCheckIn': msgObj = messages.healingCheckIn(name, '#1'); break;
      case 'reviewRequest': msgObj = messages.reviewRequest(name); break;
      default: throw new Error('Invalid template');
    }

    const { sendToClient } = require('./whatsapp');
    let result;
    result = await sendToClient(process.env.YOUR_WHATSAPP_NUMBER, msgObj.templateSid, msgObj.variables);
    if (!result.success) {
      throw new Error(result.error || 'Unknown error');
    }
    res.redirect('/test?sent=1');
  } catch (e) {
    res.redirect(`/test?error=${encodeURIComponent(e.message)}`);
  }
});

// ─── Status page ─────────────────────────────────────────────────────────────
const { getTodayStatus } = require('./job-state');
app.get('/status', requireAuth, (req, res) => {
  const today = getTodayStatus();
  const jobs = [
    { key: '24h_reminders', label: '24h Reminders', expected: '09:00' },
    { key: 'day_three',     label: 'Day-3 Check-ins', expected: '09:00' },
    { key: 'day_seven',     label: 'Day-7 Healing Check-ins', expected: '09:00' },
    { key: 'aftercare',     label: 'Aftercare Messages', expected: '18:00' },
  ];

  const israelHour = parseInt(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false }));

  const rows = jobs.map(j => {
    const ranAt = today[j.key];
    const expectedHour = parseInt(j.expected.split(':')[0]);
    const isPast = israelHour >= expectedHour;
    let status, statusClass;
    if (ranAt) {
      const time = new Date(ranAt).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
      status = `✅ Ran at ${time}`;
      statusClass = 'ok';
    } else if (isPast) {
      status = '⚠️ Missed — health-check will run it';
      statusClass = 'warn';
    } else {
      status = `⏳ Scheduled for ${j.expected}`;
      statusClass = 'pending';
    }
    return `<div class="job-row ${statusClass}">
      <div class="job-label">${j.label}</div>
      <div class="job-status">${status}</div>
    </div>`;
  }).join('');

  res.send(`<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DERMIS — Status</title>
  <style>
    ${SHARED_CSS}
    .card { background: white; border-radius: 12px; padding: 16px; margin-bottom: 14px; }
    .card-title { font-size: 14px; font-weight: 600; margin-bottom: 12px; }
    .job-row { display: flex; justify-content: space-between; align-items: center; padding: 12px 0; border-bottom: 1px solid #eee; gap: 12px; }
    .job-row:last-child { border-bottom: none; }
    .job-label { font-size: 13px; font-weight: 500; }
    .job-status { font-size: 12px; }
    .job-row.ok .job-status { color: #3B6D11; }
    .job-row.warn .job-status { color: #854F0B; }
    .job-row.pending .job-status { color: #666; }
    .info { font-size: 12px; color: #666; line-height: 1.5; padding: 12px; background: #f8f8f8; border-radius: 8px; margin-top: 8px; }
  </style>
</head><body>
  ${HEADER('status')}
  <div class="container">
    <div class="card">
      <div class="card-title">📊 Today's job status</div>
      ${rows}
      <div class="info" style="margin-top:16px;">
        🩺 A health-check runs every <strong>30 minutes</strong> and automatically re-runs any job that was missed (e.g. due to server downtime). You shouldn't have to do anything.
      </div>
    </div>

    <div class="card">
      <div class="card-title">📋 Meta template registration</div>
      ${[
        ['TEMPLATE_SID_REMINDER',         '24h Reminder'],
        ['TEMPLATE_SID_AFTERCARE',        'Aftercare'],
        ['TEMPLATE_SID_DAY_THREE',        'Day 3 Check-in'],
        ['TEMPLATE_SID_HEALING_CHECKIN',  'Day 7 Healing Check-in'],
        ['TEMPLATE_SID_REVIEW_REQUEST',   'Review Request'],
      ].map(([env, label]) => {
        const v = process.env[env];
        const status = v
          ? `<span style="color:#3B6D11;">✅ ${escHtml(v.slice(0,8))}…</span>`
          : `<span style="color:#A32D2D;">❌ Not set</span>`;
        return `<div class="job-row ${v ? 'ok' : 'warn'}"><div class="job-label">${label}</div><div class="job-status">${status}</div></div>`;
      }).join('')}
      <div class="info">
        ⚠️ WhatsApp business-initiated messages must use approved templates. Register each template in <strong>Twilio Console → Messaging → Content Builder</strong> and set its Content SID (HX…) as an environment variable. See setup guide for details.
      </div>
    </div>

    <div style="display:flex;gap:8px;">
      <button class="btn" style="flex:1;" onclick="location.reload()">↻ Refresh</button>
      <button class="btn" id="hc-btn" style="flex:1;background:#1a1a1a;color:white;" onclick="runHealthCheckNow()">🩺 Run Health Check Now</button>
    </div>
    <div id="hc-result" style="display:none;margin-top:10px;padding:10px;border-radius:8px;font-size:13px;"></div>
  </div>
  <script>
    async function runHealthCheckNow() {
      const btn = document.getElementById('hc-btn');
      const result = document.getElementById('hc-result');
      btn.disabled = true;
      btn.textContent = '⏳ Running...';
      result.style.display = 'none';
      try {
        const r = await fetch('/run-health-check', { method: 'POST' });
        const data = await r.json();
        if (data.ok) {
          result.style.cssText = 'display:block;margin-top:10px;padding:10px;border-radius:8px;font-size:13px;background:#f0fdf4;color:#3B6D11;';
          result.textContent = '✅ Health check completed — any missed jobs have been re-run.';
        } else {
          result.style.cssText = 'display:block;margin-top:10px;padding:10px;border-radius:8px;font-size:13px;background:#fff1f1;color:#A32D2D;';
          result.textContent = '❌ Error: ' + data.error;
        }
      } catch (e) {
        result.style.cssText = 'display:block;margin-top:10px;padding:10px;border-radius:8px;font-size:13px;background:#fff1f1;color:#A32D2D;';
        result.textContent = '❌ Request failed.';
      }
      btn.disabled = false;
      btn.textContent = '🩺 Run Health Check Now';
      location.reload();
    }
  </script>
</body></html>`);
});

// ─── Manual health-check trigger ─────────────────────────────────────────────
app.post('/run-health-check', requireAuth, async (req, res) => {
  try {
    const { runHealthCheck } = require('./index');
    await runHealthCheck();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Start server ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
function startServer() {
  if (!process.env.ARTIST_PASSWORD) {
    console.warn('⚠️  WARNING: ARTIST_PASSWORD is not set in .env — login will reject all attempts!');
  }
  app.listen(PORT, () => {
    console.log(`🌐 DERMIS web app running at http://localhost:${PORT}`);
    console.log(`🔗 Twilio webhook: ${process.env.BOT_URL || 'http://localhost:' + PORT}/webhook`);
    console.log(`🔐 Login at: ${process.env.BOT_URL || 'http://localhost:' + PORT}/login`);
  });
}

module.exports = { startServer, registerClientPhone, markAwaitingDay7 };
