'use strict'

const test = require('brittle')
const {
  getUTCMidnightTimestampsSince,
  getUTCMidnightToday
} = require('../../workers/lib/utils')
const { MS_24_HOURS, HISTORICAL_DATA_START_TS } = require('../../workers/lib/constants')

test('UTC midnight helpers return stable day boundaries', (t) => {
  const today = getUTCMidnightToday()
  const arr = getUTCMidnightTimestampsSince(HISTORICAL_DATA_START_TS)

  t.is(arr[0], HISTORICAL_DATA_START_TS)
  t.is(arr[arr.length - 1], today)
  t.is(arr.length, ((today - HISTORICAL_DATA_START_TS) / MS_24_HOURS) + 1)
  t.is((today - HISTORICAL_DATA_START_TS) % MS_24_HOURS, 0)
})
