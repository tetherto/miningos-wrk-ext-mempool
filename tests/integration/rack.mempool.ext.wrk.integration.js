'use strict'

const test = require('brittle')
const WrkMempoolRack = require('../../workers/rack.mempool.ext.wrk')
const {
  STAT_HASHRATE_HISTORY,
  MEMPOOL_TAG,
  HISTORICAL_HASHRATE_DATA_KEY
} = require('../../workers/lib/constants')

test('saveHistoricalData runs all historical collectors in order', async (t) => {
  const wrk = Object.create(WrkMempoolRack.prototype)
  const calls = []

  wrk.saveHistoricalPrices = async () => { calls.push('prices') }
  wrk.saveHistoricalBlockSizes = async () => { calls.push('blocksizes') }
  wrk.saveHistoricalHashrates = async () => { calls.push('hashrates') }

  await wrk.saveHistoricalData()

  t.alike(calls, ['prices', 'blocksizes', 'hashrates'])
})

test('saveHistoricalData continues when one collector fails', async (t) => {
  const wrk = Object.create(WrkMempoolRack.prototype)
  const calls = []

  wrk.saveHistoricalPrices = async () => { calls.push('prices') }
  wrk.saveHistoricalBlockSizes = async () => {
    calls.push('blocksizes')
    throw new Error('boom')
  }
  wrk.saveHistoricalHashrates = async () => { calls.push('hashrates') }

  await wrk.saveHistoricalData()

  t.alike(calls, ['prices', 'blocksizes', 'hashrates'])
})

test('saveHistoricalHashrates uses hashrate history key and fetches latest bucket', async (t) => {
  const wrk = Object.create(WrkMempoolRack.prototype)
  const saved = []
  const dbKeys = []

  wrk.fetchingHistoricalHashrates = false
  wrk.mempoolApi = {
    getHashrate: async () => ({})
  }
  wrk._getDbData = async (key) => {
    dbKeys.push(key)
    return (new Array(726)).fill({})
  }
  wrk._fetchAndSaveHistoricalHashrates = async () => {}
  wrk._fetchWithDelay = async () => {
    return {
      hashrates: [
        { timestamp: 111, avgHashrate: 1 },
        { timestamp: 333, avgHashrate: 3 },
        { timestamp: 222, avgHashrate: 2 }
      ]
    }
  }
  wrk._saveHistoricalHashrate = async (obj) => { saved.push(obj) }

  await wrk.saveHistoricalHashrates()

  t.is(dbKeys.length, 1)
  t.is(dbKeys[0], `${STAT_HASHRATE_HISTORY}-${MEMPOOL_TAG}`)
  t.is(saved.length, 1)
  t.alike(saved[0], { timestamp: 333, avgHashrate: 3 })
})

test('getWrkExtData historical hashrate query returns db data', async (t) => {
  const wrk = Object.create(WrkMempoolRack.prototype)
  const expected = [{ ts: 1, avgHashrateMHs: 100 }]
  let keyUsed = null
  let queryUsed = null

  wrk._getDbData = async (key, query) => {
    keyUsed = key
    queryUsed = query
    return expected
  }

  const query = {
    key: HISTORICAL_HASHRATE_DATA_KEY,
    start: 1000,
    end: 2000
  }

  const result = await wrk.getWrkExtData({ query })

  t.is(keyUsed, `${STAT_HASHRATE_HISTORY}-${MEMPOOL_TAG}`)
  t.alike(queryUsed, query)
  t.alike(result, expected)
})
