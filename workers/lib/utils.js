'use strict'

const { MS_24_HOURS } = require('./constants')

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

module.exports = {
  getUTCMidnightTimestampsSince,
  getUTCMidnightToday
}
