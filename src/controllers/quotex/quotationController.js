// quotationController.js — QuoteX quotation operations.
// Renamed from rfqController.js.
// Quote number format changed from PREFIX-YEAR-XXXX to QX-YEAR-XXXX.

const Quotation = require('../../models/Quotation')
const Customer  = require('../../models/Customer')

// ── Generate QuoteX quote number ──────────────
// Format: QX-YEAR-SEQUENCE e.g. QX-2026-0001
// QX prefix is fixed for QuoteX tool — consistent across all tenants.
// Sequence resets per tenant per year.

const generateQuoteNumber = async (tenantId, year, attempt) => {
  attempt = attempt || 0

  const count = await Quotation.countDocuments({
    tenantId,
    quoteNumber: { $regex: `^QX-${year}-` }
  })

  const sequence = count + 1 + attempt
  return `QX-${year}-${String(sequence).padStart(4, '0')}`
}

// ── FUNCTION 1 — Create a new Quotation ───────
const createQuotation = async (req, res) => {
  try {
    const {
      customer,
      parts,
      termsAndConditions,
      attachments,
      currency,
      currencySymbol,
    } = req.body

    const tenantId = req.user.tenantId

    if (!customer || !customer.companyName) {
      return res.status(400).json({ message: 'Customer details are required' })
    }
    if (!parts || parts.length === 0) {
      return res.status(400).json({ message: 'At least one part is required' })
    }

    const calculatedParts = parts.map(part => {
      const qty   = parseFloat(part.quantity)  || 0
      const price = parseFloat(part.unitPrice) || 0
      return {
        partNumber:     part.partNumber     || '',
        description:    part.description    || '',
        specifications: part.specifications || '',
        unit:           part.unit           || 'Pieces',
        quantity:       qty,
        unitPrice:      price,
        totalPrice:     parseFloat((qty * price).toFixed(2)),
        customFields:   part.customFields   || {},
      }
    })

    const grandTotal = calculatedParts.reduce(
      (sum, part) => sum + (part.totalPrice || 0), 0
    )

    const year = new Date().getFullYear()

    const defaultFollowUpDate = new Date()
    defaultFollowUpDate.setDate(defaultFollowUpDate.getDate() + 7)

    // Retry loop handles race condition on unique quoteNumber
    let newQuotation
    let lastError
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const quoteNumber = await generateQuoteNumber(tenantId, year, attempt)

        newQuotation = await Quotation.create({
          quoteNumber,
          customer,
          parts:              calculatedParts,
          grandTotal,
          currency:           currency           || 'USD',
          currencySymbol:     currencySymbol     || '$',
          termsAndConditions: termsAndConditions || 'Standard terms and conditions apply.',
          attachments:        attachments        || [],
          status:             'Draft',
          tenantId,
          createdBy:          req.user._id,
          creatorEmail:       req.user.email     || '',
          followUpDate:       defaultFollowUpDate,
        })
        break
      } catch (err) {
        if (err.code === 11000) { lastError = err; continue }
        throw err
      }
    }

    if (!newQuotation) {
      return res.status(409).json({
        message: 'Could not generate a unique quote number. Please try again.',
      })
    }

    // Auto-save customer to Customer Master
    if (customer.email) {
      await Customer.findOneAndUpdate(
        { email: customer.email, tenantId },
        {
          companyName: customer.companyName,
          contactName: customer.contactName || '',
          email:       customer.email,
          phone:       customer.phone       || '',
          address:     customer.address     || '',
          city:        customer.city        || '',
          country:     customer.country     || 'India',
          tenantId,
        },
        { upsert: true, new: true }
      )
    }

    res.status(201).json({
      message:   'Quotation created successfully',
      quotation: newQuotation,
      // Keep 'rfq' key for backwards compat with frontend success screen
    })

  } catch (error) {
    console.error('Create quotation error:', error)
    res.status(500).json({ message: 'Failed to create quotation', error: error.message })
  }
}

// ── FUNCTION 2 — Get all Quotations ───────────
const getAllQuotations = async (req, res) => {
  try {
    const tenantId = req.user.tenantId

    const quotations = await Quotation.find({ tenantId })
      .sort({ createdAt: -1 })
      .select('quoteNumber customer.companyName grandTotal status version createdAt')

    res.status(200).json({ total: quotations.length, quotations })

  } catch (error) {
    console.error('Get quotations error:', error)
    res.status(500).json({ message: 'Failed to fetch quotations', error: error.message })
  }
}

// ── FUNCTION 3 — Get single Quotation ─────────
const getQuotationById = async (req, res) => {
  try {
    const { id }   = req.params
    const tenantId = req.user.tenantId

    const quotation = await Quotation.findOne({ _id: id, tenantId })
    if (!quotation) {
      return res.status(404).json({ message: 'Quotation not found' })
    }

    res.status(200).json(quotation)

  } catch (error) {
    console.error('Get quotation error:', error)
    res.status(500).json({ message: 'Failed to fetch quotation', error: error.message })
  }
}

// ── FUNCTION 4 — Update Quotation status ──────
const updateQuotationStatus = async (req, res) => {
  try {
    const { id }   = req.params
    const tenantId = req.user.tenantId
    const { status, reasonForLoss, notes, followUpDate } = req.body

    const quotation = await Quotation.findOne({ _id: id, tenantId })
    if (!quotation) {
      return res.status(404).json({ message: 'Quotation not found' })
    }

    if (status === 'Not Awarded' && !reasonForLoss?.trim()) {
      return res.status(400).json({
        message: 'Reason for loss is required when marking as Not Awarded',
        field:   'reasonForLoss',
      })
    }

    let awardedAt = quotation.awardedAt
    if (status === 'Awarded' && !quotation.awardedAt) {
      awardedAt = new Date()
    }

    let newFollowUpDate = followUpDate || quotation.followUpDate
    if (status === 'Sent' && !quotation.followUpDate && !followUpDate) {
      const sevenDays = new Date()
      sevenDays.setDate(sevenDays.getDate() + 7)
      newFollowUpDate = sevenDays
    }

    // Clear remindersSent when user explicitly changes followUpDate
    const followUpDateChanged = followUpDate &&
      quotation.followUpDate?.toISOString().split('T')[0] !==
      new Date(followUpDate).toISOString().split('T')[0]

    const updated = await Quotation.findOneAndUpdate(
      { _id: id, tenantId },
      {
        $set: {
          status,
          reasonForLoss: reasonForLoss || '',
          notes:         notes         || quotation.notes,
          followUpDate:  newFollowUpDate,
          awardedAt,
          ...(followUpDateChanged ? { remindersSent: [] } : {}),
        },
      },
      { new: true }
    )

    res.status(200).json({ message: 'Quotation updated successfully', quotation: updated })

  } catch (error) {
    console.error('Update quotation error:', error)
    res.status(500).json({ message: 'Failed to update quotation', error: error.message })
  }
}

// ── FUNCTION 5 — Get tracker Quotations ───────
const getTrackerQuotations = async (req, res) => {
  try {
    const tenantId = req.user.tenantId
    const filter   = { tenantId }
    if (req.query.status) filter.status = req.query.status

    const allQuotations = await Quotation.find(filter)
      .sort({ createdAt: -1 })
      .select(
        'quoteNumber customer grandTotal currency currencySymbol ' +
        'status version followUpDate awardedAt originalQuoteId ' +
        'reasonForLoss notes createdAt'
      )

    const today     = new Date()
    const familyMap = {}

    allQuotations.forEach(q => {
      const qObj = q.toObject()

      qObj.isOverdue = (
        q.followUpDate &&
        new Date(q.followUpDate) < today &&
        ['Sent', 'In Progress'].includes(q.status)
      )

      const rootId = q.originalQuoteId
        ? q.originalQuoteId.toString()
        : q._id.toString()

      if (!familyMap[rootId]) {
        familyMap[rootId] = { latest: qObj, versions: [qObj] }
      } else {
        familyMap[rootId].versions.push(qObj)
        if (qObj.version > familyMap[rootId].latest.version) {
          familyMap[rootId].latest = qObj
        }
      }
    })

    const trackerRows = Object.values(familyMap).map(family => ({
      ...family.latest,
      allVersions:         family.versions.sort((a, b) => b.version - a.version),
      hasMultipleVersions: family.versions.length > 1,
    }))

    trackerRows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))

    res.status(200).json({ total: trackerRows.length, quotations: trackerRows })

  } catch (error) {
    console.error('Get tracker quotations error:', error)
    res.status(500).json({ message: 'Failed to fetch quotations', error: error.message })
  }
}

// ── FUNCTION 6 — Create new Quotation version ─
const createQuotationVersion = async (req, res) => {
  try {
    const { id }   = req.params
    const tenantId = req.user.tenantId

    const original = await Quotation.findOne({ _id: id, tenantId })
    if (!original) {
      return res.status(404).json({ message: 'Original quotation not found' })
    }

    if (!original.quoteNumber) {
      return res.status(400).json({
        message: 'Cannot version a quotation that has no quote number.',
      })
    }

    const rootId = original.originalQuoteId || original._id

    const latestVersion = await Quotation.findOne({
      tenantId,
      $or: [{ _id: rootId }, { originalQuoteId: rootId }],
    }).sort({ version: -1 })

    const nextVersion    = (latestVersion?.version || 1) + 1
    const baseNumber     = original.quoteNumber.replace(/-V\d+$/, '')
    const newQuoteNumber = `${baseNumber}-V${nextVersion}`

    const existing = await Quotation.findOne({ quoteNumber: newQuoteNumber, tenantId })
    if (existing) {
      return res.status(409).json({
        message: 'Version already exists. Please refresh and try again.',
      })
    }

    const newFollowUpDate = new Date()
    newFollowUpDate.setDate(newFollowUpDate.getDate() + 7)

    const submitted = req.body || {}

    let finalParts = original.parts
    let finalTotal = original.grandTotal

    if (submitted.parts?.length > 0) {
      finalParts = submitted.parts.map(part => {
        const qty   = parseFloat(part.quantity)  || 0
        const price = parseFloat(part.unitPrice) || 0
        return {
          partNumber:     part.partNumber     || '',
          description:    part.description    || '',
          specifications: part.specifications || '',
          unit:           part.unit           || 'Pieces',
          quantity:       qty,
          unitPrice:      price,
          totalPrice:     parseFloat((qty * price).toFixed(2)),
          customFields:   part.customFields   || {},
        }
      })
      finalTotal = finalParts.reduce((sum, p) => sum + (p.totalPrice || 0), 0)
    }

    const newVersion = await Quotation.create({
      customer:           submitted.customer           || original.customer,
      parts:              finalParts,
      grandTotal:         finalTotal,
      termsAndConditions: submitted.termsAndConditions || original.termsAndConditions,
      attachments:        original.attachments,
      currency:           submitted.currency           || original.currency,
      currencySymbol:     submitted.currencySymbol     || original.currencySymbol,
      quoteNumber:        newQuoteNumber,
      version:            nextVersion,
      status:             'Draft',
      originalQuoteId:    rootId,
      followUpDate:       newFollowUpDate,
      tenantId,
      createdBy:          req.user._id,
      creatorEmail:       req.user.email || '',
      awardedAt:          null,
      reasonForLoss:      '',
      notes:              '',
    })

    res.status(201).json({
      message:   `Version ${nextVersion} created successfully`,
      quotation: newVersion,
    })

  } catch (error) {
    console.error('Create version error:', error)
    res.status(500).json({ message: 'Failed to create new version', error: error.message })
  }
}

module.exports = {
  createQuotation,
  getAllQuotations,
  getQuotationById,
  updateQuotationStatus,
  getTrackerQuotations,
  createQuotationVersion,
}
