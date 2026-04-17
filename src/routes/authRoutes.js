const express  = require('express')
const router   = express.Router()
const { protect } = require('../middleware/auth')
const { register, login, getMe, forgotPassword, changePassword } = require('../controllers/authController')

// Forgot password — generates temp password, returns it (no email service yet)
router.post('/forgot-password', forgotPassword)

// Change password — requires valid token (logged in user changing their own password)
router.post('/change-password', protect, changePassword)
router.post('/register', register)
router.post('/login',    login)

// /me requires a valid token — uses protect middleware
router.get('/me', protect, getMe)

module.exports = router