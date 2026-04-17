// Tenant.js — Master record for each client company.

const mongoose = require('mongoose')

const tenantSchema = new mongoose.Schema(
  {
    // ── Identity ──────────────────────────────
    tenantId: {
      type:      String,
      required:  true,
      trim:      true,
      lowercase: true,
    },

    companyName: {
      type:     String,
      required: true,
      trim:     true,
    },

    address: {
      type:    String,
      trim:    true,
      default: '',
    },

    gst: {
      type:    String,
      trim:    true,
      default: '',
    },

    // ── Status ────────────────────────────────
    // Defaults to TRUE — admin activates on creation
    isActive: {
      type:    Boolean,
      default: true,
    },

    // ── User limit ────────────────────────────
    maxUsers: {
      type:    Number,
      default: 5,
    },

    // ── Active Tools ──────────────────────────
    // Which tools this tenant has purchased.
    // Users can only be assigned tools from this list.
    activeTools: [
      {
        toolCode: { type: String, required: true, trim: true },
        isActive: { type: Boolean, default: true },
      }
    ],

    // ── Settings ──────────────────────────────
    defaultFollowUpDays: {
      type:    Number,
      default: 7,
    },

    defaultTerms: {
      type:    String,
      default: '',
    },

    // ── Templates stored as base64 ────────────
    // Excel parts template — uploaded by super admin
    // Stored as base64 string so no file system needed
    excelTemplate: {
      fileName:    { type: String, default: '' },
      fileBase64:  { type: String, default: '' }, // base64 encoded xlsx
      uploadedAt:  { type: Date,   default: null },
    },

    // Word quotation template — uploaded by super admin. Stored as base64.
    wordTemplate: {
      fileName:    { type: String, default: '' },
      fileBase64:  { type: String, default: '' }, // base64 encoded docx
      uploadedAt:  { type: Date,   default: null },
    },

    // ── PDF Branding ──────────────────────────
    pdfBranding: {
      type: Object,
      default: {
        companyName:    '',
        companyAddress: '',
        companyPhone:   '',
        companyEmail:   '',
        companyWebsite: '',
        primaryColor:   '#1a3c5e',
        footerNote:     'This is a computer generated quotation. No signature required.',
      },
    },

    // ── Company Logo ──────────────────────────
    // Stored as base64 — no file system needed.
    // Uploaded by super admin from admin panel.
    // Injected into PDF where {{COMPANY_LOGO}} appears in Word template.
    logo: {
      type: Object,
      default: {
        fileBase64: '',
        fileName:   '',
        mimeType:   '',
        uploadedAt: null,
      },
    },
    // ── Admin notes ───────────────────────────
    adminNotes: {
      type:    String,
      default: '',
    },

    // ── Usage stats ───────────────────────────
    stats: {
      type: Object,
      default: { totalQuotations: 0, totalUsers: 0, lastActiveAt: null },
    },
  },
  { timestamps: true }
)

// Indexes
tenantSchema.index({ tenantId: 1 }, { unique: true })

// Helper methods
tenantSchema.methods.isLicenceExpired = function () { return false }
tenantSchema.methods.daysUntilExpiry  = function () { return null  }

const Tenant = mongoose.model('Tenant', tenantSchema)
module.exports = Tenant