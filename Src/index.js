// index.js — SourceHUB API server entry point.
// Route structure:
//   /api/auth/*              — platform authentication
//   /api/admin/*             — platform administration (super admin)
//   /api/customers/*         — platform shared: customer master (all tools)
//   /api/parts/*             — platform shared: parts master (all tools)
//   /api/quotex/quotations/* — QuoteX tool: quotation documents
//   /api/quotex/pdf/*        — QuoteX tool: PDF generation
//   /api/quotex/analytics/*  — QuoteX tool: analytics dashboard
//
// Future tools follow same pattern:
//   /api/negohelp/*          — NegoHelp tool routes

const express  = require('express')
const mongoose = require('mongoose')
const cors     = require('cors')
const helmet   = require('helmet')
const rateLimit = require('express-rate-limit')
require('dotenv').config()

const app = express()

// ── Security Headers ──────────────────────────
app.use(helmet())

// ── Rate Limiting ─────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500, // Limit each IP to 500 requests per window
  message: 'Too many requests from this IP, please try again after 15 minutes',
  standardHeaders: true, 
  legacyHeaders: false,
})

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 30, // Limit each IP to 30 auth requests per 15 minutes
  message: 'Too many login attempts, please try again after 15 minutes',
  standardHeaders: true,
  legacyHeaders: false,
})

// Apply global rate limit to all api routes
app.use('/api', apiLimiter)

// Apply stricter limit to auth routes
app.use('/api/auth', authLimiter)

// ── CORS ──────────────────────────────────────
app.use(cors())

const ALLOWED_ORIGIN = process.env.FRONTEND_URL || 'http://localhost:5173'

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', ALLOWED_ORIGIN)
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS')
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  next()
})

// ── Body parsing ──────────────────────────────
// 25mb limit for base64 file uploads (logos, templates)
app.use(express.json({ limit: '25mb' }))
app.use(express.urlencoded({ extended: true, limit: '25mb' }))

// ── Platform-level routes ─────────────────────
const authRoutes     = require('./routes/authRoutes')
const adminRoutes    = require('./routes/adminRoutes')
const customerRoutes = require('./routes/customerRoutes')
const partRoutes     = require('./routes/partRoutes')

app.use('/api/auth',      authRoutes)
app.use('/api/admin',     adminRoutes)
app.use('/api/customers', customerRoutes)
app.use('/api/parts',     partRoutes)

// ── QuoteX tool routes ────────────────────────
const quotationRoutes = require('./routes/quotex/quotationRoutes')
const pdfRoutes       = require('./routes/quotex/pdfRoutes')
const analyticsRoutes = require('./routes/quotex/analyticsRoutes')

app.use('/api/quotex/quotations', quotationRoutes)
app.use('/api/quotex/pdf',        pdfRoutes)
app.use('/api/quotex/analytics',  analyticsRoutes)

// ── Future tool routes added here ────────────
// const negoRoutes = require('./src/routes/negohelp/negoRoutes')
// app.use('/api/negohelp', negoRoutes)

app.get('/', (req, res) => {
  res.send('SourceHUB API is running ✅')
})

// ── Connect to MongoDB then start server ──────
const PORT      = process.env.PORT      || 5000
const MONGO_URI = process.env.MONGO_URI

if (!MONGO_URI) {
  console.error('❌ MONGO_URI is not defined in .env file')
  process.exit(1)
}

mongoose.connect(MONGO_URI)
  .then(() => {
    const dbHost = mongoose.connection.host
    console.log(`✅ Connected to MongoDB Atlas (${dbHost})`)
    
    app.listen(PORT, () => {
      console.log(`✅ SourceHUB API running on http://localhost:${PORT}`)
    })

    // Start daily reminder email job (only when SMTP is configured)
    try {
      const { startReminderJob } = require('./jobs/reminderJob')
      startReminderJob()
    } catch (err) {
      console.warn('⚠️ Reminder job could not start:', err.message)
    }
  })
  .catch((err) => {
    console.error('❌ MongoDB connection failed:', err.message)
    console.error('Stack Trace:', err.stack)
  })
