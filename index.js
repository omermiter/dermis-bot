// index.js — DERMIS bot main entry point
// Runs scheduled jobs + webhook server + self-healing health checks

require('dotenv').config();
const cron = require('node-cron');
const {
  getTodaySessions, getTomorrowSessions, getSessionsFromDaysAgo, getSessionsInRange,
  getPersonalReminderEvents, getStoryEvents,
} = require('./calendar');
const { sendToClient, sendToArtistTemplate } = require('./whatsapp');
const messages = require('./messages');
const { startServer, registerClientPhone, markAwaitingDay7 } = require('./server');
const pendingReviews = require('./pending-reviews');
const { markJobCompleted, hasJobRunToday } = require('./job-state');
const { wasAlreadySent, markSent, pruneOldEntries } = require('./sent-events');
const { pruneOldReplies } = require('./replies-store');
const { pruneOldRecords } = require('./pending-reviews');

// ─── Helper: log with timestamp ──────────────────────────────────────────────
function log(msg) {
  console.log(`[${new Date().toLocaleString('he-IL')}] ${msg}`);
}

// ─── Refresh client phone map ────────────────────────────────────────────────
async function refreshClientPhoneMap() {
  try {
    const start = new Date(); start.setDate(start.getDate() - 14);
    const end = new Date(); end.setDate(end.getDate() + 30);
    const sessions = await getSessionsInRange(start, end);
    for (const s of sessions) registerClientPhone(s.phone, s.fullName);
    log(`📋 Registered ${sessions.length} client phones for reply matching`);
  } catch (e) {
    log(`⚠️  Could not refresh phone map: ${e.message}`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// REUSABLE JOB FUNCTIONS — each can be triggered by cron OR by the health-check
// Each returns true if it ran successfully (even if 0 messages sent)
// ════════════════════════════════════════════════════════════════════════════

// Prevents two instances of the same job running concurrently (e.g. cron + health-check
// firing at the same minute — both async, health-check can start a job before cron's
// markJobCompleted/markSent calls resolve, causing duplicate sends).
const runningJobs = new Set();

async function runJob_24hReminders() {
  if (runningJobs.has('24h_reminders')) { log('⚠️  24h reminders already running — skipping'); return false; }
  runningJobs.add('24h_reminders');
  log('⏰ Running: 24h session reminders...');
  try {
    const sessions = await getTomorrowSessions();
    for (const session of sessions) {
      if (wasAlreadySent(session.id, 'reminder')) {
        log(`   Skipping ${session.fullName} — reminder already sent`);
        continue;
      }
      const msg = messages.reminder(session.firstName, session.timeString);
      const result = await sendToClient(session.phone, msg.templateSid, msg.variables);
      if (result.success) {
        markSent(session.id, 'reminder');
        log(`📨 24h reminder sent → ${session.fullName} (${session.timeString})`);
      } else {
        log(`⚠️ Reminder FAILED for ${session.fullName}: ${result.error}`);
      }
    }
    if (sessions.length === 0) log('   No sessions tomorrow.');
    markJobCompleted('24h_reminders');
    return true;
  } catch (e) { log(`❌ Job failed: ${e.message}`); return false; }
  finally { runningJobs.delete('24h_reminders'); }
}

async function runJob_aftercare() {
  if (runningJobs.has('aftercare')) { log('⚠️  Aftercare already running — skipping'); return false; }
  runningJobs.add('aftercare');
  if (!process.env.TEMPLATE_SID_AFTERCARE) { runningJobs.delete('aftercare'); markJobCompleted('aftercare'); return true; }
  log('⏰ Running: same-day aftercare instructions...');
  try {
    const sessions = await getTodaySessions();
    for (const session of sessions) {
      if (wasAlreadySent(session.id, 'aftercare')) {
        log(`   Skipping ${session.fullName} — aftercare already sent`);
        continue;
      }
      const msg = messages.aftercare(session.firstName);
      const result = await sendToClient(session.phone, msg.templateSid, msg.variables);
      if (result.success) { markSent(session.id, 'aftercare'); log(`📨 Aftercare sent → ${session.fullName}`); }
      else log(`⚠️ Aftercare FAILED for ${session.fullName}: ${result.error}`);
    }
    if (sessions.length === 0) log('   No sessions today.');
    markJobCompleted('aftercare');
    return true;
  } catch (e) { log(`❌ Job failed: ${e.message}`); return false; }
  finally { runningJobs.delete('aftercare'); }
}

async function runJob_dayThreeAftercare() {
  if (runningJobs.has('day_three')) { log('⚠️  Day-3 check already running — skipping'); return false; }
  runningJobs.add('day_three');
  if (!process.env.TEMPLATE_SID_HEALING_CHECKIN) { runningJobs.delete('day_three'); markJobCompleted('day_three'); return true; }
  log('⏰ Running: day-3 healing check...');
  try {
    const sessions = await getSessionsFromDaysAgo(3);
    for (const session of sessions) {
      if (wasAlreadySent(session.id, 'day_three')) {
        log(`   Skipping ${session.fullName} — day-3 check already sent`);
        continue;
      }
      const msg = messages.healingCheckIn(session.firstName, '');
      const result = await sendToClient(session.phone, msg.templateSid, msg.variables);
      if (result.success) {
        markSent(session.id, 'day_three');
        markAwaitingDay7(session.phone, session.firstName, session.fullName);
        log(`📨 Day-3 check sent → ${session.fullName} (awaiting reply)`);
      } else log(`⚠️ Day-3 check FAILED for ${session.fullName}: ${result.error}`);
    }
    if (sessions.length === 0) log('   No sessions 3 days ago.');
    markJobCompleted('day_three');
    return true;
  } catch (e) { log(`❌ Job failed: ${e.message}`); return false; }
  finally { runningJobs.delete('day_three'); }
}

async function runJob_smartReviewDispatcher() {
  if (!process.env.TEMPLATE_SID_REVIEW_REQUEST) return true;
  try {
    const due = pendingReviews.getDueReviews();
    if (due.length === 0) return true;
    log(`⏰ Running: smart review dispatcher (${due.length} due)...`);
    for (const item of due) {
      const msg = messages.reviewRequest(item.firstName);
      const result = await sendToClient(item.phone, msg.templateSid, msg.variables);
      if (result.success) {
        pendingReviews.markSent(item.phone);
        log(`⭐ Smart review request sent → ${item.fullName}`);
      } else log(`⚠️ Review request FAILED for ${item.fullName}: ${result.error}`);
    }
    return true;
  } catch (e) { log(`❌ Job failed: ${e.message}`); return false; }
}

// ════════════════════════════════════════════════════════════════════════════
// HEALTH-CHECK JOB — runs every 30 minutes
// Detects and recovers missed jobs (e.g. due to server downtime)
// ════════════════════════════════════════════════════════════════════════════

async function runHealthCheck() {
  const now = new Date();
  const israelTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  const hour = israelTime.getHours();

  // Morning jobs (scheduled for 09:00)
  if (hour >= 9) {
    if (!hasJobRunToday('24h_reminders')) {
      log('🩺 Health-check: 24h reminders missed today — running now');
      await runJob_24hReminders();
    }
    if (!hasJobRunToday('day_three')) {
      log('🩺 Health-check: day-3 check missed today — running now');
      await runJob_dayThreeAftercare();
    }
  }

  // Evening job (scheduled for 18:00)
  if (hour >= 18) {
    if (!hasJobRunToday('aftercare')) {
      log('🩺 Health-check: aftercare missed today — running now');
      await runJob_aftercare();
    }
  }

  // Smart review dispatcher (runs every hour anyway, also runs during health-check)
  await runJob_smartReviewDispatcher();
}

// ════════════════════════════════════════════════════════════════════════════
// CRON SCHEDULE
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// WEEKLY CLEANUP — every Sunday at 03:00
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// PERSONAL REMINDERS — for events with "remind" in the description
// ════════════════════════════════════════════════════════════════════════════

async function runJob_personalDayBeforeReminders() {
  try {
    if (!process.env.TEMPLATE_SID_PERSONAL_REMINDER_DAY) { log('⚠️ TEMPLATE_SID_PERSONAL_REMINDER_DAY not set'); return; }
    const start = new Date();
    start.setDate(start.getDate() + 1);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);
    const events = await getPersonalReminderEvents(start, end);
    for (const event of events) {
      if (wasAlreadySent(event.id, 'personal_day_before')) continue;
      const result = await sendToArtistTemplate(process.env.TEMPLATE_SID_PERSONAL_REMINDER_DAY, { 1: event.title, 2: event.timeString });
      if (result.success) { markSent(event.id, 'personal_day_before'); log(`📅 Day-before reminder sent: ${event.title}`); }
      else log(`⚠️ Day-before reminder FAILED: ${result.error}`);
    }
  } catch (e) { log(`❌ Personal day-before reminders error: ${e.message}`); }
}

async function runJob_personal30MinReminders() {
  try {
    if (!process.env.TEMPLATE_SID_PERSONAL_REMINDER_30MIN) { log('⚠️ TEMPLATE_SID_PERSONAL_REMINDER_30MIN not set'); return; }
    const now = new Date();
    const from = new Date(now.getTime() + 20 * 60 * 1000);
    const to   = new Date(now.getTime() + 40 * 60 * 1000);
    const events = await getPersonalReminderEvents(from, to);
    for (const event of events) {
      if (wasAlreadySent(event.id, 'personal_30min')) continue;
      const result = await sendToArtistTemplate(process.env.TEMPLATE_SID_PERSONAL_REMINDER_30MIN, { 1: event.title, 2: event.timeString });
      if (result.success) { markSent(event.id, 'personal_30min'); log(`📅 30-min reminder sent: ${event.title}`); }
      else log(`⚠️ 30-min reminder FAILED: ${result.error}`);
    }
  } catch (e) { log(`❌ Personal 30-min reminders error: ${e.message}`); }
}

// ════════════════════════════════════════════════════════════════════════════
// STORY REMINDERS — STORY-type BOT_TEMPLATE events, 5 minutes before
// ════════════════════════════════════════════════════════════════════════════

async function runJob_storyReminders() {
  try {
    if (!process.env.TEMPLATE_SID_STORY_REMINDER) return;
    const now = new Date();
    const from = new Date(now.getTime() + 2 * 60 * 1000);   // 2 min from now
    const to   = new Date(now.getTime() + 8 * 60 * 1000);   // 8 min from now
    const events = await getStoryEvents(from, to);
    for (const event of events) {
      if (wasAlreadySent(event.id, 'story_5min')) continue;
      const result = await sendToArtistTemplate(
        process.env.TEMPLATE_SID_STORY_REMINDER,
        { 1: event.title, 2: event.timeString }
      );
      if (result.success) { markSent(event.id, 'story_5min'); log(`📸 Story reminder sent: ${event.title}`); }
      else log(`⚠️ Story reminder FAILED: ${result.error}`);
    }
  } catch (e) { log(`❌ Story reminders error: ${e.message}`); }
}

async function runWeeklyCleanup() {
  log('🧹 Running weekly data cleanup...');
  const r1 = pruneOldReplies(30);    // drop read replies older than 30 days
  const r2 = pruneOldRecords(90);    // drop sent review records older than 90 days
  const r3 = pruneOldEntries();      // flush sent-events 60-day cutoff
  log(`🧹 Cleanup done — replies: -${r1}, review records: -${r2}, sent-events: -${r3}`);
}

// Morning batch at 09:00
cron.schedule('0 9 * * *', runJob_24hReminders,      { timezone: 'Asia/Jerusalem' });
cron.schedule('0 9 * * *', runJob_dayThreeAftercare, { timezone: 'Asia/Jerusalem' });

// Evening at 18:00
cron.schedule('0 18 * * *', runJob_aftercare, { timezone: 'Asia/Jerusalem' });

// Smart review dispatcher — every hour
cron.schedule('0 * * * *', runJob_smartReviewDispatcher, { timezone: 'Asia/Jerusalem' });

// Health-check — every 30 minutes
cron.schedule('*/30 * * * *', runHealthCheck, { timezone: 'Asia/Jerusalem' });

// Refresh client phone map every 6 hours
cron.schedule('0 */6 * * *', refreshClientPhoneMap, { timezone: 'Asia/Jerusalem' });

// Personal reminders — day-before at 09:00, 30-min check every 10 minutes
cron.schedule('0 9 * * *',    runJob_personalDayBeforeReminders, { timezone: 'Asia/Jerusalem' });
cron.schedule('*/10 * * * *', runJob_personal30MinReminders,     { timezone: 'Asia/Jerusalem' });

// Story reminders — 5 min before, checked every 3 minutes
cron.schedule('*/3 * * * *', runJob_storyReminders, { timezone: 'Asia/Jerusalem' });

// Weekly cleanup — every Sunday at 03:00
cron.schedule('0 3 * * 0', runWeeklyCleanup, { timezone: 'Asia/Jerusalem' });

// ════════════════════════════════════════════════════════════════════════════
// EXPORT job functions so the web app can trigger them too (for test messages)
// ════════════════════════════════════════════════════════════════════════════

module.exports = {
  runJob_24hReminders,
  runJob_aftercare,
  runJob_dayThreeAftercare,
  runJob_smartReviewDispatcher,
  runHealthCheck,
};

// ────────────────────────────────────────────────────────────────────────────
// Boot
// ────────────────────────────────────────────────────────────────────────────
(async () => {
  log('🖤 DERMIS starting...');
  await refreshClientPhoneMap();
  startServer();
  log('');
  log('   Scheduled jobs:');
  log('   • 09:00 → 24h reminders, day-3 healing check, personal day-before reminders');
  log('   • 18:00 → Same-day aftercare instructions');
  log('   • Hourly → Smart review dispatcher');
  log('   • Every 10 min → Personal 30-min reminders');
  log('   • Every 30 min → Health-check (recovers missed jobs)');
  log('   • Every 6 hours → Refresh client phone map');
  log('   Timezone: Asia/Jerusalem');

  // Run health-check immediately on startup to recover any missed jobs from downtime
  log('🩺 Running initial health-check on startup...');
  await runHealthCheck();
})();
