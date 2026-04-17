const { CORE_TOOL_CODE } = require('../config/platform')
const Tool              = require('../models/Tool')
// adminController.js — All super admin operations.

const bcrypt  = require('bcryptjs')
const User    = require('../models/User')
const Tenant  = require('../models/Tenant')
const Quotation = require('../models/Quotation')
const { TOOLS, ALL_TOOL_CODES, isValidTool, getToolFeatures } = require('../config/tools')

// ── HELPER — Calculate licence expiry ─────────
// Always sets expiry to the 1st of a month
const calculateExpiryDate = (startDate, validityMonths) => {
  const expiry = new Date(startDate)
  expiry.setMonth(expiry.getMonth() + parseInt(validityMonths))
  expiry.setDate(1)
  expiry.setHours(0, 0, 0, 0)
  return expiry
}

// ── FUNCTION 1 — Get all available tools ──────
const getTools = async (req, res) => {
  res.status(200).json({
    tools: Object.values(TOOLS).map(t => ({
      code: t.code, name: t.name,
      description: t.description, icon: t.icon,
    }))
  })
}

// ── FUNCTION 2 — Get admin dashboard stats ────
const getAdminStats = async (req, res) => {
  try {
    const allTenants    = await Tenant.find({})
    const totalTenants  = allTenants.length
    const activeTenants = allTenants.filter(t => t.isActive).length
    const totalUsers    = await User.countDocuments({ role: { $ne: 'super_admin' } })
    const activeUsers   = await User.countDocuments({
      role: { $ne: 'super_admin' }, isActive: true,
    })
    const totalQuotations = await Quotation.countDocuments({})

    const firstOfMonth = new Date()
    firstOfMonth.setDate(1)
    firstOfMonth.setHours(0, 0, 0, 0)
    const quotationsThisMonth = await Quotation.countDocuments({
      createdAt: { $gte: firstOfMonth },
    })

    const tenantBreakdown = await Promise.all(
      allTenants.map(async (tenant) => {
        const userCount = await User.countDocuments({
          tenantId: tenant.tenantId,
          role: { $ne: 'super_admin' },
        })
        const quoteCount = await Quotation.countDocuments({ tenantId: tenant.tenantId })
        const quotationsThisMonthForTenant = await Quotation.countDocuments({
          tenantId: tenant.tenantId,
          createdAt: { $gte: firstOfMonth },
        })
        const lastQuotation = await Quotation.findOne({ tenantId: tenant.tenantId })
          .sort({ createdAt: -1 }).select('createdAt')

        const toolSummary = (tenant.activeTools || []).map(t => ({
          toolCode: t.toolCode,
          name:     TOOLS[t.toolCode]?.name || t.toolCode,
          isActive: t.isActive,
        }))

        return {
          _id:           tenant._id,
          tenantId:      tenant.tenantId,
          companyName:   tenant.companyName,
          isActive:      tenant.isActive,
          userCount,
          maxUsers:      tenant.maxUsers,
          quoteCount,
          quotationsThisMonth: quotationsThisMonthForTenant,
          lastActivityAt: lastQuotation?.createdAt || null,
          activeTools:   toolSummary,
        }
      })
    )

    tenantBreakdown.sort((a, b) => b.quoteCount - a.quoteCount)

    res.status(200).json({
      summary: {
        totalTenants, activeTenants,
        totalUsers, activeUsers,
        totalQuotations, quotationsThisMonth,
      },
      tenants: tenantBreakdown,
    })
  } catch (error) {
    console.error('Admin stats error:', error)
    res.status(500).json({ message: 'Failed to fetch stats', error: error.message })
  }
}

// ── FUNCTION 3 — Get all tenants ──────────────
const getAllTenants = async (req, res) => {
  try {
    const tenants = await Tenant.find({}).sort({ createdAt: -1 })
    res.status(200).json({ total: tenants.length, tenants })
  } catch (error) {
    console.error('Get tenants error:', error)
    res.status(500).json({ message: 'Failed to fetch tenants', error: error.message })
  }
}

// ── FUNCTION 4 — Get single tenant ────────────
const getTenant = async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.params.id)
    if (!tenant) {
      return res.status(404).json({ message: 'Tenant not found' })
    }
    const users = await User.find({
      tenantId: tenant.tenantId,
      role:     { $ne: 'super_admin' },
    }).select('-password').sort({ createdAt: -1 })

    const quoteCount = await Quotation.countDocuments({ tenantId: tenant.tenantId })

    // Return tenant without base64 file data (too large for list views)
    const tenantObj = tenant.toObject()
    if (tenantObj.excelTemplate) tenantObj.excelTemplate.fileBase64 = tenantObj.excelTemplate.fileBase64 ? '[uploaded]' : ''
    if (tenantObj.wordTemplate)   tenantObj.wordTemplate.fileBase64   = tenantObj.wordTemplate.fileBase64   ? '[uploaded]' : ''

    res.status(200).json({ tenant: tenantObj, users, quoteCount })
  } catch (error) {
    console.error('Get tenant error:', error)
    res.status(500).json({ message: 'Failed to fetch tenant', error: error.message })
  }
}

// ── FUNCTION 5 — Create new tenant ────────────
const createTenant = async (req, res) => {
  try {
    const {
      tenantId, companyName, address, gst,
      maxUsers, activeTools, pdfBranding,
      defaultFollowUpDays, defaultTerms, adminNotes,
    } = req.body

    if (!tenantId || !companyName) {
      return res.status(400).json({
        message: 'Tenant ID and company name are required',
      })
    }

    const existing = await Tenant.findOne({ tenantId })
    if (existing) {
      return res.status(409).json({
        message: `Tenant ID "${tenantId}" is already taken`,
      })
    }

    const validatedTools = (activeTools || [])
      .filter(t => t.toolCode)  // keep any tool that has a code
      .map(t => ({ toolCode: t.toolCode, isActive: t.isActive !== false }))

    if (validatedTools.length === 0) {
      validatedTools.push({ toolCode: 'quotex', isActive: true })
    }

    const newTenant = await Tenant.create({
      tenantId:            tenantId.toLowerCase().trim(),
      companyName,
      address:             address             || '',
      gst:                 gst                 || '',
      maxUsers:            maxUsers            || 5,
      activeTools:         validatedTools,
      // NEW TENANTS DEFAULT TO ACTIVE
      isActive:            true,
      defaultFollowUpDays: defaultFollowUpDays || 7,
      defaultTerms:        defaultTerms        || '',
      adminNotes:          adminNotes          || '',
      pdfBranding: {
        companyName:    pdfBranding?.companyName    || companyName,
        companyAddress: pdfBranding?.companyAddress || address || '',
        companyPhone:   pdfBranding?.companyPhone   || '',
        companyEmail:   pdfBranding?.companyEmail   || '',
        companyWebsite: pdfBranding?.companyWebsite || '',
        logoUrl:        pdfBranding?.logoUrl        || '',
        primaryColor:   pdfBranding?.primaryColor   || '#1a3c5e',
        footerNote:     pdfBranding?.footerNote     ||
          'This is a computer generated quotation. No signature required.',
      },
    })

    res.status(201).json({
      message: 'Tenant created successfully',
      tenant:  newTenant,
    })
  } catch (error) {
    console.error('Create tenant error:', error)
    res.status(500).json({ message: 'Failed to create tenant', error: error.message })
  }
}

// ── FUNCTION 6 — Update tenant settings ───────
const updateTenant = async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.params.id)
    if (!tenant) {
      return res.status(404).json({ message: 'Tenant not found' })
    }

    const {
      companyName, address, gst, maxUsers,
      activeTools, isActive, pdfBranding,
      defaultFollowUpDays, defaultTerms, adminNotes,
    } = req.body

    // Validate activeTools if provided
    let validatedTools = tenant.activeTools
    if (activeTools) {
      validatedTools = activeTools
        .filter(t => t.toolCode)  // keep any tool that has a code
        .map(t => ({ toolCode: t.toolCode, isActive: t.isActive !== false }))
    }

    const updated = await Tenant.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          companyName:         companyName         || tenant.companyName,
          address:             address             !== undefined ? address : tenant.address,
          gst:                 gst                 !== undefined ? gst    : tenant.gst,
          maxUsers:            maxUsers            || tenant.maxUsers,
          activeTools:         validatedTools,
          isActive:            isActive            !== undefined ? isActive : tenant.isActive,
          defaultFollowUpDays: defaultFollowUpDays || tenant.defaultFollowUpDays,
          defaultTerms:        defaultTerms        !== undefined ? defaultTerms : tenant.defaultTerms,
          adminNotes:          adminNotes          !== undefined ? adminNotes  : tenant.adminNotes,
          pdfBranding:         pdfBranding         || tenant.pdfBranding,
        },
      },
      { returnDocument: 'after' }
    )

    res.status(200).json({
      message: 'Tenant updated successfully',
      tenant:  updated,
    })
  } catch (error) {
    console.error('Update tenant error:', error)
    res.status(500).json({ message: 'Failed to update tenant', error: error.message })
  }
}

// ── FUNCTION 7 — Toggle tenant active ─────────
const toggleTenant = async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.params.id)
    if (!tenant) {
      return res.status(404).json({ message: 'Tenant not found' })
    }

    const updated = await Tenant.findByIdAndUpdate(
      req.params.id,
      { $set: { isActive: !tenant.isActive } },
      { returnDocument: 'after' }
    )

    res.status(200).json({
      message: `Tenant ${updated.isActive ? 'activated' : 'deactivated'} successfully`,
      tenant:  updated,
    })
  } catch (error) {
    console.error('Toggle tenant error:', error)
    res.status(500).json({ message: 'Failed to toggle tenant', error: error.message })
  }
}

// ── FUNCTION 8 — Upload Excel template ────────
// Receives base64 encoded file, stores in Tenant document
const uploadExcelTemplate = async (req, res) => {
  try {
    const { fileName, fileBase64 } = req.body

    if (!fileName || !fileBase64) {
      return res.status(400).json({ message: 'fileName and fileBase64 are required' })
    }

    if (!fileName.endsWith('.xlsx') && !fileName.endsWith('.xls')) {
      return res.status(400).json({ message: 'Only .xlsx or .xls files allowed' })
    }

    const updated = await Tenant.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          'excelTemplate.fileName':   fileName,
          'excelTemplate.fileBase64': fileBase64,
          'excelTemplate.uploadedAt': new Date(),
        }
      },
      { returnDocument: 'after' }
    )

    if (!updated) {
      return res.status(404).json({ message: 'Tenant not found' })
    }

    res.status(200).json({
      message:  'Excel template uploaded successfully',
      fileName: updated.excelTemplate.fileName,
      uploadedAt: updated.excelTemplate.uploadedAt,
    })
  } catch (error) {
    console.error('Upload excel template error:', error)
    res.status(500).json({ message: 'Failed to upload template', error: error.message })
  }
}

// ── FUNCTION 9 — Upload RFQ Word template ─────
const uploadWordTemplate = async (req, res) => {
  try {
    const { fileName, fileBase64 } = req.body

    if (!fileName || !fileBase64) {
      return res.status(400).json({ message: 'fileName and fileBase64 are required' })
    }

    if (!fileName.endsWith('.docx') && !fileName.endsWith('.doc')) {
      return res.status(400).json({ message: 'Only .docx or .doc files allowed' })
    }

    const updated = await Tenant.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          'wordTemplate.fileName':   fileName,
          'wordTemplate.fileBase64': fileBase64,
          'wordTemplate.uploadedAt': new Date(),
        }
      },
      { returnDocument: 'after' }
    )

    if (!updated) {
      return res.status(404).json({ message: 'Tenant not found' })
    }

    res.status(200).json({
      message:  'Word template uploaded successfully',
      fileName: updated.wordTemplate.fileName,
      uploadedAt: updated.wordTemplate.uploadedAt,
    })
  } catch (error) {
    console.error('Upload Word template error:', error)
    res.status(500).json({ message: 'Failed to upload template', error: error.message })
  }
}

// ── FUNCTION 10 — Download Excel template ─────
const downloadExcelTemplate = async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.params.id).select('excelTemplate')
    if (!tenant || !tenant.excelTemplate?.fileBase64) {
      return res.status(404).json({ message: 'No Excel template uploaded for this tenant' })
    }

    const buffer = Buffer.from(tenant.excelTemplate.fileBase64, 'base64')
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${tenant.excelTemplate.fileName}"`)
    res.send(buffer)
  } catch (error) {
    console.error('Download excel template error:', error)
    res.status(500).json({ message: 'Failed to download template', error: error.message })
  }
}

// ── FUNCTION 11 — Download RFQ template ───────
const downloadWordTemplate = async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.params.id).select('wordTemplate')
    if (!tenant || !tenant.wordTemplate?.fileBase64) {
      return res.status(404).json({ message: 'No Word template uploaded for this tenant' })
    }

    const buffer = Buffer.from(tenant.wordTemplate.fileBase64, 'base64')
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    res.setHeader('Content-Disposition', `attachment; filename="${tenant.wordTemplate.fileName}"`)
    res.send(buffer)
  } catch (error) {
    console.error('Download Word template error:', error)
    res.status(500).json({ message: 'Failed to download template', error: error.message })
  }
}
// ── FUNCTION — Upload tenant logo ──────────────
const uploadLogo = async (req, res) => {
  try {
    const { fileName, fileBase64, mimeType } = req.body

    if (!fileName || !fileBase64) {
      return res.status(400).json({ message: 'fileName and fileBase64 are required' })
    }

    // Validate it is an image
    const validTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml', 'image/webp']
    const detectedType = mimeType || 'image/png'
    if (!validTypes.some(t => detectedType.includes(t.split('/')[1]))) {
      return res.status(400).json({ message: 'Only PNG, JPG, SVG or WebP images allowed' })
    }

    const updated = await Tenant.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          'logo.fileName':   fileName,
          'logo.fileBase64': fileBase64,
          'logo.mimeType':   detectedType,
          'logo.uploadedAt': new Date(),
        }
      },
      { returnDocument: 'after' }
    )

    if (!updated) {
      return res.status(404).json({ message: 'Tenant not found' })
    }

    res.status(200).json({
      message:    'Logo uploaded successfully',
      fileName:   updated.logo.fileName,
      uploadedAt: updated.logo.uploadedAt,
    })

  } catch (error) {
    console.error('Upload logo error:', error)
    res.status(500).json({ message: 'Failed to upload logo', error: error.message })
  }
}
// ── FUNCTION 12 — Create user ─────────────────
const createUser = async (req, res) => {
  try {
    const { tenantId, firstName, lastName, email, password, role, toolAccess } = req.body

    if (!tenantId || !firstName || !lastName || !email || !password) {
      return res.status(400).json({
        message: 'Tenant ID, name, email and password are required',
      })
    }

    const tenant = await Tenant.findOne({ tenantId })
    if (!tenant) {
      return res.status(404).json({ message: 'Tenant not found' })
    }

    // Block user creation if tenant is inactive
    if (!tenant.isActive) {
      return res.status(403).json({
        message: 'Cannot add users to an inactive tenant. Please activate the tenant first.',
      })
    }

    // Check user limit
    const currentCount = await User.countDocuments({
      tenantId, role: { $ne: 'super_admin' },
    })
    if (currentCount >= tenant.maxUsers) {
      return res.status(403).json({
        message: `Maximum user limit of ${tenant.maxUsers} reached for this tenant`,
      })
    }

    const existing = await User.findOne({ email })
    if (existing) {
      return res.status(409).json({ message: 'Email already in use' })
    }

    // Build toolAccess with per-tool expiry
    const tenantToolCodes = tenant.activeTools
      .filter(t => t.isActive)
      .map(t => t.toolCode)

    const validatedToolAccess = (toolAccess || [])
      .filter(t => t.toolCode && tenantToolCodes.includes(t.toolCode))
      .map(t => {
        const months = parseInt(t.validityMonths) || 12
        return {
          toolCode:         t.toolCode,
          licence:          t.licence || 'basic',
          licenceExpiresAt: calculateExpiryDate(new Date(), months),
          isActive:         true,
        }
      })

    // Default — assign all tenant tools with basic licence
    if (validatedToolAccess.length === 0) {
      tenantToolCodes.forEach(code => {
        validatedToolAccess.push({
          toolCode:         code,
          licence:          'basic',
          licenceExpiresAt: calculateExpiryDate(new Date(), 12),
          isActive:         true,
        })
      })
    }

    const quotexAccess  = validatedToolAccess.find(t => t.toolCode === 'quotex')
    const legacyLicence = quotexAccess?.licence || 'basic'

    const newUser = await User.create({
      firstName, lastName, email, password,
      role:       role || 'individual',
      licence:    legacyLicence,
      tenantId,
      toolAccess: validatedToolAccess,
      isActive:   true,
    })

    await Tenant.findOneAndUpdate(
      { tenantId },
      { $inc: { 'stats.totalUsers': 1 } }
    )

    res.status(201).json({ message: 'User created successfully', user: newUser })
  } catch (error) {
    console.error('Create user error:', error)
    res.status(500).json({ message: 'Failed to create user', error: error.message })
  }
}

// ── FUNCTION 13 — Get user ────────────────────
const getUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password')
    if (!user) return res.status(404).json({ message: 'User not found' })
    res.status(200).json({ user })
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch user', error: error.message })
  }
}

// ── FUNCTION 14 — Update user ─────────────────
const updateUser = async (req, res) => {
  try {
    const { firstName, lastName, role, toolAccess, isActive } = req.body
    const user = await User.findById(req.params.id)
    if (!user) return res.status(404).json({ message: 'User not found' })

    let updatedToolAccess = user.toolAccess
    if (toolAccess) {
      updatedToolAccess = toolAccess
        .filter(t => t.toolCode)
        .map(t => {
          const months = parseInt(t.validityMonths) || 12
          return {
            toolCode:         t.toolCode,
            licence:          t.licence   || 'basic',
            licenceExpiresAt: t.licenceExpiresAt
              ? new Date(t.licenceExpiresAt)
              : calculateExpiryDate(new Date(), months),
            isActive: t.isActive !== false,
          }
        })

      const quotexAccess = updatedToolAccess.find(t => t.toolCode === 'quotex')
      if (quotexAccess) {
        await User.findByIdAndUpdate(req.params.id, {
          $set: { licence: quotexAccess.licence }
        })
      }
    }

    const updated = await User.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          firstName:  firstName  || user.firstName,
          lastName:   lastName   || user.lastName,
          role:       role       || user.role,
          toolAccess: updatedToolAccess,
          isActive:   isActive   !== undefined ? isActive : user.isActive,
        },
      },
      { returnDocument: 'after', select: '-password' }
    )

    res.status(200).json({ message: 'User updated successfully', user: updated })
  } catch (error) {
    res.status(500).json({ message: 'Failed to update user', error: error.message })
  }
}

// ── FUNCTION 15 — Reset password ──────────────
const resetPassword = async (req, res) => {
  try {
    const { newPassword } = req.body
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters' })
    }
    const user = await User.findById(req.params.id)
    if (!user) return res.status(404).json({ message: 'User not found' })

    const salt   = await bcrypt.genSalt(10)
    const hashed = await bcrypt.hash(newPassword, salt)

    await User.findByIdAndUpdate(req.params.id, { $set: { password: hashed } })
    res.status(200).json({
      message: 'Password reset successfully',
      email:   user.email,
      note:    'Share the new password with the user securely.',
    })
  } catch (error) {
    res.status(500).json({ message: 'Failed to reset password', error: error.message })
  }
}

// ── FUNCTION 16 — Toggle user ─────────────────
const toggleUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
    if (!user) return res.status(404).json({ message: 'User not found' })
    if (user.role === 'super_admin') {
      return res.status(403).json({ message: 'Cannot deactivate the super admin account' })
    }
    const updated = await User.findByIdAndUpdate(
      req.params.id,
      { $set: { isActive: !user.isActive } },
      { returnDocument: 'after', select: '-password' }
    )
    res.status(200).json({
      message: `User ${updated.isActive ? 'activated' : 'deactivated'}`,
      user:    updated,
    })
  } catch (error) {
    res.status(500).json({ message: 'Failed to toggle user', error: error.message })
  }
}



// ── TOOL CRUD ─────────────────────────────────────────────────────────
// These functions manage the Tool collection in MongoDB.
// The Tool collection drives the launcher and tool assignments.
// tools.js (config) is separate — it defines feature tiers per tool code.

const getAllTools = async (req, res) => {
  try {
    const tools = await Tool.find().sort({ sortOrder: 1, name: 1 })
    res.status(200).json({ tools })
  } catch (error) {
    console.error('Get all tools error:', error)
    res.status(500).json({ message: 'Failed to fetch tools', error: error.message })
  }
}

const createTool = async (req, res) => {
  try {
    const { code, name, description, iconEmoji, route, status, sortOrder } = req.body
    if (!code || !name) {
      return res.status(400).json({ message: 'Tool code and name are required' })
    }
    const existing = await Tool.findOne({ code: code.toLowerCase().trim() })
    if (existing) {
      return res.status(409).json({ message: `Tool with code "${code}" already exists` })
    }
    const tool = await Tool.create({
      code:        code.toLowerCase().trim(),
      name:        name.trim(),
      description: description?.trim() || '',
      iconEmoji:   iconEmoji || '🔧',
      route:       route?.trim() || '',
      status:      status || 'active',
      sortOrder:   Number(sortOrder) || 99,
    })
    res.status(201).json({ message: 'Tool created', tool })
  } catch (error) {
    console.error('Create tool error:', error)
    res.status(500).json({ message: 'Failed to create tool', error: error.message })
  }
}

const updateTool = async (req, res) => {
  try {
    const { name, description, iconEmoji, route, status, sortOrder } = req.body
    const tool = await Tool.findByIdAndUpdate(
      req.params.id,
      { $set: {
        name:        name?.trim(),
        description: description?.trim() || '',
        iconEmoji:   iconEmoji || '🔧',
        route:       route?.trim() || '',
        status,
        sortOrder:   Number(sortOrder) || 99,
      }},
      { new: true }
    )
    if (!tool) return res.status(404).json({ message: 'Tool not found' })
    res.status(200).json({ message: 'Tool updated', tool })
  } catch (error) {
    console.error('Update tool error:', error)
    res.status(500).json({ message: 'Failed to update tool', error: error.message })
  }
}

const uploadToolIcon = async (req, res) => {
  try {
    const { fileBase64, mimeType, fileName } = req.body
    if (!fileBase64) return res.status(400).json({ message: 'No icon data provided' })
    const tool = await Tool.findByIdAndUpdate(
      req.params.id,
      { $set: { icon: { fileBase64, mimeType: mimeType || 'image/png', fileName: fileName || 'icon', uploadedAt: new Date() } } },
      { new: true }
    )
    if (!tool) return res.status(404).json({ message: 'Tool not found' })
    res.status(200).json({ message: 'Icon uploaded', tool })
  } catch (error) {
    console.error('Upload tool icon error:', error)
    res.status(500).json({ message: 'Failed to upload icon', error: error.message })
  }
}

const deleteTool = async (req, res) => {
  try {
    const tool = await Tool.findById(req.params.id)
    if (!tool) return res.status(404).json({ message: 'Tool not found' })
    if (tool.code === CORE_TOOL_CODE) {
      return res.status(403).json({ message: `Cannot delete the core platform tool (${tool.code})` })
    }
    await Tool.findByIdAndDelete(req.params.id)
    res.status(200).json({ message: 'Tool deleted' })
  } catch (error) {
    console.error('Delete tool error:', error)
    res.status(500).json({ message: 'Failed to delete tool', error: error.message })
  }
}

module.exports = {
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
  uploadLogo,           // ← add this
  createUser,
  getUser,
  updateUser,
  resetPassword,
  toggleUser,
}