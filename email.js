const nodemailer = require('nodemailer');

const ARTIST_EMAIL = process.env.ARTIST_EMAIL || 'omer3107@gmail.com';

function getTransporter() {
  if (!process.env.GMAIL_APP_PASSWORD) return null;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: ARTIST_EMAIL, pass: process.env.GMAIL_APP_PASSWORD },
  });
}

async function sendEmail(subject, text) {
  const t = getTransporter();
  if (!t) {
    console.warn('⚠️ GMAIL_APP_PASSWORD not set — email skipped');
    return { success: false, error: 'GMAIL_APP_PASSWORD not set' };
  }
  try {
    await t.sendMail({ from: `DERMIS <${ARTIST_EMAIL}>`, to: ARTIST_EMAIL, subject, text });
    console.log(`📧 Email sent: ${subject}`);
    return { success: true };
  } catch (e) {
    console.error(`❌ Email failed: ${e.message}`);
    return { success: false, error: e.message };
  }
}

module.exports = { sendEmail };
