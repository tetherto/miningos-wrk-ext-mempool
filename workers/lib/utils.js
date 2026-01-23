'use strict'

const getUTCMidnightTimestampsLast2Years = () => {
  const timestamps = []
  const now = new Date()
  const end = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  ) // today at UTC midnight
  const start = Date.UTC(
    now.getUTCFullYear() - 2,
    now.getUTCMonth(),
    now.getUTCDate()
  ) // 2 years ago UTC midnight

  for (let ts = start; ts <= end; ts += 24 * 60 * 60 * 1000) {
    timestamps.push(ts)
  }

  return timestamps
}

const getUTCMidnightTwoYearsAgo = () => {
  const now = new Date()
  return Date.UTC(
    now.getUTCFullYear() - 2,
    now.getUTCMonth(),
    now.getUTCDate()
  )
}

const getUTCMidnightToday = () => {
  const now = new Date()
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
}

module.exports = {
  getUTCMidnightTimestampsLast2Years,
  getUTCMidnightTwoYearsAgo,
  getUTCMidnightToday
}
