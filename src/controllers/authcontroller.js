// authController.js — Handles user registration and login.
// These are the two entry points to the entire authentication system.
// Register creates a new account.
// Login verifies credentials and returns a JWT token.

const jwt    = require('jsonwebtoken')
const User   = require('../models/User')
const Tool   = require('../models/Tool')
const Tenant = require('../models/Tenant')
const bcrypt = require('bcryptjs')
// ── Helper — Generate JWT Token ───────────────
// Creates a signed token containing the user's key details.
// Think of it like printing a temporary key card —
// it contains enough info to identify the user on every request
// without hitting the database each time.
//
// The token expires after 7 days — after that the user
// must log in again to get a fresh token.

const generateToken = (user) => {
  // Build the active tools list for the token
  const activeTools = user.getActiveTools ? user.getActiveTools() : ['quotex']

  // Build tool access summary for the token
  // We include enough info so frontend can check without DB calls
  const toolAccess = (user.toolAccess || []).map(t => ({
    toolCode:        t.toolCode,
    licence:         t.licence,
    isActive:        t.isActive,
    licenceExpiresAt: t.licenceExpiresAt,
  }))

  return jwt.sign(
    {
      userId:      user._id,
      email:       user.email,
      role:        user.role,
      licence:     user.licence, // kept for backwards compatibility
      tenantId:    user.tenantId || 'super_admin',
      activeTools, // list of tool codes this user can access
      toolAccess,  // full tool access details with licence per tool
    },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  )
}

// ── FUNCTION 1 — Register ─────────────────────
// Creates a brand new user account.
// The first user registered for a tenantId is automatically
// made an admin — so the first person to sign up becomes
// the administrator who can then invite others.

const register = async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      email,
      password,
      tenantId,
      role,
      licence,
    } = req.body

    // ── Validate required fields ───────────────
    if (!firstName || !lastName || !email || !password || !tenantId) {
      return res.status(400).json({
        message: 'First name, last name, email, password and company ID are required',
      })
    }

    // ── Check password length ──────────────────
    if (password.length < 6) {
      return res.status(400).json({
        message: 'Password must be at least 6 characters',
      })
    }

    // ── Check for duplicate email ──────────────
    // Two users cannot share the same email address
    const existingUser = await User.findOne({ email })
    if (existingUser) {
      return res.status(409).json({
        message: 'An account with this email already exists',
      })
    }

    // ── Check if this is the first user for this tenant ──
    // If no users exist yet for this tenantId,
    // make this user an admin automatically.
    // This means whoever registers first becomes the admin —
    // they can then set up roles for everyone else.
    const tenantUserCount = await User.countDocuments({ tenantId })
    const isFirstUser     = tenantUserCount === 0

    // ── Create the user ───────────────────────
    // Note: password hashing happens automatically
    // in the User model's pre('save') hook —
    // we just pass the plain text here
    const newUser = await User.create({
      firstName,
      lastName,
      email,
      password,   // Will be hashed automatically before saving
      tenantId,
      // First user gets admin + enterprise regardless of what was sent
      role:    isFirstUser ? 'admin'      : (role    || 'individual'),
      licence: isFirstUser ? 'enterprise' : (licence || 'basic'),
    })

    // ── Generate token ────────────────────────
    const token = generateToken(newUser)

    res.status(201).json({
      message: 'Account created successfully',
      token,
      user: newUser, // Password is auto-removed by toJSON() method
      isAdmin: isFirstUser, // Tell frontend if this is the first admin
    })

  } catch (error) {
    console.error('Register error:', error)
    res.status(500).json({
      message: 'Registration failed',
      error: error.message,
    })
  }
}

// ── FUNCTION 2 — Login ────────────────────────
// Verifies email and password.
// Returns a JWT token if credentials are correct.
// Returns a clear error message if they are not —
// without revealing whether the email or password
// specifically was wrong (security best practice).

const login = async (req, res) => {
  try {
    const { email, password } = req.body

    // ── Validate input ────────────────────────
    if (!email || !password) {
      return res.status(400).json({
        message: 'Email and password are required',
      })
    }

    // ── Find user by email ────────────────────
    // We need to explicitly select password here because
    // the toJSON method strips it — but we need it
    // to verify the login attempt
    const user = await User.findOne({ email }).select('+password')

    if (!user) {
      // Do not reveal that the email does not exist —
      // just say credentials are invalid
      return res.status(401).json({
        message: 'Invalid email or password',
      })
    }

    // ── Check account is active ───────────────
    if (!user.isActive) {
      return res.status(403).json({
        message: 'Your account has been deactivated. Please contact your administrator.',
      })
    }

    // ── Check tenant is active ────────────────
    // super_admin has no tenant record — skip check
    if (user.role !== 'super_admin') {
      const tenant = await Tenant.findOne({ tenantId: user.tenantId }).select('isActive companyName')
      if (!tenant || !tenant.isActive) {
        return res.status(403).json({
          message: 'Your organisation account is currently inactive. Please contact support.',
        })
      }
    }

    // ── Verify password ───────────────────────
    // comparePassword hashes what the user typed and
    // compares it to the stored hash
    const isPasswordCorrect = await user.comparePassword(password)

    if (!isPasswordCorrect) {
      return res.status(401).json({
        message: 'Invalid email or password',
      })
    }

    // ── Check licence expiry ──────────────────
    let licenceWarning = null
    if (user.licenceExpiresAt) {
      const daysUntilExpiry = Math.ceil(
        (new Date(user.licenceExpiresAt) - new Date()) / (1000 * 60 * 60 * 24)
      )
      if (daysUntilExpiry <= 0) {
        licenceWarning = 'Your licence has expired. You have basic access only.'
      } else if (daysUntilExpiry <= 30) {
        licenceWarning = `Your licence expires in ${daysUntilExpiry} days.`
      }
    }

    // ── Update last login timestamp ───────────
    await User.findByIdAndUpdate(user._id, {
      lastLoginAt: new Date(),
    })

    // ── Generate token ────────────────────────
    const token = generateToken(user)

    // Fetch all non-inactive tools for the launcher
      const allPlatformTools = await Tool
        .find({ status: { $ne: 'inactive' } })
        .sort({ sortOrder: 1, name: 1 })
        .lean()

      res.status(200).json({
        message:          'Login successful',
        token,
        user,
        licenceWarning,
        redirectTo:       user.role === 'super_admin' ? '/admin' : '/tool-launcher',
        activeTools:      user.getActiveTools ? user.getActiveTools() : ['quotex'],
        allPlatformTools,
      })

  } catch (error) {
    console.error('Login error:', error)
    res.status(500).json({
      message: 'Login failed',
      error: error.message,
    })
  }
}

// ── FUNCTION 3 — Get Current User ────────────
// Returns the logged-in user's profile.
// Used by the frontend to get fresh user data
// after a page refresh without requiring re-login.
// The user ID comes from the JWT token via auth middleware.

const getMe = async (req, res) => {
  try {
    // req.user is set by the auth middleware
    const user = await User.findById(req.user.userId)

    if (!user) {
      return res.status(404).json({ message: 'User not found' })
    }

    const allPlatformTools = await Tool
        .find({ status: { $ne: 'inactive' } })
        .sort({ sortOrder: 1, name: 1 })
        .lean()

      res.status(200).json({ user, allPlatformTools })

  } catch (error) {
    console.error('Get me error:', error)
    res.status(500).json({
      message: 'Failed to get user',
      error: error.message,
    })
  }
}
// ── FUNCTION 4 — Forgot Password ──────────────
// Generates a temporary password and returns it on screen.
// No email service needed — user shares it manually with admin
// or notes it down. Works for local/demo deployment.
// When email service is added later, this can be replaced
// with an email-based reset flow without changing the frontend.

const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body

    if (!email) {
      return res.status(400).json({ message: 'Email is required' })
    }

    const user = await User.findOne({ email: email.toLowerCase() })

    // Always return success even if email not found
    // This prevents email enumeration attacks
    // (an attacker cannot tell if an email exists)
    if (!user) {
      return res.status(200).json({
        message: 'If this email exists, a temporary password has been generated.',
        tempPassword: null,
        found: false,
      })
    }

    if (!user.isActive) {
      return res.status(403).json({
        message: 'This account has been deactivated. Contact your administrator.',
      })
    }

    // Generate a random 8-character temporary password
    // Mix of letters and numbers — easy to type, hard to guess
    const chars       = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
    const tempPassword = Array.from({ length: 8 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join('')

    // Hash and save
    const salt   = await bcrypt.genSalt(10)
    const hashed = await bcrypt.hash(tempPassword, salt)

    await User.findByIdAndUpdate(user._id, {
      $set: { password: hashed }
    })

    res.status(200).json({
      message:      'Temporary password generated successfully.',
      tempPassword, // Shown once — user must change after login
      found:        true,
      userName:     `${user.firstName} ${user.lastName}`,
      note:         'This temporary password will not be shown again. Please note it down or share it with the user securely.',
    })

  } catch (error) {
    console.error('Forgot password error:', error)
    res.status(500).json({ message: 'Failed to reset password', error: error.message })
  }
}

// ── FUNCTION 5 — Change Password ──────────────
// Allows a logged-in user to change their own password.
// Requires the current password for verification.

const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        message: 'Current password and new password are required',
      })
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        message: 'New password must be at least 6 characters',
      })
    }

    // req.user is set by protect middleware to the full DB user
    // Use _id from req.user — not req.user.userId
    // Use lean: false so we get the full mongoose document with methods
    const user = await User.findById(req.user._id)
    if (!user) {
      return res.status(404).json({ message: 'User not found' })
    }

    // Manually compare since toJSON strips password
    // Fetch raw password directly from DB
    const rawUser = await User.findById(req.user._id).select('+password').lean()
    const passwordToCheck = rawUser.password

    const isMatch = await bcrypt.compare(currentPassword, passwordToCheck)
    if (!isMatch) {
      return res.status(401).json({ message: 'Current password is incorrect' })
    }

    const salt   = await bcrypt.genSalt(10)
    const hashed = await bcrypt.hash(newPassword, salt)

    await User.findByIdAndUpdate(req.user._id, {
      $set: { password: hashed },
    })

    res.status(200).json({ message: 'Password changed successfully' })

  } catch (error) {
    console.error('Change password error:', error)
    res.status(500).json({ message: 'Failed to change password', error: error.message })
  }
}
module.exports = { register, login, getMe, forgotPassword, changePassword }