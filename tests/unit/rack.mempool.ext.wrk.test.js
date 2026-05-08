'use strict'

const test = require('brittle')
const WrkMempoolRack = require('../../workers/rack.mempool.ext.wrk')
const {
  BTC_SATS,
  REWARD_AVG_TIMES,
  MS_24_HOURS,
  STAT_HASHRATE_HISTORY,
  STAT_BLOCKSIZES,
  STAT_PRICES,
  MEMPOOL_TAG,
  HISTORICAL_PRICES_DATA_KEY,
  HISTORICAL_BLOCKSIZES_DATA_KEY,
  HISTORICAL_HASHRATE_DATA_KEY
} = require('../../workers/lib/constants')

test('_saveHistoricalHashrate stores ts in ms and MH/s conversion', async (t) => {
  const wrk = Object.create(WrkMempoolRack.prototype)
  const calls = []

  wrk._saveToDbKey = async (key, ts, data) => {
    calls.push({ key, ts, data })
  }

  await wrk._saveHistoricalHashrate({
    timestamp: 1710000000,
    avgHashrate: 9876543210
  })

  t.is(calls.length, 1)
  t.alike(calls[0], {
    key: `${STAT_HASHRATE_HISTORY}-${MEMPOOL_TAG}`,
    ts: 1710000000000,
    data: {
      ts: 1710000000000,
      avgHashrateMHs: 9876.54321
    }
  })
})

test('_getHistoricalExtDataLogKey resolves all historical keys', (t) => {
  const wrk = Object.create(WrkMempoolRack.prototype)

  t.is(wrk._getHistoricalExtDataLogKey(HISTORICAL_BLOCKSIZES_DATA_KEY), STAT_BLOCKSIZES)
  t.is(wrk._getHistoricalExtDataLogKey(HISTORICAL_HASHRATE_DATA_KEY), STAT_HASHRATE_HISTORY)
  t.is(wrk._getHistoricalExtDataLogKey(HISTORICAL_PRICES_DATA_KEY), STAT_PRICES)
})

test('getWrkExtData routes historical requests to db key', async (t) => {
  const wrk = Object.create(WrkMempoolRack.prototype)
  const result = [{ ts: 1, priceUSD: 1 }]
  let capturedKey = null
  let capturedQuery = null

  wrk._getDbData = async (key, query) => {
    capturedKey = key
    capturedQuery = query
    return result
  }

  const args = {
    query: {
      key: HISTORICAL_PRICES_DATA_KEY,
      start: 1,
      end: 2
    }
  }

  const res = await wrk.getWrkExtData(args)

  t.is(capturedKey, `${STAT_PRICES}-${MEMPOOL_TAG}`)
  t.alike(capturedQuery, args.query)
  t.alike(res, result)
})

test('getWrkExtData returns projected non-historical data', async (t) => {
  const wrk = Object.create(WrkMempoolRack.prototype)
  wrk.mempoolData = {
    prices: [{ time: 1, price: 100 }],
    currentPrice: 110,
    blockHeight: 123,
    adjustments: { avgBlockTime: 10 },
    transactionFees: { fastest: 1 }
  }

  const res = await wrk.getWrkExtData({
    fields: { blockHeight: 1, currentPrice: 1 }
  })

  t.alike(res, {
    blockHeight: 123,
    currentPrice: 110
  })
})

test('saveHistoricalHashrates backfills when db has less than 726 entries', async (t) => {
  const wrk = Object.create(WrkMempoolRack.prototype)
  let fetchAndSaveCalls = 0
  let getHashrateCalls = 0

  wrk.fetchingHistoricalHashrates = false
  wrk.mempoolApi = {
    getHashrate: async () => ({})
  }
  wrk._getDbData = async () => (new Array(725)).fill({})
  wrk._fetchAndSaveHistoricalHashrates = async () => { fetchAndSaveCalls++ }
  wrk._fetchWithDelay = async () => {
    getHashrateCalls++
    return { hashrates: [] }
  }
  wrk._saveHistoricalHashrate = async () => {}

  await wrk.saveHistoricalHashrates()

  t.is(fetchAndSaveCalls, 1)
  t.is(getHashrateCalls, 0)
  t.is(wrk.fetchingHistoricalHashrates, false)
})

test('saveHistoricalHashrates stores only latest point when db has 726+ entries', async (t) => {
  const wrk = Object.create(WrkMempoolRack.prototype)
  let fetchAndSaveCalls = 0
  let fetchWithDelayCalls = 0
  const saved = []

  wrk.fetchingHistoricalHashrates = false
  wrk.mempoolApi = {
    getHashrate: async () => ({})
  }
  wrk._getDbData = async () => (new Array(726)).fill({})
  wrk._fetchAndSaveHistoricalHashrates = async () => { fetchAndSaveCalls++ }
  wrk._fetchWithDelay = async (fn, obj, range) => {
    fetchWithDelayCalls++
    t.is(fn, wrk.mempoolApi.getHashrate)
    t.is(obj, wrk.mempoolApi)
    t.is(range, '3d')
    return {
      hashrates: [
        { timestamp: 100, avgHashrate: 1 },
        { timestamp: 300, avgHashrate: 3 },
        { timestamp: 200, avgHashrate: 2 }
      ]
    }
  }
  wrk._saveHistoricalHashrate = async (obj) => { saved.push(obj) }

  await wrk.saveHistoricalHashrates()

  t.is(fetchAndSaveCalls, 0)
  t.is(fetchWithDelayCalls, 1)
  t.is(saved.length, 1)
  t.alike(saved[0], { timestamp: 300, avgHashrate: 3 })
  t.is(wrk.fetchingHistoricalHashrates, false)
})

test('_savePrices updates current price, history and 24hr change', (t) => {
  const wrk = Object.create(WrkMempoolRack.prototype)
  const now = Date.now()
  wrk.mempoolData = {
    prices: [{ time: now - MS_24_HOURS - 1000, price: 80 }, { time: now - 1000, price: 90 }],
    currentPrice: 0,
    priceChange24Hrs: 0
  }

  const realNow = Date.now
  Date.now = () => now
  wrk._savePrices({ USD: 100 })
  Date.now = realNow

  t.is(wrk.mempoolData.currentPrice, 100)
  t.is(wrk.mempoolData.prices.length, 2)
  t.is(wrk.mempoolData.prices[0].price, 90)
  t.is(wrk.mempoolData.priceChange24Hrs, 0)
})

test('_priceChange24Hours returns percentage when 24h price exists', (t) => {
  const wrk = Object.create(WrkMempoolRack.prototype)
  const now = Date.now()
  wrk.mempoolData = {
    prices: [{ time: now - MS_24_HOURS - 1000, price: 80 }, { time: now - 10, price: 100 }],
    currentPrice: 100
  }

  const realNow = Date.now
  Date.now = () => now
  const pct = wrk._priceChange24Hours()
  Date.now = realNow

  t.is(pct, 25)
})

test('_saveAdjustments maps fields and normalizes avg block time', (t) => {
  const wrk = Object.create(WrkMempoolRack.prototype)
  wrk.mempoolData = {}
  wrk._saveAdjustments({
    progressPercent: 20,
    estimatedRetargetDate: 123,
    difficultyChange: 3.5,
    previousRetarget: -1.2,
    timeAvg: 600000
  })
  t.alike(wrk.mempoolData.adjustments, {
    progressToDifficulty: 20,
    nextAdjustmentTs: 123,
    nextAdjustmentExp: 3.5,
    prevAdjustment: -1.2,
    avgBlockTime: 10
  })
})

test('_calculateRewardAvgs computes averages by range', (t) => {
  const wrk = Object.create(WrkMempoolRack.prototype)
  wrk.mempoolData = { blockRewardAvgs: {} }
  const nowSec = Math.floor(Date.now() / 1000)
  const rewards = [
    { timestamp: nowSec - Math.floor((REWARD_AVG_TIMES['24h'] + 1000) / 1000), avgRewards: BTC_SATS * 2 },
    { timestamp: nowSec - Math.floor((REWARD_AVG_TIMES['24h'] + 2000) / 1000), avgRewards: BTC_SATS * 4 }
  ]
  wrk._calculateRewardAvgs(rewards)
  t.is(wrk.mempoolData.blockRewardAvgs['24h'], 3)
})

test('_saveTransactionFees maps recommended fee values', (t) => {
  const wrk = Object.create(WrkMempoolRack.prototype)
  wrk.mempoolData = {}
  wrk._saveTransactionFees({ fastestFee: 7, halfHourFee: 5, hourFee: 3 })
  t.alike(wrk.mempoolData.transactionFees, { fastest: 7, halfHour: 5, hour: 3 })
})

test('getThingType and getThingTags return mempool metadata', (t) => {
  const wrk = Object.create(WrkMempoolRack.prototype)
  t.is(wrk.getThingType(), 'mempool')
  t.alike(wrk.getThingTags(), ['mempool'])
})

test('_fetchWithDelay returns fn result and handles errors', async (t) => {
  const wrk = Object.create(WrkMempoolRack.prototype)
  const ok = await wrk._fetchWithDelay(async function (x) { return x + 1 }, null, 4)
  t.is(ok, 5)

  const fail = await wrk._fetchWithDelay(async () => { throw new Error('x') }, null)
  t.is(fail, null)
})

test('_saveToDb and _readFromDb persist mempool payload', async (t) => {
  const wrk = Object.create(WrkMempoolRack.prototype)
  let stored = null
  wrk.mempoolDb = {
    put: async (k, v) => { stored = { k, v } },
    get: async () => ({ value: stored.v })
  }

  await wrk._saveToDb({ a: 1 })
  const out = await wrk._readFromDb()

  t.is(stored.k, 'mempool')
  t.alike(out, { a: 1 })
})

test('_saveToDbKey, _getDbData and _getBee use bee db correctly', async (t) => {
  const wrk = Object.create(WrkMempoolRack.prototype)
  const putCalls = []
  let closed = 0

  const fakeDb = {
    ready: async () => {},
    put: async (k, v) => { putCalls.push({ k, v }) },
    close: async () => { closed++ },
    createReadStream: async function * () {
      yield { value: Buffer.from(JSON.stringify({ x: 1 })) }
      yield { value: Buffer.from(JSON.stringify({ x: 2 })) }
    }
  }
  wrk.store_s1 = {
    getBee: async () => fakeDb
  }

  await wrk._saveToDbKey('k1', 1, { y: 1 })
  const rows = await wrk._getDbData('k1', { start: 1, end: 3, limit: 2 })
  const bee = await wrk._getBee('k1')

  t.is(putCalls.length, 1)
  t.alike(rows, [{ x: 1 }, { x: 2 }])
  t.ok(bee)
  t.is(closed, 2)
})

test('fetchMempoolData populates state and saves payload', async (t) => {
  const wrk = Object.create(WrkMempoolRack.prototype)
  let saved = null

  wrk.fetchingData = false
  wrk.mempoolData = {
    prices: [],
    currentPrice: 0,
    priceChange24Hrs: 0,
    blockHeight: 0,
    adjustments: {},
    currentHashrate: 0,
    currentDifficulty: 0,
    blockRewardAvgs: {},
    transactionFees: {}
  }
  wrk.mempoolApi = {
    getPrices: async () => ({}),
    getBlockHeight: async () => 100,
    getAdjustments: async () => ({}),
    getHashrate: async () => ({}),
    getBlockRewards: async () => ([]),
    getTransactionFees: async () => ({})
  }
  wrk._fetchWithDelay = async (fn) => {
    if (fn === wrk.mempoolApi.getPrices) return { USD: 50 }
    if (fn === wrk.mempoolApi.getBlockHeight) return 100
    if (fn === wrk.mempoolApi.getAdjustments) {
      return {
        progressPercent: 10,
        estimatedRetargetDate: 22,
        difficultyChange: 1.1,
        previousRetarget: 0.9,
        timeAvg: 600000
      }
    }
    if (fn === wrk.mempoolApi.getHashrate) return { currentHashrate: 7, currentDifficulty: 8 }
    if (fn === wrk.mempoolApi.getBlockRewards) return [{ timestamp: 1, avgRewards: BTC_SATS }]
    if (fn === wrk.mempoolApi.getTransactionFees) return { fastestFee: 1, halfHourFee: 2, hourFee: 3 }
    return null
  }
  wrk._saveToDb = async (data) => { saved = data }

  await wrk.fetchMempoolData()

  t.is(wrk.mempoolData.blockHeight, 100)
  t.is(wrk.mempoolData.currentPrice, 50)
  t.is(wrk.mempoolData.currentHashrate, 7)
  t.is(wrk.mempoolData.currentDifficulty, 8)
  t.alike(wrk.mempoolData.transactionFees, { fastest: 1, halfHour: 2, hour: 3 })
  t.alike(saved, wrk.mempoolData)
  t.is(wrk.fetchingData, false)
})

test('fetchMempoolData returns immediately when already fetching', async (t) => {
  const wrk = Object.create(WrkMempoolRack.prototype)
  wrk.fetchingData = true
  let called = false
  wrk._saveToDb = async () => { called = true }
  await wrk.fetchMempoolData()
  t.is(called, false)
  t.is(wrk.fetchingData, true)
})

test('_fetchAndSaveHistoricalPrice saves only when api provides USD', async (t) => {
  const wrk = Object.create(WrkMempoolRack.prototype)
  const saved = []
  wrk.mempoolApi = { getHistoricalPrices: async () => ({}) }
  wrk._fetchWithDelay = async () => ({ prices: [{ USD: 123 }] })
  wrk._saveToDbKey = async (key, ts, data) => { saved.push({ key, ts, data }) }

  await wrk._fetchAndSaveHistoricalPrice(2000)

  t.is(saved.length, 1)
  t.is(saved[0].ts, 2000)
  t.is(saved[0].data.priceUSD, 123)
})

test('_fetchAndSaveHistoricalHashrates saves each returned point', async (t) => {
  const wrk = Object.create(WrkMempoolRack.prototype)
  const seen = []
  wrk.mempoolApi = { getHashrate: async () => ({}) }
  wrk._fetchWithDelay = async () => ({ hashrates: [{ timestamp: 1, avgHashrate: 10 }, { timestamp: 2, avgHashrate: 20 }] })
  wrk._saveHistoricalHashrate = async (row) => { seen.push(row) }

  await wrk._fetchAndSaveHistoricalHashrates()

  t.alike(seen, [{ timestamp: 1, avgHashrate: 10 }, { timestamp: 2, avgHashrate: 20 }])
})

test('_fetchAndSaveHistoricalBlockSize saves block size and reward fields', async (t) => {
  const wrk = Object.create(WrkMempoolRack.prototype)
  const saved = []
  wrk.mempoolApi = {
    getBlockByTimestamp: async () => ({}),
    getBlock: async () => ({})
  }
  wrk._fetchWithDelay = async (fn, obj, arg) => {
    if (fn === wrk.mempoolApi.getBlockByTimestamp) {
      t.is(arg, 2)
      return { hash: 'abc' }
    }
    if (fn === wrk.mempoolApi.getBlock) {
      t.is(arg, 'abc')
      return { size: 10, extras: { reward: 20, totalFees: 30 } }
    }
    return null
  }
  wrk._saveToDbKey = async (key, ts, data) => { saved.push({ key, ts, data }) }

  await wrk._fetchAndSaveHistoricalBlockSize(2000)

  t.is(saved.length, 1)
  t.is(saved[0].data.blockSize, 10)
  t.is(saved[0].data.blockReward, 20)
  t.is(saved[0].data.blockTotalFees, 30)
})

test('saveHistoricalPrices fetches only latest when db already seeded', async (t) => {
  const wrk = Object.create(WrkMempoolRack.prototype)
  const calls = []
  wrk.fetchingHistoricalPricesData = false
  wrk._getDbData = async () => (new Array(726)).fill({})
  wrk._fetchAndSaveHistoricalPrice = async (ts) => { calls.push(ts) }

  await wrk.saveHistoricalPrices()

  t.is(calls.length, 1)
  t.is(wrk.fetchingHistoricalPricesData, false)
})

test('saveHistoricalBlockSizes fetches only latest when db already seeded', async (t) => {
  const wrk = Object.create(WrkMempoolRack.prototype)
  const calls = []
  wrk.fetchingHistoricalBlocksData = false
  wrk._getDbData = async () => (new Array(726)).fill({})
  wrk._fetchAndSaveHistoricalBlockSize = async (ts) => { calls.push(ts) }

  await wrk.saveHistoricalBlockSizes()

  t.is(calls.length, 1)
  t.is(wrk.fetchingHistoricalBlocksData, false)
})

test('saveHistoricalBlockSizes and saveHistoricalPrices return if already running', async (t) => {
  const wrk = Object.create(WrkMempoolRack.prototype)
  wrk.fetchingHistoricalBlocksData = true
  wrk.fetchingHistoricalPricesData = true
  let blockCalls = 0
  let priceCalls = 0
  wrk._fetchAndSaveHistoricalBlockSize = async () => { blockCalls++ }
  wrk._fetchAndSaveHistoricalPrice = async () => { priceCalls++ }

  await wrk.saveHistoricalBlockSizes()
  await wrk.saveHistoricalPrices()

  t.is(blockCalls, 0)
  t.is(priceCalls, 0)
})

test('saveHistoricalData catches and continues for all three failures', async (t) => {
  const wrk = Object.create(WrkMempoolRack.prototype)
  let runs = 0
  wrk.saveHistoricalPrices = async () => { runs++; throw new Error('p') }
  wrk.saveHistoricalBlockSizes = async () => { runs++; throw new Error('b') }
  wrk.saveHistoricalHashrates = async () => { runs++; throw new Error('h') }

  await wrk.saveHistoricalData()
  t.is(runs, 3)
})

test('getWrkExtData returns full non-historical payload when no fields', async (t) => {
  const wrk = Object.create(WrkMempoolRack.prototype)
  wrk.mempoolData = {
    prices: [{ time: 1, price: 10 }],
    currentPrice: 10,
    blockHeight: 1
  }

  const out = await wrk.getWrkExtData({ fields: {} })
  t.absent(out.prices)
  t.is(out.currentPrice, 10)
  t.is(out.blockHeight, 1)
})

test('_readFromDb returns null when no mempool key', async (t) => {
  const wrk = Object.create(WrkMempoolRack.prototype)
  wrk.mempoolDb = { get: async () => null }
  const out = await wrk._readFromDb()
  t.is(out, null)
})
