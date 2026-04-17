// adminRoutes.js — All super admin API routes.

const express = require('express')
const router  = express.Router()
const { protect, requireSuperAdmin } = require('../middleware/auth')
const {
  getTools,
  getAllTools,
  createTool,
  updateTool,
  uploadToolIcon,
  deleteTool,
  getAdminStats,
  getAllTenants,
  getTenant,
  createTenant,
  updateTenant,
  toggleTenant,
  uploadExcelTemplate,
  uploadWordTemplate,
  downloadExcelTemplate,
  downloadWordTemplate,
  uploadLogo,
  createUser,
  getUser,
  updateUser,
  resetPassword,
  toggleUser,
} = require('../controllers/adminController')

// Apply auth to all admin routes
router.use(protect)
router.use(requireSuperAdmin)

// ── Tools ─────────────────────────────────────────────────────────────
router.get('/tools',             getAllTools)    // all tools from MongoDB (launcher + admin)
router.get('/tools/config',      getTools)       // feature definitions from config/tools.js
router.post('/tools',            createTool)
router.put('/tools/:id',         updateTool)
router.post('/tools/:id/icon',   uploadToolIcon)
router.delete('/tools/:id',      deleteTool)

// ── Stats ─────────────────────────────────────────────────────────────
router.get('/stats', getAdminStats)

// ── Tenants ───────────────────────────────────────────────────────────
router.get('/tenants',                          getAllTenants)
router.post('/tenants',                         createTenant)
router.get('/tenants/:id',                      getTenant)
router.put('/tenants/:id',                      updateTenant)
router.patch('/tenants/:id/toggle',             toggleTenant)
router.post('/tenants/:id/logo',                uploadLogo)
router.post('/tenants/:id/excel-template',      uploadExcelTemplate)
router.post('/tenants/:id/word-template',       uploadWordTemplate)
router.get('/tenants/:id/excel-template',       downloadExcelTemplate)
router.get('/tenants/:id/word-template',        downloadWordTemplate)

// ── Users ─────────────────────────────────────────────────────────────
router.post('/users',                           createUser)
router.get('/users/:id',                        getUser)
router.put('/users/:id',                        updateUser)
router.patch('/users/:id/password',             resetPassword)
router.patch('/users/:id/toggle',               toggleUser)

module.exports = router
