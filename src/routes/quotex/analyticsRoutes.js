// analyticsRoutes.js — QuoteX analytics routes.
// Mounted at /api/quotex/analytics in index.js

const express  = require('express')
const router   = express.Router()
const { protect, requireFeature } = require('../../middleware/auth')
const { getAnalytics } = require('../../controllers/analyticsController')

// Analytics requires pro licence or above on the quotex tool
router.get('/', protect, requireFeature('quotex', 'analytics'), getAnalytics)

module.exports = router
