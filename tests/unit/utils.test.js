'use strict'

const test = require('brittle')
const {
  getUTCMidnightTimestampsLast2Years,
  getUTCMidnightTwoYearsAgo,
  getUTCMidnightToday
} = require('../../workers/lib/utils')

test('UTC midnight helpers return stable day boundaries', (t) => {
  const today = getUTCMidnightToday()
  const twoYearsAgo = getUTCMidnightTwoYearsAgo()
  const arr = getUTCMidnightTimestampsLast2Years()

  t.is(arr[0], twoYearsAgo)
  t.is(arr[arr.length - 1], today)
  t.ok(arr.length >= 730)
  t.is((today - twoYearsAgo) % (24 * 60 * 60 * 1000), 0)
})
