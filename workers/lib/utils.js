'use strict'

const { MS_24_HOURS, PRICE_BUCKET_MS } = require('./constants')

const getUTCMidnightToday = () => {
  const now = new Date()
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
}

const getUTCMidnightTimestampsSince = (startTs) => {
  const timestamps = []
  const end = getUTCMidnightToday()

  for (let ts = startTs; ts <= end; ts += MS_24_HOURS) {
    timestamps.push(ts)
  }

  return timestamps
}

// Floors rather than rounds: a rounded bucket can sit later than the payout it
// prices, and for a payout in the last couple of minutes that lands in the
// future, which no price source can answer. Flooring is never more than one
// bucket stale.
const priceBucket = (ts) => Math.floor(ts / PRICE_BUCKET_MS) * PRICE_BUCKET_MS

module.exports = {
  getUTCMidnightTimestampsSince,
  getUTCMidnightToday,
  priceBucket
}
