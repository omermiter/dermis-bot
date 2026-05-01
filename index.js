// index.js — DERMIS bot main entry point
// Runs scheduled jobs + webhook server + self-healing health checks

require('dotenv').config();
const cron = require('node-cron');
const {
  getTodaySessions, getTomorrowSessions, getSessionsFromDaysAgo, getSessionsInRange
} = require('./calendar');
const { sendToClient } = require('./whatsapp');
const messages = require('./messages');
const { startServer, registerClientPhone, markAwaitingDay7 } = require('./server');
const pendingReviews = require('./pending-reviews');
const { markJobCompleted, hasJobRunToday } = require('./job-state');
const { wasAlreadySent, markSent } = require('./sent-events');

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

async function runJob_dayThreeAftercare() {
  if (runningJobs.has('day_three')) { log('⚠️  Day-3 aftercare already running — skipping'); return false; }
  runningJobs.add('day_three');
  if (!process.env.TEMPLATE_SID_AFTERCARE) { runningJobs.delete('day_three'); markJobCompleted('day_three'); return true; }
  log('⏰ Running: day-3 aftercare messages...');
  try {
    const sessions = await getSessionsFromDaysAgo(3);
    for (const session of sessions) {
      if (wasAlreadySent(session.id, 'day_three')) {
        log(`   Skipping ${session.fullName} — day-3 aftercare already sent`);
        continue;
      }
      const msg = messages.aftercare(session.firstName);
      const result = await sendToClient(session.phone, msg.templateSid, msg.variables);
      if (result.success) {
        markSent(session.id, 'day_three');
        markAwaitingDay7(session.phone, session.firstName, session.fullName);
        log(`📨 Day-3 aftercare sent → ${session.fullName} (awaiting reply)`);
      } else log(`⚠️ Day-3 aftercare FAILED for ${session.fullName}: ${result.error}`);
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

  // Morning jobs (scheduled for 09:00) — check if missed and we're now after 09:00
  if (hour >= 9) {
    if (!hasJobRunToday('24h_reminders')) {
      log('🩺 Health-check: 24h reminders missed today — running now');
      await runJob_24hReminders();
    }
    if (!hasJobRunToday('day_three')) {
      log('🩺 Health-check: day-3 aftercare missed today — running now');
      await runJob_dayThreeAftercare();
    }
  }

  // Smart review dispatcher (runs every hour anyway, also runs during health-check)
  await runJob_smartReviewDispatcher();
}

// ════════════════════════════════════════════════════════════════════════════
// CRON SCHEDULE
// ════════════════════════════════════════════════════════════════════════════

// Morning batch at 09:00
cron.schedule('0 9 * * *', runJob_24hReminders,      { timezone: 'Asia/Jerusalem' });
cron.schedule('0 9 * * *', runJob_dayThreeAftercare, { timezone: 'Asia/Jerusalem' });

// Smart review dispatcher — every hour
cron.schedule('0 * * * *', runJob_smartReviewDispatcher, { timezone: 'Asia/Jerusalem' });

// Health-check — every 30 minutes
cron.schedule('*/30 * * * *', runHealthCheck, { timezone: 'Asia/Jerusalem' });

// Refresh client phone map every 6 hours
cron.schedule('0 */6 * * *', refreshClientPhoneMap, { timezone: 'Asia/Jerusalem' });

// ════════════════════════════════════════════════════════════════════════════
// EXPORT job functions so the web app can trigger them too (for test messages)
// ════════════════════════════════════════════════════════════════════════════

module.exports = {
  runJob_24hReminders,
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
  log('   • 09:00 → 24h reminders, day-3 aftercare (tracks reply → review request)');
  log('   • Hourly → Smart review dispatcher');
  log('   • Every 30 min → Health-check (recovers missed jobs)');
  log('   • Every 6 hours → Refresh client phone map');
  log('   Timezone: Asia/Jerusalem');

  // Run health-check immediately on startup to recover any missed jobs from downtime
  log('🩺 Running initial health-check on startup...');
  await runHealthCheck();
})();
