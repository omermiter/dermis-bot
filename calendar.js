// calendar.js — Reads sessions from Google Calendar
// Parses event titles like: סשן עם נועה
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

async function getCalendarWriteClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: path.resolve(process.env.GOOGLE_SERVICE_ACCOUNT_KEY),
    scopes: ['https://www.googleapis.com/auth/calendar.events'],
  });
  return google.calendar({ version: 'v3', auth });
}

const CANCELLED_PREFIX = '[CANCELLED] ';
const SESSION_PREFIX = 'סשן עם ';

// Parse event title: "סשן עם נועה" → { firstName: 'נועה', lastName: '', fullName: 'נועה' }
// Also handles "[CANCELLED] סשן עם נועה"
function parseTitleName(title) {
  const base = title.startsWith(CANCELLED_PREFIX) ? title.slice(CANCELLED_PREFIX.length) : title;
  if (!base.startsWith(SESSION_PREFIX)) return null;
  const firstName = base.slice(SESSION_PREFIX.length).trim();
  if (!firstName) return null;
  return { firstName, lastName: '', fullName: firstName };
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
    const rawTitle = event.summary || '';
    const cancelled = rawTitle.startsWith(CANCELLED_PREFIX);
    // Only process session events (with or without the cancelled prefix)
    const base = cancelled ? rawTitle.slice(CANCELLED_PREFIX.length) : rawTitle;
    if (!base.startsWith(SESSION_PREFIX)) continue;

    const nameInfo = parseTitleName(rawTitle);
    if (!nameInfo) continue;

    const phone = parsePhone(event.description);
    if (!phone) {
      if (!cancelled) console.warn(`⚠️  No phone number found for event: "${rawTitle}" — skipping`);
      if (!cancelled) continue;
      // Cancelled events may have had phone stripped — include them with a placeholder
    }

    const startTime = event.start.dateTime || event.start.date;
    const endTime = event.end.dateTime || event.end.date;

    sessions.push({
      id: event.id,
      title: base,
      firstName: nameInfo.firstName,
      lastName: nameInfo.lastName,
      fullName: nameInfo.fullName,
      phone: phone ? `whatsapp:${phone}` : null,
      rawPhone: phone || null,
      startTime: new Date(startTime),
      endTime: new Date(endTime),
      timeString: new Date(startTime).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' }),
      cancelled,
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

// Get all events with "remind" in their description within a date range
async function getPersonalReminderEvents(startDate, endDate) {
  const calendar = await getCalendarClient();
  const response = await calendar.events.list({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    timeMin: startDate.toISOString(),
    timeMax: endDate.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
  });
  return (response.data.items || [])
    .filter(e => (e.description || '').toLowerCase().includes('remind'))
    .map(e => ({
      id: e.id,
      title: e.summary || '(No title)',
      startTime: new Date(e.start.dateTime || e.start.date),
      timeString: new Date(e.start.dateTime || e.start.date)
        .toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' }),
    }));
}

// Get all events containing the word "story" in title or description
async function getStoryEvents(startDate, endDate) {
  const calendar = await getCalendarClient();
  const response = await calendar.events.list({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    timeMin: startDate.toISOString(),
    timeMax: endDate.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
  });
  const re = /\bstory\b/i;
  return (response.data.items || [])
    .filter(e => re.test(e.summary || '') || re.test(e.description || ''))
    .map(e => {
      const startTime = new Date(e.start.dateTime || e.start.date);
      return {
        id: e.id,
        title: e.summary || '(No title)',
        startTime,
        timeString: startTime.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' }),
      };
    });
}

// Mark a session as cancelled in Google Calendar (prefixes title with [CANCELLED])
async function cancelSession(eventId) {
  const calendar = await getCalendarWriteClient();
  const { data: event } = await calendar.events.get({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    eventId,
  });
  if ((event.summary || '').startsWith(CANCELLED_PREFIX)) return; // already cancelled
  await calendar.events.patch({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    eventId,
    requestBody: { summary: CANCELLED_PREFIX + (event.summary || '') },
  });
}

module.exports = {
  getTodaySessions,
  getTomorrowSessions,
  getSessionsFromDaysAgo,
  getSessionsInRange,
  getPersonalReminderEvents,
  getStoryEvents,
  cancelSession,
};
