// emailService.js — Nodemailer transport configured for Outlook 365 SMTP.
// Used only for automated reminder emails (Feature 2).
// Feature 1 (Mail Quote button) is handled entirely on the frontend via .eml file.
//
// Setup: add to server/.env
//   SMTP_USER=yourname@yourcompany.com
//   SMTP_PASS=your-outlook-app-password
//
// In Outlook 365: Settings → Security → App Passwords → create one.
// Use that app password as SMTP_PASS (not your regular login password).

const nodemailer = require('nodemailer')

// ── Create transport ──────────────────────────
// Lazily created so server still boots if SMTP env vars are missing.
// All sends will fail gracefully with a logged error in that case.
let _transporter = null

const getTransporter = () => {
  if (_transporter) return _transporter

  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('[Email] SMTP_USER or SMTP_PASS not set — reminder emails disabled')
    return null
  }

  _transporter = nodemailer.createTransport({
    host:   'smtp.office365.com',
    port:   587,
    secure: false, // STARTTLS
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    tls: {
      ciphers: 'SSLv3',
    },
  })

  return _transporter
}

// ── Send a reminder email ─────────────────────
// Called by reminderJob.js once per overdue RFQ per day.
const sendReminderEmail = async ({ to, quoteNumber, customerName, followUpDate, quoteId }) => {
  const transporter = getTransporter()
  if (!transporter) {
    console.warn(`[Email] Skipping reminder for ${quoteNumber} — SMTP not configured`)
    return { sent: false, reason: 'SMTP not configured' }
  }

  const formattedDate = new Date(followUpDate).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
  })

  const subject = `Follow-up Reminder — Quotation ${quoteNumber}`

  const html = `
    <div style="font-family: Arial, sans-serif; font-size: 14px; color: #333; max-width: 600px;">
      <div style="background-color: #1a3c5e; padding: 16px 24px; border-radius: 6px 6px 0 0;">
        <h2 style="color: #fff; margin: 0; font-size: 18px;">Quotation Follow-up Reminder</h2>
      </div>
      <div style="padding: 24px; border: 1px solid #ddd; border-top: none; border-radius: 0 0 6px 6px;">
        <p>This is an automated reminder that the following quotation is overdue for follow-up:</p>
        <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
          <tr>
            <td style="padding: 8px 12px; background: #f0f4f8; font-weight: bold; width: 40%;">Quotation Number</td>
            <td style="padding: 8px 12px; border: 1px solid #ddd;">${quoteNumber}</td>
          </tr>
          <tr>
            <td style="padding: 8px 12px; background: #f0f4f8; font-weight: bold;">Customer</td>
            <td style="padding: 8px 12px; border: 1px solid #ddd;">${customerName}</td>
          </tr>
          <tr>
            <td style="padding: 8px 12px; background: #f0f4f8; font-weight: bold;">Follow-up Due</td>
            <td style="padding: 8px 12px; border: 1px solid #ddd; color: #c62828; font-weight: bold;">${formattedDate}</td>
          </tr>
        </table>
        <p>Please take one of the following actions:</p>
        <ul>
          <li>Contact the customer and update the quotation status</li>
          <li>Update the follow-up date if more time is needed</li>
          <li>Mark the quotation as Awarded or Not Awarded if concluded</li>
        </ul>
        <p style="color: #888; font-size: 12px; margin-top: 24px;">
          This is an automated message from your SourceHUB platform. Reminders stop automatically
          3 weeks after the follow-up date or when the quotation status is updated.
        </p>
      </div>
    </div>
  `

  try {
    await transporter.sendMail({
      from:    `"SourceHUB" <${process.env.SMTP_USER}>`,
      to,
      subject,
      html,
    })
    console.log(`[Email] Reminder sent → ${to} for Quotation ${quoteNumber}}`)
    return { sent: true }
  } catch (err) {
    console.error(`[Email] Failed to send reminder for ${quoteNumber}:`, err.message)
    return { sent: false, reason: err.message }
  }
}

module.exports = { sendReminderEmail }
