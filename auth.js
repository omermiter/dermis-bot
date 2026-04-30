// auth.js — Simple cookie-based password authentication
// Single user (you, the artist). Password set in .env as ARTIST_PASSWORD

const crypto = require('crypto');

// Generate a random session token on each server start
const SESSION_SECRET = crypto.randomBytes(32).toString('hex');

// Track active sessions in memory (token -> expiry timestamp)
const activeSessions = new Map();
const SESSION_DURATION = 30 * 24 * 60 * 60 * 1000; // 30 days

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  const expiry = Date.now() + SESSION_DURATION;
  activeSessions.set(token, expiry);
  return token;
}

function isValidSession(token) {
  if (!token) return false;
  const expiry = activeSessions.get(token);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    activeSessions.delete(token);
    return false;
  }
  return true;
}

function destroySession(token) {
  activeSessions.delete(token);
}

// Constant-time password comparison to prevent timing attacks
function checkPassword(submitted) {
  const correct = process.env.ARTIST_PASSWORD || '';
  if (!correct) {
    console.error('⚠️  ARTIST_PASSWORD not set in .env — login will fail!');
    return false;
  }
  if (submitted.length !== correct.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(submitted),
    Buffer.from(correct)
  );
}

// Middleware: requires a valid session cookie or redirects to /login
function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies.dermis_session;
  if (isValidSession(token)) {
    return next();
  }
  // Save where they were trying to go so we can redirect after login
  const returnTo = encodeURIComponent(req.originalUrl);
  return res.redirect(`/login?returnTo=${returnTo}`);
}

module.exports = {
  createSession,
  destroySession,
  isValidSession,
  checkPassword,
  requireAuth,
};
