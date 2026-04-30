// calendar.js — Reads sessions from Google Calendar
// Parses event titles like: session_Noa_Cohen
// Parses event description for: Phone: 05XXXXXXXX

const { google } = require('googleapis');
const path = require('path');

async function getCalendarClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: path.resolve(process.env.GOOGLE_SERVICE_ACCOUNT_KEY),
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
  });
  return google.calendar({ version: 'v3', auth });
}

// Parse event title: session_Noa_Cohen → { firstName: 'Noa', lastName: 'Cohen', fullName: 'Noa Cohen' }
function parseTitleName(title) {
  // Expected format: session_Firstname_Lastname (or session_Firstname_Lastname_extra)
  const parts = title.trim().split('_');
  if (parts.length < 3 || parts[0].toLowerCase() !== 'session') return null;
  const firstName = parts[1];
  const lastName = parts.slice(2).join(' '); // handles double last names too
  return {
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`,
  };
}

// Parse description for phone number line: "Phone: 0501234567"
function parsePhone(description) {
  if (!description) return null;
  const match = description.match(/Phone:\s*([\d\-\+\s]+)/i);
  if (!match) return null;
  // Normalise: strip spaces/dashes, ensure it starts with +972 for Israeli numbers
  let phone = match[1].replace(/[\s\-]/g, '');
  if (phone.startsWith('0')) phone = '+972' + phone.slice(1);
  return phone;
}

// Get all sessions within a date range
async function getSessionsInRange(startDate, endDate) {
  const calendar = await getCalendarClient();

  const response = await calendar.events.list({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    timeMin: startDate.toISOString(),
    timeMax: endDate.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
  });

  const events = response.data.items || [];
  const sessions = [];

  for (const event of events) {
    const title = event.summary || '';
    if (!title.toLowerCase().startsWith('session_')) continue; // skip non-session events

    const nameInfo = parseTitleName(title);
    if (!nameInfo) continue;

    const phone = parsePhone(event.description);
    if (!phone) {
      console.warn(`⚠️  No phone number found for event: "${title}" — skipping`);
      continue;
    }

    const startTime = event.start.dateTime || event.start.date;
    const endTime = event.end.dateTime || event.end.date;

    sessions.push({
      id: event.id,
      title,
      firstName: nameInfo.firstName,
      lastName: nameInfo.lastName,
      fullName: nameInfo.fullName,
      phone: `whatsapp:${phone}`,
      rawPhone: phone,
      startTime: new Date(startTime),
      endTime: new Date(endTime),
      timeString: new Date(startTime).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }),
    });
  }

  return sessions;
}

// Get today's sessions
async function getTodaySessions() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return getSessionsInRange(start, end);
}

// Get tomorrow's sessions (for 24h reminders)
async function getTomorrowSessions() {
  const start = new Date();
  start.setDate(start.getDate() + 1);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setHours(23, 59, 59, 999);
  return getSessionsInRange(start, end);
}

// Get sessions from exactly N days ago (for follow-ups)
async function getSessionsFromDaysAgo(days) {
  const start = new Date();
  start.setDate(start.getDate() - days);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setHours(23, 59, 59, 999);
  return getSessionsInRange(start, end);
}

module.exports = {
  getTodaySessions,
  getTomorrowSessions,
  getSessionsFromDaysAgo,
  getSessionsInRange,
};
