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
const { sendToArtistTemplate, sendToArtist } = require('./whatsapp');
const crypto = require('crypto');

// ─── OTP store ───────────────────────────────────────────────────────────────
const otpPending = new Map();
function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}
function createOtpToken(returnTo) {
  const otp = generateOtp();
  const token = crypto.randomBytes(20).toString('hex');
  otpPending.set(token, { otp, expiresAt: Date.now() + 5 * 60 * 1000, returnTo, attempts: 0 });
  return { token, otp };
}
function verifyOtp(token, submitted) {
  const entry = otpPending.get(token);
  if (!entry) return { ok: false, reason: 'expired' };
  if (Date.now() > entry.expiresAt) { otpPending.delete(token); return { ok: false, reason: 'expired' }; }
  entry.attempts++;
  if (entry.attempts > 5) { otpPending.delete(token); return { ok: false, reason: 'too_many' }; }
  if (submitted !== entry.otp) return { ok: false, reason: 'wrong' };
  otpPending.delete(token);
  return { ok: true, returnTo: entry.returnTo };
}
async function sendOtp(otp) {
  const text = `Your DERMIS login code: ${otp} (valid for 5 minutes)`;
  if (process.env.TEMPLATE_SID_ARTIST_NOTIFICATION) {
    return sendToArtistTemplate(process.env.TEMPLATE_SID_ARTIST_NOTIFICATION, { 1: 'DERMIS', 2: 'OTP', 3: text });
  }
  return sendToArtist(text);
}

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

// ─── Design tokens + Shared CSS ──────────────────────────────────────────────
const SHARED_CSS = `
*{box-sizing:border-box;margin:0;padding:0;}
html{scroll-behavior:smooth;}
:root{
  --bg:#080808;--surface:#111;--surface2:#161616;
  --border:#1f1f1f;--border2:#2a2a2a;
  --accent:#7C3AED;--accent-light:#9B6DFF;--accent-bg:rgba(124,58,237,0.12);
  --text:#f0f0f0;--text2:#888;--text3:#444;
  --success:#22c55e;--success-bg:rgba(34,197,94,0.08);
  --warn:#f59e0b;--warn-bg:rgba(245,158,11,0.08);
  --error:#ef4444;--error-bg:rgba(239,68,68,0.08);
  --ease:cubic-bezier(0.16,1,0.3,1);
}
@keyframes fadeUp{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:translateY(0)}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@keyframes slideDown{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:translateY(0)}}
@keyframes slideUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
@keyframes shimmer{0%{background-position:-400px 0}100%{background-position:400px 0}}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.75)}}
@keyframes glow{0%,100%{box-shadow:0 0 12px rgba(124,58,237,.3)}50%{box-shadow:0 0 24px rgba(124,58,237,.6)}}
@keyframes popIn{0%{opacity:0;transform:scale(.92)}60%{transform:scale(1.03)}100%{opacity:1;transform:scale(1)}}
body{font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;}
.header{background:rgba(8,8,8,0.96);border-bottom:1px solid var(--border);padding:16px 20px;position:sticky;top:0;z-index:100;backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);animation:slideDown .4s var(--ease) both;}
.header-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;}
.header-title{font-size:20px;font-weight:700;letter-spacing:4px;color:var(--text);}
.header-sub{font-size:10px;color:var(--accent-light);letter-spacing:2px;text-transform:uppercase;margin-top:3px;font-weight:500;}
.logout{font-size:12px;color:var(--text3);text-decoration:none;padding:6px 12px;border:1px solid var(--border2);border-radius:8px;transition:all .2s var(--ease);font-weight:500;}
.logout:hover{color:var(--text);border-color:var(--text3);}
.nav{display:flex;gap:2px;overflow-x:auto;scrollbar-width:none;-ms-overflow-style:none;}
.nav::-webkit-scrollbar{display:none;}
.nav a{padding:7px 14px;font-size:12px;font-weight:500;color:var(--text2);text-decoration:none;border-radius:8px;white-space:nowrap;transition:all .25s var(--ease);letter-spacing:.2px;}
.nav a.active{background:var(--accent);color:#fff;box-shadow:0 0 16px rgba(124,58,237,.35);}
.nav a:hover:not(.active){color:var(--text);background:var(--surface2);}
.container{padding:16px 16px 100px;max-width:600px;margin:0 auto;}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:10px 16px;background:var(--surface2);color:var(--text);border:1px solid var(--border2);border-radius:10px;font-size:13px;font-weight:500;cursor:pointer;transition:all .18s var(--ease);font-family:inherit;text-decoration:none;-webkit-tap-highlight-color:transparent;}
.btn:hover{background:var(--border2);border-color:var(--text3);transform:translateY(-1px);}
.btn:active:not(:disabled){transform:scale(.96) translateY(0);}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff;box-shadow:0 0 0 rgba(124,58,237,0);}
.btn.primary:hover{background:#6D28D9;border-color:#6D28D9;box-shadow:0 4px 20px rgba(124,58,237,.4);}
.btn:disabled{opacity:.4;cursor:not-allowed;transform:none;}
.card{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:20px;margin-bottom:12px;animation:fadeUp .5s var(--ease) both;transition:border-color .2s;}
.card:nth-child(1){animation-delay:0ms}
.card:nth-child(2){animation-delay:70ms}
.card:nth-child(3){animation-delay:140ms}
.card:nth-child(4){animation-delay:210ms}
.card:nth-child(5){animation-delay:280ms}
.card:nth-child(6){animation-delay:350ms}
.card-title{font-size:11px;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:1px;margin-bottom:16px;}
.job-row{display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid var(--border);gap:12px;transition:background .15s;}
.job-row:last-child{border-bottom:none;}
.job-label{font-size:13px;font-weight:500;color:var(--text);}
.job-status{font-size:12px;color:var(--text2);}
.job-row.ok .job-status{color:var(--success);}
.job-row.warn .job-status{color:var(--warn);}
.job-row.pending .job-status{color:var(--text3);}
.info{font-size:12px;color:var(--text2);line-height:1.6;padding:12px 14px;background:var(--surface2);border-radius:10px;margin-top:10px;border:1px solid var(--border);}
.shimmer{background:linear-gradient(90deg,var(--surface) 25%,var(--surface2) 50%,var(--surface) 75%);background-size:400px 100%;animation:shimmer 1.5s ease-in-out infinite;border-radius:8px;color:transparent !important;pointer-events:none;}
`;

const HEAD_TAGS = `
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="DERMIS">
  <meta name="theme-color" content="#080808">
  <link rel="manifest" href="/manifest.json">`;

const IOS_PWA_BANNER = `
<style>#pwa-banner{animation:slideUp .5s cubic-bezier(0.16,1,0.3,1) both;}</style>
<div id="pwa-banner" style="display:none;position:fixed;bottom:0;left:0;right:0;background:#111;border-top:1px solid #7C3AED;padding:14px 20px;z-index:999;align-items:center;gap:14px;box-shadow:0 -8px 40px rgba(124,58,237,.2);">
  <div style="flex:1;">
    <div style="font-size:13px;font-weight:600;color:#f0f0f0;margin-bottom:3px;">Add to Home Screen</div>
    <div style="font-size:12px;color:#888;">Tap <strong style="color:#9B6DFF">Share ↑</strong> then <strong style="color:#9B6DFF">Add to Home Screen</strong></div>
  </div>
  <button onclick="document.getElementById('pwa-banner').style.display='none';localStorage.setItem('pwa-off','1')" style="background:transparent;border:1px solid #333;color:#666;border-radius:8px;padding:7px 11px;font-size:13px;cursor:pointer;flex-shrink:0;transition:all .2s;">✕</button>
</div>
<script>(function(){var a=/iphone|ipad|ipod/i.test(navigator.userAgent);var b=window.navigator.standalone;var c=localStorage.getItem('pwa-off');if(a&&!b&&!c)document.getElementById('pwa-banner').style.display='flex';})();</script>`;

const HEADER = (active = '') => `
<div class="header">
  <div class="header-row">
    <div>
      <div class="header-title">DERMIS</div>
      <div class="header-sub">Studio Assistant</div>
    </div>
    <a class="logout" href="/logout">Logout</a>
  </div>
  <div class="nav">
    <a href="/inbox" class="${active==='inbox'?'active':''}">Inbox</a>
    <a href="/schedule" class="${active==='schedule'?'active':''}">Schedule</a>
    <a href="/templates" class="${active==='templates'?'active':''}">Templates</a>
    <a href="/test" class="${active==='test'?'active':''}">Test</a>
    <a href="/status" class="${active==='status'?'active':''}">Status</a>
  </div>
</div>
`;

// ─── PWA manifest ────────────────────────────────────────────────────────────
app.get('/manifest.json', (req, res) => {
  res.json({
    name: 'DERMIS Studio',
    short_name: 'DERMIS',
    description: 'Studio assistant for tattoo appointments',
    start_url: '/inbox',
    display: 'standalone',
    background_color: '#080808',
    theme_color: '#080808',
    orientation: 'portrait',
  });
});

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

  if (process.env.TEMPLATE_SID_ARTIST_NOTIFICATION) {
    const msg = messages.artistNotification(clientName, rawPhone, body);
    console.log(`🔔 Sending artist notification → SID: ${msg.templateSid}, vars: ${JSON.stringify(msg.variables)}`);
    sendToArtistTemplate(msg.templateSid, msg.variables)
      .then(r => console.log(r.success ? `🔔 Artist notified` : `⚠️ Artist notification failed: ${r.error} (code: ${r.code})`))
      .catch(e => console.error(`⚠️ Artist notification error: ${e.message} (code: ${e.code})`));
  } else {
    console.log('⚠️ TEMPLATE_SID_ARTIST_NOTIFICATION not set — skipping artist notification');
  }

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
  <title>DERMIS</title>
  ${HEAD_TAGS}
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','Segoe UI',sans-serif;background:#080808;color:#f0f0f0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;}
    .card{background:#111;border:1px solid #1f1f1f;border-radius:24px;padding:40px 32px;width:100%;max-width:360px;}
    .title{text-align:center;font-size:28px;font-weight:700;letter-spacing:5px;margin-bottom:4px;}
    .subtitle{text-align:center;font-size:10px;color:#9B6DFF;letter-spacing:2.5px;text-transform:uppercase;margin-bottom:36px;font-weight:500;}
    label{display:block;font-size:11px;color:#666;margin-bottom:8px;text-transform:uppercase;letter-spacing:.8px;font-weight:500;}
    input[type="password"]{width:100%;padding:14px 16px;background:#161616;border:1px solid #2a2a2a;border-radius:12px;color:#f0f0f0;font-size:16px;font-family:inherit;transition:border-color .2s;}
    input[type="password"]:focus{outline:none;border-color:#7C3AED;}
    button{width:100%;padding:14px;background:#7C3AED;color:#fff;border:none;border-radius:12px;font-size:15px;font-weight:600;cursor:pointer;margin-top:20px;font-family:inherit;letter-spacing:.4px;transition:background .2s;}
    button:hover{background:#6D28D9;}
    button:active{background:#5B21B6;transform:scale(.98);}
    .error{background:rgba(239,68,68,.1);color:#ef4444;border:1px solid rgba(239,68,68,.2);padding:12px;border-radius:10px;font-size:12px;text-align:center;margin-bottom:20px;animation:slideDown .3s cubic-bezier(0.16,1,0.3,1);}
    @keyframes fadeUp{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:translateY(0)}}
    @keyframes slideDown{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}
    .card{animation:fadeUp .5s cubic-bezier(0.16,1,0.3,1) both;}
  </style>
</head><body>
  <form class="card" method="POST" action="/login">
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

app.post('/login', async (req, res) => {
  const password = req.body.password || '';
  const returnTo = req.body.returnTo || '/inbox';
  if (!checkPassword(password)) {
    return res.redirect(`/login?error=1&returnTo=${encodeURIComponent(returnTo)}`);
  }
  const { token, otp } = createOtpToken(returnTo);
  try {
    const result = await sendOtp(otp);
    if (!result.success) console.warn(`⚠️  OTP send failed: ${result.error}`);
  } catch (e) {
    console.warn(`⚠️  OTP send error: ${e.message}`);
  }
  res.redirect(`/login/otp?t=${token}`);
});

// ─── OTP verification page ────────────────────────────────────────────────────
const OTP_STYLE = `
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','Segoe UI',sans-serif;background:#080808;color:#f0f0f0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;}
  .card{background:#111;border:1px solid #1f1f1f;border-radius:24px;padding:40px 32px;width:100%;max-width:360px;}
  .title{text-align:center;font-size:28px;font-weight:700;letter-spacing:5px;margin-bottom:4px;}
  .subtitle{text-align:center;font-size:10px;color:#9B6DFF;letter-spacing:2.5px;text-transform:uppercase;margin-bottom:8px;font-weight:500;}
  .hint{text-align:center;font-size:12px;color:#555;margin-bottom:32px;line-height:1.5;}
  label{display:block;font-size:11px;color:#666;margin-bottom:8px;text-transform:uppercase;letter-spacing:.8px;font-weight:500;}
  input[type="text"]{width:100%;padding:16px;background:#161616;border:1px solid #2a2a2a;border-radius:12px;color:#f0f0f0;font-size:28px;font-family:ui-monospace,monospace;letter-spacing:8px;text-align:center;transition:border-color .2s;}
  input[type="text"]:focus{outline:none;border-color:#7C3AED;box-shadow:0 0 0 3px rgba(124,58,237,.15);}
  button{width:100%;padding:14px;background:#7C3AED;color:#fff;border:none;border-radius:12px;font-size:15px;font-weight:600;cursor:pointer;margin-top:20px;font-family:inherit;transition:all .2s;}
  button:hover{background:#6D28D9;box-shadow:0 4px 20px rgba(124,58,237,.4);}
  button:active{transform:scale(.98);}
  .back{display:block;text-align:center;margin-top:16px;font-size:12px;color:#444;text-decoration:none;transition:color .2s;}
  .back:hover{color:#888;}
  .error{background:rgba(239,68,68,.1);color:#ef4444;border:1px solid rgba(239,68,68,.2);padding:12px;border-radius:10px;font-size:12px;text-align:center;margin-bottom:20px;}
  @keyframes fadeUp{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:translateY(0)}}
  @keyframes slideDown{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}
  .card{animation:fadeUp .5s cubic-bezier(0.16,1,0.3,1) both;}
  .error{animation:slideDown .3s cubic-bezier(0.16,1,0.3,1);}
`;

app.get('/login/otp', (req, res) => {
  const t = req.query.t || '';
  const errorMsg = req.query.error === 'wrong' ? '<div class="error">Incorrect code — try again</div>'
    : req.query.error === 'expired' ? '<div class="error">Code expired — please log in again</div>'
    : req.query.error === 'too_many' ? '<div class="error">Too many attempts — please log in again</div>'
    : '';
  if (!t) return res.redirect('/login');
  res.send(`<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DERMIS — Verify</title>
  ${HEAD_TAGS}
  <style>${OTP_STYLE}</style>
</head><body>
  <form class="card" method="POST" action="/login/otp">
    <div class="title">DERMIS</div>
    <div class="subtitle">Two-Factor Auth</div>
    <div class="hint">A 6-digit code was sent to your WhatsApp</div>
    ${errorMsg}
    <label>Enter code</label>
    <input type="text" name="otp" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" autofocus required>
    <input type="hidden" name="t" value="${escHtml(t)}">
    <button type="submit">Verify</button>
    <a class="back" href="/login">← Back to login</a>
  </form>
</body></html>`);
});

app.post('/login/otp', (req, res) => {
  const t = req.body.t || '';
  const submitted = (req.body.otp || '').trim();
  const result = verifyOtp(t, submitted);
  if (!result.ok) {
    if (result.reason === 'expired' || result.reason === 'too_many') {
      return res.redirect(`/login?error=1`);
    }
    return res.redirect(`/login/otp?t=${encodeURIComponent(t)}&error=wrong`);
  }
  const sessionToken = createSession();
  res.cookie('dermis_session', sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
  const safeReturn = (result.returnTo || '/inbox').startsWith('/') ? result.returnTo : '/inbox';
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
        <div class="reply-phone">
          ${escHtml(r.from.replace('whatsapp:', ''))}
          ${r.messageSid ? `<a href="https://console.twilio.com/us1/monitor/logs/sms/${escHtml(r.messageSid)}" target="_blank" onclick="event.stopPropagation()" style="margin-left:8px;font-size:11px;color:#888;text-decoration:underline;">View in Twilio ↗</a>` : ''}
        </div>
        <div class="reply-body">${escHtml(r.body)}</div>
      </div>`;
  }).join('');

  res.send(`<!DOCTYPE html>
<html lang="he"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DERMIS — Inbox</title>
  ${HEAD_TAGS}
  <style>
    ${SHARED_CSS}
    .badge{background:var(--error);color:#fff;font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;}
    .badge.zero{background:var(--success);}
    .actions{padding:12px 0;display:flex;gap:8px;align-items:center;}
    .empty{text-align:center;padding:60px 20px;color:var(--text2);font-size:14px;}
    .reply{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:14px 16px;margin-bottom:8px;border-left:3px solid transparent;cursor:pointer;transition:all .2s var(--ease);animation:fadeUp .4s var(--ease) both;}
    .reply.unread{border-left-color:var(--accent);}
    .reply.read{opacity:.45;}
    .reply:hover{border-color:var(--border2);background:var(--surface2);transform:translateY(-1px);}
    .reply:active{transform:scale(.99);}
    .reply-header{display:flex;align-items:center;gap:8px;margin-bottom:3px;}
    .client-name{font-size:14px;font-weight:600;color:var(--text);flex:1;}
    .reply-time{font-size:11px;color:var(--text3);}
    .dot{width:7px;height:7px;border-radius:50%;background:var(--accent);flex-shrink:0;animation:pulse 2s ease-in-out infinite;box-shadow:0 0 6px var(--accent);}
    .reply-phone{font-size:11px;color:var(--text2);margin-bottom:6px;}
    .reply-body{font-size:13px;color:var(--text2);line-height:1.5;background:var(--surface2);padding:10px 12px;border-radius:8px;white-space:pre-wrap;border:1px solid var(--border);}
    .badge{animation:popIn .35s var(--ease) both;}
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
    document.querySelectorAll('.reply').forEach((el, i) => {
      el.style.animationDelay = (i * 50) + 'ms';
    });
    function markRead(id, el) {
      fetch('/mark-read/' + id).then(() => {
        el.style.transition = 'opacity .3s, transform .3s';
        el.classList.remove('unread'); el.classList.add('read');
        const dot = el.querySelector('.dot'); if (dot) dot.remove();
      });
    }
    setTimeout(() => location.reload(), 30000);
  </script>
  ${IOS_PWA_BANNER}
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
    label: 'Same-day Aftercare Instructions',
    desc: 'Sent the evening of the session with care instructions.',
    placeholders: ['{name}'],
  },
  healingCheckIn: {
    label: 'Day-3 Healing Check',
    desc: 'Sent 3 days after the session. Client reply triggers the smart review logic.',
    placeholders: ['{name}'],
  },
  reviewRequest: {
    label: 'Review Request',
    desc: 'Sent automatically after a positive day-3 reply.',
    placeholders: ['{name}'],
  },
  artistNotification: {
    label: 'Artist Reply Notification',
    desc: 'Sent to you when a client replies. You receive this on your personal number.',
    placeholders: ['{name}', '{phone}', '{message}'],
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
  ${HEAD_TAGS}
  <style>
    ${SHARED_CSS}
    .saved-toast{background:var(--success-bg);color:var(--success);border:1px solid rgba(34,197,94,.2);padding:12px 16px;border-radius:10px;font-size:13px;margin:12px 0;text-align:center;animation:slideDown .4s var(--ease) both;}
    .card{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:18px;margin-bottom:12px;}
    .card-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;}
    .tmpl-label{font-size:14px;font-weight:600;color:var(--text);}
    .tmpl-desc{font-size:12px;color:var(--text2);margin-top:3px;line-height:1.4;}
    .placeholders{font-size:11px;color:var(--text3);margin-bottom:10px;}
    .ph{display:inline-block;background:var(--surface2);border:1px solid var(--border2);padding:2px 8px;border-radius:5px;font-family:ui-monospace,'SF Mono',monospace;color:var(--accent-light);font-size:11px;margin-right:4px;cursor:pointer;transition:all .15s;}
    .ph:hover{background:var(--accent);color:#fff;border-color:var(--accent);}
    textarea{width:100%;border:1px solid var(--border2);border-radius:10px;padding:12px 14px;font-family:inherit;font-size:13px;line-height:1.6;resize:vertical;direction:rtl;text-align:right;background:var(--surface2);color:var(--text);transition:border-color .2s;}
    textarea:focus{outline:none;border-color:var(--accent);}
    .save-bar{position:sticky;bottom:0;background:var(--bg);border-top:1px solid var(--border);padding:14px 16px;margin:20px -16px 0;display:flex;gap:10px;justify-content:space-between;align-items:center;}
    .save-bar .info{font-size:12px;color:var(--text3);}
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
  ${IOS_PWA_BANNER}
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
  <title>DERMIS — Test</title>
  ${HEAD_TAGS}
  <style>
    ${SHARED_CSS}
    .card{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:20px;margin-bottom:12px;}
    .card-title{font-size:15px;font-weight:600;margin-bottom:6px;color:var(--text);}
    .card-desc{font-size:12px;color:var(--text2);line-height:1.5;margin-bottom:18px;}
    label{display:block;font-size:11px;color:var(--text2);margin-bottom:7px;text-transform:uppercase;letter-spacing:.7px;margin-top:14px;font-weight:500;}
    label:first-of-type{margin-top:0;}
    select,input[type="text"]{width:100%;padding:11px 14px;border:1px solid var(--border2);border-radius:10px;font-size:14px;font-family:inherit;background:var(--surface2);color:var(--text);transition:border-color .2s;}
    select:focus,input:focus{outline:none;border-color:var(--accent);}
    select option{background:var(--surface);}
    .preview{background:#1a1033;border:1px solid rgba(124,58,237,.3);border-radius:14px 14px 0 14px;padding:14px 16px;font-size:13px;line-height:1.6;white-space:pre-wrap;margin-top:8px;max-width:95%;min-height:50px;color:var(--text);}
    .preview-label{font-size:11px;color:var(--text3);margin-top:14px;margin-bottom:6px;letter-spacing:.5px;}
    .success-toast{background:var(--success-bg);color:var(--success);border:1px solid rgba(34,197,94,.2);padding:12px 16px;border-radius:10px;font-size:13px;margin:12px 0;text-align:center;animation:slideDown .4s var(--ease) both;}
    .error-toast{background:var(--error-bg);color:var(--error);border:1px solid rgba(239,68,68,.2);padding:12px 16px;border-radius:10px;font-size:13px;margin:12px 0;text-align:center;animation:slideDown .4s var(--ease) both;}
    .info-row{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--text2);padding:12px 14px;background:var(--surface2);border-radius:10px;margin-bottom:14px;border:1px solid var(--border);}
    .info-row .icon{font-size:18px;}
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
  ${IOS_PWA_BANNER}
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
    { key: '24h_reminders', label: '24h Reminders',           expected: '09:00' },
    { key: 'day_three',     label: 'Day-3 Healing Check',     expected: '09:00' },
    { key: 'aftercare',     label: 'Same-day Aftercare',      expected: '18:00' },
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
  ${HEAD_TAGS}
  <style>${SHARED_CSS}</style>
</head><body>
  ${HEADER('status')}
  <div class="container">
    <div class="card">
      <div class="card-title">📊 Today's job status</div>
      ${rows}
      <div class="info" style="margin-top:16px;">
        🩺 A health-check runs every <strong>30 minutes</strong> and automatically re-runs any missed job. The day-3 healing check tracks client replies — a positive reply schedules a review request automatically.
      </div>
    </div>

    <div class="card">
      <div class="card-title">📋 Meta template registration</div>
      ${[
        ['TEMPLATE_SID_REMINDER',                 '24h Reminder'],
        ['TEMPLATE_SID_AFTERCARE',               'Same-day Aftercare'],
        ['TEMPLATE_SID_HEALING_CHECKIN',         'Day-3 Healing Check'],
        ['TEMPLATE_SID_REVIEW_REQUEST',          'Review Request'],
        ['TEMPLATE_SID_ARTIST_NOTIFICATION',     'Artist Reply Notification'],
        ['TEMPLATE_SID_PERSONAL_REMINDER_DAY',   'Personal Reminder — Day Before'],
        ['TEMPLATE_SID_PERSONAL_REMINDER_30MIN', 'Personal Reminder — 30 Min Before'],
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
      <button class="btn primary" id="hc-btn" style="flex:1;" onclick="runHealthCheckNow()">🩺 Run Health Check Now</button>
    </div>
    <div id="hc-result" style="display:none;margin-top:10px;padding:12px 14px;border-radius:10px;font-size:13px;border:1px solid var(--border);"></div>
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
          result.style.cssText = 'display:block;margin-top:10px;padding:12px 14px;border-radius:10px;font-size:13px;background:var(--success-bg);color:var(--success);border:1px solid rgba(34,197,94,.2);';
          result.textContent = '✅ Health check completed — any missed jobs have been re-run.';
        } else {
          result.style.cssText = 'display:block;margin-top:10px;padding:12px 14px;border-radius:10px;font-size:13px;background:var(--error-bg);color:var(--error);border:1px solid rgba(239,68,68,.2);';
          result.textContent = '❌ Error: ' + data.error;
        }
      } catch (e) {
        result.style.cssText = 'display:block;margin-top:10px;padding:12px 14px;border-radius:10px;font-size:13px;background:var(--error-bg);color:var(--error);border:1px solid rgba(239,68,68,.2);';
        result.textContent = '❌ Request failed.';
      }
      btn.disabled = false;
      btn.textContent = '🩺 Run Health Check Now';
      location.reload();
    }
  </script>
  ${IOS_PWA_BANNER}
</body></html>`);
});

// ─── Schedule page ───────────────────────────────────────────────────────────
app.get('/schedule', requireAuth, (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DERMIS — Schedule</title>
  ${HEAD_TAGS}
  <style>${SHARED_CSS}</style>
</head><body>
  ${HEADER('schedule')}
  <div class="container">

    <div class="card">
      <div class="card-title">📅 This week — client sessions</div>
      <div id="sessions-body"><div class="shimmer" style="height:18px;margin-bottom:10px;"></div><div class="shimmer" style="height:18px;width:75%;"></div></div>
    </div>

    <div class="card">
      <div class="card-title">⏰ This week — personal reminders</div>
      <div id="remind-body"><div class="shimmer" style="height:18px;margin-bottom:10px;"></div><div class="shimmer" style="height:18px;width:60%;"></div></div>
    </div>

    <button class="btn" style="width:100%;" onclick="location.reload()">↻ Refresh</button>
  </div>
  <script>
    (async () => {
      // ── Client sessions ──
      const sbox = document.getElementById('sessions-body');
      try {
        const r = await fetch('/api/upcoming-sessions');
        const data = await r.json();
        if (!data.ok) { sbox.innerHTML = '<span style="font-size:13px;color:#A32D2D;">❌ ' + data.error + '</span>'; }
        else if (data.sessions.length === 0) {
          sbox.innerHTML = '<span style="font-size:13px;color:#999;">No sessions this week.</span>';
        } else {
          const labels = { reminder: '24h', aftercare: 'Aftercare', day_three: 'Day 3', day_seven: 'Day 7' };
          sbox.innerHTML = data.sessions.map((s, i) => {
            const badges = Object.entries(labels).map(([key, label]) => {
              const sent = s.sent[key];
              if (sent) return \`<span style="font-size:11px;padding:2px 7px;border-radius:20px;background:rgba(34,197,94,.12);color:#22c55e;border:1px solid rgba(34,197,94,.25);">✅ \${label}</span>\`;
              const payload = JSON.stringify({ eventId: s.id, messageType: key, phone: s.phone, firstName: s.firstName, timeString: s.time });
              return \`<button onclick="sendManually(this,\${payload.replace(/"/g,'&quot;')})" style="font-size:11px;padding:2px 7px;border-radius:20px;background:#1f1f1f;color:#888;border:1px solid #2a2a2a;cursor:pointer;">⬜ \${label} ▶</button>\`;
            }).join(' ');
            return \`<div class="job-row" style="flex-direction:column;align-items:flex-start;gap:6px;animation:fadeUp .4s var(--ease) both;animation-delay:\${i*60}ms;">
              <div style="display:flex;justify-content:space-between;width:100%;align-items:center;">
                <div class="job-label" style="direction:rtl;">\${s.title}</div>
                <div style="font-size:11px;color:var(--text3);">\${s.date} · \${s.time}</div>
              </div>
              <div style="display:flex;gap:4px;flex-wrap:wrap;">\${badges}</div>
            </div>\`;
          }).join('');
        }
      } catch(e) { sbox.innerHTML = '<span style="font-size:13px;color:#A32D2D;">❌ Failed to load sessions.</span>'; }

      // ── Personal reminders ──
      const rbox = document.getElementById('remind-body');
      try {
        const r = await fetch('/api/remind-events');
        const data = await r.json();
        if (!data.ok) { rbox.innerHTML = '<span style="font-size:13px;color:#A32D2D;">❌ ' + data.error + '</span>'; }
        else if (data.events.length === 0) {
          rbox.innerHTML = '<span style="font-size:13px;color:#999;">No reminder events this week.</span>';
        } else {
          rbox.innerHTML = data.events.map((e, i) => {
            const sent_s = 'font-size:11px;padding:2px 7px;border-radius:20px;background:rgba(34,197,94,.12);color:#22c55e;border:1px solid rgba(34,197,94,.25);';
            const unsent_s = 'font-size:11px;padding:2px 7px;border-radius:20px;background:#1f1f1f;color:#555;border:1px solid #2a2a2a;';
            const dayBadge = e.sent.day_before
              ? \`<span style="\${sent_s}">✅ יום לפני</span>\`
              : \`<span style="\${unsent_s}">⬜ יום לפני</span>\`;
            const minBadge = e.sent.thirty_min
              ? \`<span style="\${sent_s}">✅ 30 דקות</span>\`
              : \`<span style="\${unsent_s}">⬜ 30 דקות</span>\`;
            return \`<div class="job-row" style="flex-direction:column;align-items:flex-start;gap:6px;animation:fadeUp .4s var(--ease) both;animation-delay:\${i*60}ms;">
              <div style="display:flex;justify-content:space-between;width:100%;align-items:center;">
                <div class="job-label" style="direction:rtl;">\${e.title}</div>
                <div style="font-size:11px;color:var(--text3);">\${e.date} · \${e.time}</div>
              </div>
              <div style="display:flex;gap:4px;">\${dayBadge} \${minBadge}</div>
            </div>\`;
          }).join('');
        }
      } catch(e) { rbox.innerHTML = '<span style="font-size:13px;color:#A32D2D;">❌ Failed to load reminders.</span>'; }
    })();

    async function sendManually(btn, payload) {
      btn.disabled = true; btn.textContent = '⏳ Sending...';
      try {
        const r = await fetch('/api/send-manually', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(typeof payload === 'string' ? JSON.parse(payload) : payload),
        });
        const data = await r.json();
        if (data.ok) {
          btn.style.cssText = 'font-size:11px;padding:2px 7px;border-radius:20px;background:rgba(34,197,94,.15);color:#22c55e;border:1px solid rgba(34,197,94,.3);cursor:default;';
          btn.textContent = '✅ ' + btn.textContent.replace('⏳ Sending...','').trim().replace(' ▶','');
          btn.disabled = true;
        } else { btn.textContent = '❌ ' + (data.error || 'Failed'); btn.disabled = false; }
      } catch(e) { btn.textContent = '❌ Error'; btn.disabled = false; }
    }
  </script>
  ${IOS_PWA_BANNER}
</body></html>`);
});

// ─── Remind events API ────────────────────────────────────────────────────────
app.get('/api/remind-events', requireAuth, async (req, res) => {
  try {
    const { getPersonalReminderEvents } = require('./calendar');
    const { wasAlreadySent } = require('./sent-events');
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(start); end.setDate(end.getDate() + 7);
    const events = await getPersonalReminderEvents(start, end);
    res.json({ ok: true, events: events.map(e => ({
      id: e.id,
      title: e.title,
      date: e.startTime.toLocaleDateString('he-IL', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'Asia/Jerusalem' }),
      time: e.timeString,
      sent: {
        day_before:  wasAlreadySent(e.id, 'personal_day_before'),
        thirty_min:  wasAlreadySent(e.id, 'personal_30min'),
      },
    })) });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ─── Upcoming sessions (calendar preview) ────────────────────────────────────
app.get('/api/upcoming-sessions', requireAuth, async (req, res) => {
  try {
    const { getSessionsInRange } = require('./calendar');
    const { wasAlreadySent } = require('./sent-events');
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    const sessions = await getSessionsInRange(start, end);
    const MSG_TYPES = ['reminder', 'aftercare', 'day_three', 'day_seven'];
    res.json({ ok: true, sessions: sessions.map(s => ({
      id: s.id,
      firstName: s.firstName,
      fullName: s.fullName,
      phone: s.rawPhone,
      date: s.startTime.toLocaleDateString('he-IL', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'Asia/Jerusalem' }),
      time: s.timeString,
      title: s.title,
      sent: Object.fromEntries(MSG_TYPES.map(t => [t, wasAlreadySent(s.id, t)])),
    })) });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ─── Manual message send ─────────────────────────────────────────────────────
app.post('/api/send-manually', requireAuth, async (req, res) => {
  const { eventId, messageType, phone, firstName, timeString } = req.body;
  if (!eventId || !messageType || !phone || !firstName)
    return res.json({ ok: false, error: 'Missing parameters' });

  const { wasAlreadySent, markSent } = require('./sent-events');
  const { sendToClient } = require('./whatsapp');

  if (wasAlreadySent(eventId, messageType))
    return res.json({ ok: false, error: 'Already sent' });

  const typeToMsg = {
    reminder:  () => messages.reminder(firstName, timeString || ''),
    aftercare: () => messages.aftercare(firstName),
    day_three: () => messages.healingCheckIn(firstName, ''),
    day_seven: () => messages.healingCheckIn(firstName, ''),
  };
  if (!typeToMsg[messageType]) return res.json({ ok: false, error: 'Unknown type' });

  const msg = typeToMsg[messageType]();
  const result = await sendToClient(`whatsapp:${phone}`, msg.templateSid, msg.variables);
  if (result.success) {
    markSent(eventId, messageType);
    console.log(`📤 Manual send: ${messageType} → ${firstName} (${phone})`);
    res.json({ ok: true });
  } else {
    res.json({ ok: false, error: result.error });
  }
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
