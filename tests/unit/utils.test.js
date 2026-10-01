'use strict'

const test = require('brittle')
const {
  getUTCMidnightTimestampsSince,
  getUTCMidnightToday,
  priceBucket
} = require('../../workers/lib/utils')
const { MS_24_HOURS, HISTORICAL_DATA_START_TS, PRICE_BUCKET_MS } = require('../../workers/lib/constants')

test('UTC midnight helpers return stable day boundaries', (t) => {
  const today = getUTCMidnightToday()
  const arr = getUTCMidnightTimestampsSince(HISTORICAL_DATA_START_TS)

  t.is(arr[0], HISTORICAL_DATA_START_TS)
  t.is(arr[arr.length - 1], today)
  t.is(arr.length, ((today - HISTORICAL_DATA_START_TS) / MS_24_HOURS) + 1)
  t.is((today - HISTORICAL_DATA_START_TS) % MS_24_HOURS, 0)
})

test('priceBucket floors to the bucket at or before the timestamp', (t) => {
  const base = Date.UTC(2026, 4, 28, 16, 45)

  t.is(priceBucket(base), base, 'an exact boundary is its own bucket')
  t.is(priceBucket(base + 1), base)
  t.is(priceBucket(base + PRICE_BUCKET_MS - 1), base, 'never rounds up into a later bucket')
  t.is(priceBucket(base + PRICE_BUCKET_MS), base + PRICE_BUCKET_MS)
})

test('UTC midnight is always an exact price bucket', (t) => {
  // Why the daily price store can seed the 5m store for free.
  t.is(priceBucket(getUTCMidnightToday()), getUTCMidnightToday())
  t.is(priceBucket(HISTORICAL_DATA_START_TS), HISTORICAL_DATA_START_TS)
})
