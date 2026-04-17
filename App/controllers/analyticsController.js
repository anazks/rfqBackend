// analyticsController.js — Computes analytics data for the QuoteX dashboard.
// Queries the quotations collection and aggregates into summary cards and charts.

const Quotation = require('../models/Quotation')

const getAnalytics = async (req, res) => {
  try {
    const tenantId = req.user.tenantId

        const { from, to } = req.query
    const dateFilter = {}
    if (from) dateFilter.$gte = new Date(from)
    if (to)   dateFilter.$lte = new Date(to)

    const baseFilter = {
      tenantId,
      ...(from || to ? { createdAt: dateFilter } : {}),
    }

        const totalQuotations = await Quotation.countDocuments(baseFilter)

        const statusCounts = await Quotation.aggregate([
      { $match: baseFilter },
      {
        $group: {
          _id:   '$status',  // Group by status value
          count: { $sum: 1 }, // Count how many in each group
          totalValue: { $sum: '$grandTotal' }, // Sum of grand totals
        }
      }
    ])

    // Convert the aggregation result into a simple key-value object
        const statusMap = {}
    statusCounts.forEach(item => {
      statusMap[item._id] = {
        count: item.count,
        value: item.totalValue,
      }
    })

        const awarded    = statusMap['Awarded']?.count    || 0
    const notAwarded = statusMap['Not Awarded']?.count || 0
    const resolved   = awarded + notAwarded
    const winRate    = resolved > 0
      ? Math.round((awarded / resolved) * 100)
      : 0

        const pipelineValue =
      (statusMap['In Progress']?.value || 0) +
      (statusMap['Sent']?.value        || 0)

    // Data for the bar chart showing count per status
    // Ordered in a logical pipeline sequence
    const funnelData = [
      'Draft',
      'Sent',
      'In Progress',
      'Awarded',
      'Not Awarded',
    ].map(status => ({
      status,
      count: statusMap[status]?.count || 0,
      value: statusMap[status]?.value || 0,
    }))

    // Data for the line chart showing awards vs losses per month
    // Groups RFQs by year-month and counts wins and losses
    const monthlyData = await Quotation.aggregate([
      {
        $match: {
          ...baseFilter,
          status: { $in: ['Awarded', 'Not Awarded'] },
            }
      },
      {
        $group: {
          _id: {
            year:  { $year:  '$createdAt' },
            month: { $month: '$createdAt' },
          },
          awarded:    {
            $sum: { $cond: [{ $eq: ['$status', 'Awarded'] }, 1, 0] }
            },
          notAwarded: {
            $sum: { $cond: [{ $eq: ['$status', 'Not Awarded'] }, 1, 0] }
          },
          totalValue: {
            $sum: { $cond: [{ $eq: ['$status', 'Awarded'] }, '$grandTotal', 0] }
          },
        }
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
      { $limit: 12 },
    ])

    // Format monthly data for the chart
    const monthNames = [
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
    ]
    const monthlyChartData = monthlyData.map(item => ({
      month:      `${monthNames[item._id.month - 1]} ${item._id.year}`,
      awarded:    item.awarded,
      notAwarded: item.notAwarded,
      value:      item.totalValue,
    }))

    // Counts how many times each reason for loss appears
    // Sorted by frequency — most common reason first
    const lossReasons = await Quotation.aggregate([
      {
        $match: {
          ...baseFilter,
          status:        'Not Awarded',
          reasonForLoss: { $ne: '' },
        }
      },
      {
        $group: {
          _id:   '$reasonForLoss',
          count: { $sum: 1 },
        }
      },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ])

    // Calculate cumulative percentage for the Pareto line
    // Pareto principle: ~80% of losses come from 20% of reasons
    const totalLosses = lossReasons.reduce((sum, r) => sum + r.count, 0)
    let cumulative = 0
    const paretoData = lossReasons.map(reason => {
      cumulative += reason.count
      return {
        reason:           reason._id,
        count:            reason.count,
        cumulativePercent: totalLosses > 0
          ? Math.round((cumulative / totalLosses) * 100)
          : 0,
      }
    })

        res.status(200).json({
      summary: {
        totalQuotations,
        awarded,
        notAwarded,
        inProgress:     statusMap['In Progress']?.count || 0,
        sent:           statusMap['Sent']?.count        || 0,
        draft:          statusMap['Draft']?.count       || 0,
        winRate,
        pipelineValue,
        totalAwardedValue: statusMap['Awarded']?.value  || 0,
      },
      funnelData,
      monthlyChartData,
      paretoData,
    })

  } catch (error) {
    console.error('Analytics error:', error)
    res.status(500).json({ message: 'Failed to fetch analytics', error: error.message })
  }
}

module.exports = { getAnalytics }