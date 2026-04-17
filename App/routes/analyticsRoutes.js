const express  = require('express')
const router   = express.Router()
const { protect, requireFeature } = require('../middleware/auth')
const { getAnalytics } = require('../controllers/analyticsController')

// Analytics requires pro licence or above
router.get('/', protect, requireFeature('analytics'), getAnalytics)

module.exports = router