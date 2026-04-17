// reminderJob.js — Daily cron job that sends follow-up reminder emails.
// Runs at 2:00 PM server time every day.
//
// Rules:
// - Only quotations with status Sent or In Progress are eligible
// - followUpDate must be in the past (overdue)
// - Stop after 3 weeks (21 days) past the followUpDate
// - Only send ONE reminder per quotation per calendar day (duplicate prevention)
// - Reminder cycle resets when followUpDate is updated
//
// Requires: npm install node-cron (in server folder)

const cron              = require('node-cron')
const Quotation               = require('../models/Quotation')
const User              = require('../models/User')
const { sendReminderEmail } = require('./emailService')

const THREE_WEEKS_MS = 21 * 24 * 60 * 60 * 1000

// ── Run the reminder check ────────────────────
const runReminderCheck = async () => {
  console.log('[Reminder] Running daily follow-up check...')

  const now   = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()) // midnight today

  // 3-week cutoff — quotations older than this get no more reminders
  const cutoff = new Date(today.getTime() - THREE_WEEKS_MS)

  try {
    const overdue = await Quotation.find({
      status:      { $in: ['Sent', 'In Progress'] },
      followUpDate: {
        $lt:  today,   // due date has passed
        $gte: cutoff,  // but not more than 3 weeks ago
      },
    })

    console.log(`[Reminder] Found ${overdue.length} overdue quotation(s)`)

    for (const q of overdue) {
      // Skip if already sent today (remindersSent stores ISO date strings)
      const todayStr = today.toISOString().split('T')[0] // e.g. "2026-04-05"

      if (q.remindersSent && q.remindersSent.includes(todayStr)) {
        console.log(`[Reminder] Already sent today for ${q.quoteNumber} — skipping`)
        continue
      }

      // Get recipient — creatorEmail stored at creation time, fall back to user lookup
      let recipientEmail = q.creatorEmail || null

      if (!recipientEmail && q.createdBy) {
        try {
          const creator = await User.findById(q.createdBy).select('email').lean()
          recipientEmail = creator?.email || null
        } catch {
          console.warn(`[Reminder] Could not find user for quotation ${q.quoteNumber}`)
        }
      }

      if (!recipientEmail) {
        console.warn(`[Reminder] No recipient email for quotation ${q.quoteNumber} — skipping`)
        continue
      }

      const result = await sendReminderEmail({
        to:           recipientEmail,
        quoteNumber:  q.quoteNumber || '—',
        customerName: q.customer?.companyName || '—',
        followUpDate: q.followUpDate,
        quoteId:      q._id,
      })

      // Record send — prevents duplicate sends even if SMTP is not configured
      if (result.sent || result.reason === 'SMTP not configured') {
        await Quotation.findByIdAndUpdate(q._id, {
          $addToSet: { remindersSent: todayStr },
        })
      }
    }

    console.log('[Reminder] Daily check complete')
  } catch (err) {
    console.error('[Reminder] Error during reminder check:', err.message)
  }
}

// ── Start the cron job ────────────────────────
// Runs at 14:00 (2:00 PM) server time every day
// Cron format: second minute hour day month weekday
// '0 14 * * *' = at 14:00 every day
const startReminderJob = () => {
  console.log('[Reminder] Scheduling daily follow-up reminder job at 14:00')

  cron.schedule('0 14 * * *', () => {
    runReminderCheck()
  }, {
    timezone: 'Asia/Kolkata', // IST — change to your server timezone if needed
  })

  console.log('[Reminder] Reminder job scheduled ✅')
}

// Export both so index.js can start it and routes can trigger manual runs
module.exports = { startReminderJob, runReminderCheck }
