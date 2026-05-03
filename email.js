const { Resend } = require('resend');

const ARTIST_EMAIL = process.env.ARTIST_EMAIL || 'omer3107@gmail.com';

function getClient() {
  if (!process.env.RESEND_API_KEY) return null;
  return new Resend(process.env.RESEND_API_KEY);
}

async function sendEmail(subject, text) {
  const client = getClient();
  if (!client) {
    console.warn('⚠️ RESEND_API_KEY not set — email skipped');
    return { success: false, error: 'RESEND_API_KEY not set' };
  }
  try {
    const { error } = await client.emails.send({
      from: 'DERMIS <onboarding@resend.dev>',
      to: ARTIST_EMAIL,
      subject,
      text,
    });
    if (error) throw new Error(error.message);
    console.log(`📧 Email sent: ${subject}`);
    return { success: true };
  } catch (e) {
    console.error(`❌ Email failed: ${e.message}`);
    return { success: false, error: e.message };
  }
}

module.exports = { sendEmail };
