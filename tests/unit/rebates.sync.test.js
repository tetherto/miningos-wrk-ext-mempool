'use strict'

const test = require('brittle')
const utilsStore = require('@tetherto/hp-svc-facs-store/utils')
const WrkMempoolRack = require('../../workers/rack.mempool.ext.wrk')
const { extractRebates, parseSyncCron, lastCronFire } = require('../../workers/lib/rebatesSync')
const { priceBucket } = require('../../workers/lib/utils')
const {
  POOL_REBATES_BEE,
  POOL_REBATES_DELETED_BEE,
  POOL_REBATES_DATA_KEY,
  POOL_REBATES_UPDATE_KEY,
  POOL_REBATES_DELETE_KEY,
  REBATES_SYNC_OVERLAP_MS
} = require('../../workers/lib/constants')

const ADDRESS = 'bc1qrebates'
const ADDRESS_2 = 'bc1qrebates2'
const TXID_A = 'a'.repeat(64)
const TXID_B = 'b'.repeat(64)
const TXID_C = 'c'.repeat(64)

const tx = ({ txid, blockTime = 1000, vin = [], vout = [], confirmed = true }) => ({
  txid,
  status: { confirmed, block_time: blockTime },
  vin,
  vout
})

const inputFrom = (address) => ({ prevout: { scriptpubkey_address: address } })
const outputTo = (address, value) => ({ scriptpubkey_address: address, value })

test('extractRebates maps an incoming tx to an auto rebate row', (t) => {
  const rebates = extractRebates([
    tx({
      txid: TXID_A,
      blockTime: 1700000000,
      vin: [inputFrom('bc1qsender')],
      vout: [outputTo(ADDRESS, 50000000), outputTo('bc1qchange', 1000)]
    })
  ], ADDRESS)

  t.alike(rebates, [{
    ts: 1700000000000,
    amountBTC: 0.5,
    txid: TXID_A,
    sender: 'bc1qsender',
    receiver: ADDRESS,
    source: 'auto'
  }])
})

test('extractRebates sums multiple outputs paying the address', (t) => {
  const rebates = extractRebates([
    tx({
      txid: TXID_A,
      vin: [inputFrom('bc1qsender')],
      vout: [outputTo(ADDRESS, 100000000), outputTo(ADDRESS, 25000000)]
    })
  ], ADDRESS)

  t.is(rebates.length, 1)
  t.is(rebates[0].amountBTC, 1.25)
})

test('extractRebates picks any one sender on multi-input txs', (t) => {
  const rebates = extractRebates([
    tx({
      txid: TXID_A,
      vin: [inputFrom('bc1qsender1'), inputFrom('bc1qsender2'), inputFrom('bc1qsender3')],
      vout: [outputTo(ADDRESS, 1000)]
    })
  ], ADDRESS)

  t.is(rebates[0].sender, 'bc1qsender1')
})

test('extractRebates skips txs spending from the address', (t) => {
  const rebates = extractRebates([
    tx({
      txid: TXID_A,
      vin: [inputFrom(ADDRESS)],
      vout: [outputTo(ADDRESS, 90000), outputTo('bc1qelsewhere', 10000)]
    })
  ], ADDRESS)

  t.is(rebates.length, 0)
})

test('extractRebates skips unconfirmed, unrelated and repeated txs', (t) => {
  const incoming = tx({
    txid: TXID_A,
    vin: [inputFrom('bc1qsender')],
    vout: [outputTo(ADDRESS, 1000)]
  })
  const rebates = extractRebates([
    tx({ txid: TXID_B, confirmed: false, vout: [outputTo(ADDRESS, 1000)] }),
    tx({ txid: TXID_C, vin: [inputFrom('bc1qsender')], vout: [outputTo('bc1qother', 1000)] }),
    incoming,
    incoming
  ], ADDRESS)

  t.alike(rebates.map((r) => r.txid), [TXID_A])
})

test('parseSyncCron accepts minute/hour schedules and rejects everything else', (t) => {
  t.alike(parseSyncCron('0 0 * * *'), { minute: 0, hour: 0, minuteStep: null })
  t.alike(parseSyncCron('30 4 * * *'), { minute: 30, hour: 4, minuteStep: null })
  t.alike(parseSyncCron('15 * * * *'), { minute: 15, hour: '*', minuteStep: null })
  t.alike(parseSyncCron('*/5 * * * *'), { minute: '*', hour: '*', minuteStep: 5 })
  t.alike(parseSyncCron('*/5 4 * * *'), { minute: '*', hour: 4, minuteStep: 5 })
  t.alike(parseSyncCron('* * * * *'), { minute: '*', hour: '*', minuteStep: null })

  for (const bad of ['', '0 4 * *', '0 4 1 * *', '0 4 * 2 *', '0 4 * * 1', '60 4 * * *', '0 24 * * *', '*/0 * * * *', '*/60 * * * *', '5-10 * * * *', '0 */2 * * *']) {
    t.exception(() => parseSyncCron(bad), /ERR_INVALID_SYNC_CRON/, `rejects "${bad}"`)
  }
})

test('lastCronFire returns the most recent UTC fire time', (t) => {
  const daily = parseSyncCron('0 4 * * *')
  t.is(lastCronFire(Date.UTC(2026, 8, 12, 10, 0), daily), Date.UTC(2026, 8, 12, 4, 0))
  t.is(lastCronFire(Date.UTC(2026, 8, 12, 1, 0), daily), Date.UTC(2026, 8, 11, 4, 0))

  const everyFive = parseSyncCron('*/5 * * * *')
  t.is(lastCronFire(Date.UTC(2026, 8, 12, 10, 7, 30), everyFive), Date.UTC(2026, 8, 12, 10, 5))
  t.is(lastCronFire(Date.UTC(2026, 8, 12, 10, 5), everyFive), Date.UTC(2026, 8, 12, 10, 5))

  const hourly = parseSyncCron('20 * * * *')
  t.is(lastCronFire(Date.UTC(2026, 8, 12, 10, 7), hourly), Date.UTC(2026, 8, 12, 9, 20))
  t.is(lastCronFire(Date.UTC(2026, 8, 12, 10, 40), hourly), Date.UTC(2026, 8, 12, 10, 20))

  const everyMinute = parseSyncCron('* * * * *')
  t.is(lastCronFire(Date.UTC(2026, 8, 12, 10, 7, 45), everyMinute), Date.UTC(2026, 8, 12, 10, 7))
})

const makeWrk = ({ addresses = [ADDRESS], syncCron, txsByAddress = {}, bucketPrices = {}, historicalPriceUSD = null } = {}) => {
  const wrk = Object.create(WrkMempoolRack.prototype)
  const stores = new Map()
  wrk.conf = { mempool: { rebates: { addresses, ...(syncCron ? { syncCron } : {}) } } }

  // Stand-ins for the 5m price store and the historical price fallback the
  // sync prices new rebates with.
  const prices5m = new Map(Object.entries(bucketPrices).map(([ts, priceUSD]) =>
    [Number(ts), JSON.stringify({ ts: Number(ts), priceUSD })]))
  wrk.prices5mDb = {
    get: async (key) => {
      const val = prices5m.get(utilsStore.convFromBin(key, 'number'))
      return val ? { value: Buffer.from(val) } : null
    },
    put: async (key, value) => { prices5m.set(utilsStore.convFromBin(key, 'number'), value.toString()) }
  }
  wrk._prices5m = prices5m
  wrk._rateLimitDelay = async () => {}
  wrk._historicalPriceCalls = []
  wrk.mempoolApi = {
    getHistoricalPrices: async (args) => {
      wrk._historicalPriceCalls.push(args)
      if (historicalPriceUSD instanceof Error) throw historicalPriceUSD
      return historicalPriceUSD ? { prices: [{ USD: historicalPriceUSD }] } : {}
    }
  }

  wrk._getBee = async (name) => {
    if (!stores.has(name)) stores.set(name, new Map())
    const rows = stores.get(name)
    return {
      close: async () => {},
      get: async (k) => (rows.has(k) ? { value: rows.get(k) } : null),
      put: async (k, v) => { rows.set(k, v) },
      del: async (k) => { rows.delete(k) },
      createReadStream: () => (async function * () {
        for (const v of rows.values()) yield { value: Buffer.from(v) }
      })()
    }
  }
  wrk._addressTxsCalls = []
  wrk._getAddressTxs = async ({ address, sinceTs }) => {
    wrk._addressTxsCalls.push({ address, sinceTs })
    const res = txsByAddress[address] ?? []
    if (res instanceof Error) throw res
    return res
  }
  wrk._stores = stores
  return wrk
}

const storedRebates = async (wrk) => wrk._readRebatesRows(POOL_REBATES_BEE)

test('runRebatesSync first run only records the deployment moment', async (t) => {
  const wrk = makeWrk()

  const out = await wrk.runRebatesSync({ now: 1234 })

  t.is(out.firstRun, true)
  t.is(wrk._addressTxsCalls.length, 0)
  t.alike(await wrk._getRebatesSyncState(), { startTs: 1234, lastSyncedTs: 1234, lastRunTs: 1234 })
})

test('runRebatesSync overlap never reaches back past the deployment moment', async (t) => {
  const HOUR = 60 * 60 * 1000
  const deployedAt = 100 * HOUR
  const wrk = makeWrk()

  await wrk.runRebatesSync({ now: deployedAt })
  await wrk.runRebatesSync({ now: deployedAt + HOUR })
  await wrk.runRebatesSync({ now: deployedAt + 10 * HOUR })
  await wrk.runRebatesSync({ now: deployedAt + 20 * HOUR })

  t.is(REBATES_SYNC_OVERLAP_MS, 2 * HOUR)
  t.alike(wrk._addressTxsCalls.map((c) => c.sinceTs), [deployedAt, deployedAt, deployedAt + 8 * HOUR])
  t.is((await wrk._getRebatesSyncState()).startTs, deployedAt, 'startTs survives later runs')
})

test('runRebatesSync ingests per address and skips stored and tombstoned txids', async (t) => {
  const wrk = makeWrk({
    addresses: [ADDRESS, ADDRESS_2],
    txsByAddress: {
      [ADDRESS]: [
        tx({ txid: TXID_A, vin: [inputFrom('bc1qsender')], vout: [outputTo(ADDRESS, 1000)] }),
        tx({ txid: TXID_B, vin: [inputFrom('bc1qsender')], vout: [outputTo(ADDRESS, 2000)] })
      ],
      [ADDRESS_2]: [
        tx({ txid: TXID_C, vin: [inputFrom('bc1qsender')], vout: [outputTo(ADDRESS_2, 3000)] })
      ]
    }
  })
  await wrk._setRebatesSyncState({ lastSyncedTs: 10000000, lastRunTs: 0 })
  await wrk._putRebatesKeyedRow(POOL_REBATES_BEE, TXID_A, { txid: TXID_A, ts: 1 })
  await wrk._putRebatesKeyedRow(POOL_REBATES_DELETED_BEE, TXID_B, { txid: TXID_B })

  const out = await wrk.runRebatesSync({ now: 20000000 })

  t.is(out.added, 1)
  const rows = await storedRebates(wrk)
  t.alike(rows.map((r) => r.txid).sort(), [TXID_A, TXID_C])
  t.alike(wrk._addressTxsCalls, [
    { address: ADDRESS, sinceTs: 10000000 - REBATES_SYNC_OVERLAP_MS },
    { address: ADDRESS_2, sinceTs: 10000000 - REBATES_SYNC_OVERLAP_MS }
  ])
  t.alike(await wrk._getRebatesSyncState(), { lastSyncedTs: 20000000, lastRunTs: 20000000 })
})

test('maybeRunRebatesSync does nothing without configured addresses', async (t) => {
  const wrk = makeWrk({ addresses: [] })
  await wrk.maybeRunRebatesSync()
  t.is(wrk._addressTxsCalls.length, 0)
})

test('maybeRunRebatesSync skips when the last cron fire is already covered', async (t) => {
  const wrk = makeWrk()
  await wrk._setRebatesSyncState({ lastSyncedTs: 1, lastRunTs: Date.now() })

  await wrk.maybeRunRebatesSync()

  t.is(wrk._addressTxsCalls.length, 0)
})

test('maybeRunRebatesSync runs when due and records the run on success', async (t) => {
  const wrk = makeWrk()
  const lastFire = lastCronFire(Date.now(), parseSyncCron('0 0 * * *'))
  await wrk._setRebatesSyncState({ lastSyncedTs: 1, lastRunTs: lastFire - 1 })

  await wrk.maybeRunRebatesSync()

  t.is(wrk._addressTxsCalls.length, 1)
  t.ok((await wrk._getRebatesSyncState()).lastRunTs >= lastFire)
  t.is(wrk._rebatesSyncRunning, false)
})

test('maybeRunRebatesSync swallows failures so the next tick retries', async (t) => {
  const wrk = makeWrk({ txsByAddress: { [ADDRESS]: new Error('ERR_NET') } })
  await wrk._setRebatesSyncState({ lastSyncedTs: 1, lastRunTs: 0 })

  await wrk.maybeRunRebatesSync()

  t.is((await wrk._getRebatesSyncState()).lastRunTs, 0, 'run not marked as done')
  t.is(wrk._rebatesSyncRunning, false)
})

test('maybeRunRebatesSync refuses to run on an invalid cron', async (t) => {
  const wrk = makeWrk({ syncCron: '0 4 1 * *' })
  await wrk._setRebatesSyncState({ lastSyncedTs: 1, lastRunTs: 0 })

  await wrk.maybeRunRebatesSync()

  t.is(wrk._addressTxsCalls.length, 0)
})

test('maybeRunRebatesSync runs sub-daily schedules', async (t) => {
  const wrk = makeWrk({ syncCron: '*/5 * * * *' })
  await wrk._setRebatesSyncState({ lastSyncedTs: 1, lastRunTs: 0 })

  await wrk.maybeRunRebatesSync()

  t.is(wrk._addressTxsCalls.length, 1)
  t.ok((await wrk._getRebatesSyncState()).lastRunTs > 0)
})

test('maybeRunRebatesSync ignores ticks while a run is in flight', async (t) => {
  const wrk = makeWrk()
  wrk._rebatesSyncRunning = true

  await wrk.maybeRunRebatesSync()

  t.is(wrk._addressTxsCalls.length, 0)
})

test('getWrkExtData POOL_REBATES filters stored rows by ts range', async (t) => {
  const wrk = makeWrk()
  await wrk._putRebatesKeyedRow(POOL_REBATES_BEE, TXID_A, { txid: TXID_A, ts: 1000 })
  await wrk._putRebatesKeyedRow(POOL_REBATES_BEE, TXID_B, { txid: TXID_B, ts: 2000 })
  await wrk._putRebatesKeyedRow(POOL_REBATES_BEE, TXID_C, { txid: TXID_C, ts: 3000 })

  const all = await wrk.getWrkExtData({ query: { key: POOL_REBATES_DATA_KEY } })
  t.is(all.length, 3)

  const ranged = await wrk.getWrkExtData({ query: { key: POOL_REBATES_DATA_KEY, start: 1500, end: 2500 } })
  t.alike(ranged.map((r) => r.txid), [TXID_B])
})

test('getWrkExtData POOL_REBATES supports sort, pagination, projection and query', async (t) => {
  const wrk = makeWrk()
  await wrk._putRebatesKeyedRow(POOL_REBATES_BEE, TXID_A, { txid: TXID_A, ts: 1000, amountBTC: 1, sender: 's1' })
  await wrk._putRebatesKeyedRow(POOL_REBATES_BEE, TXID_B, { txid: TXID_B, ts: 2000, amountBTC: 2, sender: 's2' })
  await wrk._putRebatesKeyedRow(POOL_REBATES_BEE, TXID_C, { txid: TXID_C, ts: 3000, amountBTC: 3, sender: 's3' })

  const page = await wrk.getWrkExtData({
    query: { key: POOL_REBATES_DATA_KEY, sort: { ts: -1 }, offset: 1, limit: 1 }
  })
  t.alike(page.map((r) => r.txid), [TXID_B], 'newest-first page 2 of size 1')

  const projected = await wrk.getWrkExtData({
    query: { key: POOL_REBATES_DATA_KEY, fields: { txid: 1, amountBTC: 1 }, sort: { ts: 1 }, limit: 1 }
  })
  t.alike(projected, [{ txid: TXID_A, amountBTC: 1 }], 'projection drops unselected fields')

  const queried = await wrk.getWrkExtData({
    query: { key: POOL_REBATES_DATA_KEY, query: { amountBTC: { $gte: 3 } } }
  })
  t.alike(queried.map((r) => r.txid), [TXID_C])

  const stringPaged = await wrk.getWrkExtData({
    query: { key: POOL_REBATES_DATA_KEY, sort: { ts: 1 }, offset: '1', limit: '1' }
  })
  t.alike(stringPaged.map((r) => r.txid), [TXID_B], 'string offset/limit coerce')
})

test('setWrkExtData delete removes the row, tombstones it and blocks re-sync', async (t) => {
  const wrk = makeWrk({
    txsByAddress: {
      [ADDRESS]: [tx({ txid: TXID_A, vin: [inputFrom('bc1qsender')], vout: [outputTo(ADDRESS, 1000)] })]
    }
  })
  await wrk._setRebatesSyncState({ lastSyncedTs: 1, lastRunDayTs: 0 })

  await wrk.runRebatesSync({})
  t.is((await storedRebates(wrk)).length, 1)

  await wrk.setWrkExtData({ key: POOL_REBATES_DELETE_KEY, value: { txid: TXID_A } })
  t.is((await storedRebates(wrk)).length, 0)

  await wrk.runRebatesSync({})
  t.is((await storedRebates(wrk)).length, 0, 'tombstoned txid is not re-added')
})

test('setWrkExtData delete tombstones txids that were never synced', async (t) => {
  const wrk = makeWrk()
  await wrk.setWrkExtData({ key: POOL_REBATES_DELETE_KEY, value: { txid: TXID_B } })

  const tombstones = await wrk._readRebatesRows(POOL_REBATES_DELETED_BEE)
  t.alike(tombstones.map((r) => r.txid), [TXID_B])
})

test('setWrkExtData update rewrites fields on an existing row', async (t) => {
  const wrk = makeWrk()
  await wrk._putRebatesKeyedRow(POOL_REBATES_BEE, TXID_A, {
    txid: TXID_A, ts: 1000, amountBTC: 1, sender: 'a', receiver: ADDRESS, source: 'auto'
  })

  await wrk.setWrkExtData({
    key: POOL_REBATES_UPDATE_KEY,
    value: { txid: TXID_A, ts: 5000, amountBTC: 2.5, sender: 'b', receiver: ADDRESS }
  })

  const rows = await storedRebates(wrk)
  t.alike(rows[0], { txid: TXID_A, ts: 5000, amountBTC: 2.5, sender: 'b', receiver: ADDRESS, source: 'auto' })
})

test('setWrkExtData update validates its input and target', async (t) => {
  const wrk = makeWrk()

  await t.exception(
    () => wrk.setWrkExtData({ key: POOL_REBATES_UPDATE_KEY, value: { txid: TXID_A, ts: 1000, amountBTC: 1 } }),
    /ERR_REBATE_NOT_FOUND/
  )
  await t.exception(
    () => wrk.setWrkExtData({ key: POOL_REBATES_UPDATE_KEY, value: { ts: 1000, amountBTC: 1 } }),
    /ERR_TXID_REQUIRED/
  )
  await t.exception(
    () => wrk.setWrkExtData({ key: POOL_REBATES_UPDATE_KEY, value: { txid: TXID_A, ts: 1.5, amountBTC: 1 } }),
    /ERR_INVALID_TS/
  )
  await t.exception(
    () => wrk.setWrkExtData({ key: POOL_REBATES_UPDATE_KEY, value: { txid: TXID_A, ts: 1000, amountBTC: 0 } }),
    /ERR_INVALID_AMOUNT/
  )
  await t.exception(() => wrk.setWrkExtData({ key: 'nope' }), /ERR_KEY_INVALID/)
})

// --- receipt pricing --------------------------------------------------------

const BLOCK_TIME = 1700000000 // seconds
const REBATE_TS = BLOCK_TIME * 1000

const incomingTx = () => tx({
  txid: TXID_A,
  blockTime: BLOCK_TIME,
  vin: [inputFrom('bc1qsender')],
  vout: [outputTo(ADDRESS, 50000000)]
})

test('runRebatesSync stamps the receipt price from the local 5m store', async (t) => {
  const wrk = makeWrk({
    txsByAddress: { [ADDRESS]: [incomingTx()] },
    bucketPrices: { [priceBucket(REBATE_TS)]: 64000 }
  })
  await wrk._setRebatesSyncState({ lastSyncedTs: 1, lastRunTs: 0 })

  await wrk.runRebatesSync({})

  const [row] = await storedRebates(wrk)
  t.is(row.priceUSD, 64000)
  t.alike(wrk._historicalPriceCalls, [], 'a cached bucket costs no upstream call')
})

test('runRebatesSync falls back to a historical lookup and caches the bucket', async (t) => {
  const wrk = makeWrk({
    txsByAddress: { [ADDRESS]: [incomingTx()] },
    historicalPriceUSD: 42000
  })
  await wrk._setRebatesSyncState({ lastSyncedTs: 1, lastRunTs: 0 })

  await wrk.runRebatesSync({})

  const [row] = await storedRebates(wrk)
  t.is(row.priceUSD, 42000)
  t.alike(wrk._historicalPriceCalls, [{ currency: 'USD', timestamp: BLOCK_TIME }])
  t.ok(wrk._prices5m.has(priceBucket(REBATE_TS)), 'the looked-up price also lands in the bucket store')
})

test('runRebatesSync stores the rebate unpriced when no price source answers', async (t) => {
  const wrk = makeWrk({ txsByAddress: { [ADDRESS]: [incomingTx()] } })
  await wrk._setRebatesSyncState({ lastSyncedTs: 1, lastRunTs: 0 })

  const out = await wrk.runRebatesSync({})

  t.is(out.added, 1, 'a missing price never fails the sync')
  const [row] = await storedRebates(wrk)
  t.is(row.priceUSD, undefined, 'the row is honestly unpriced, not zero')
})

test('runRebatesSync survives a historical price lookup error', async (t) => {
  const wrk = makeWrk({
    txsByAddress: { [ADDRESS]: [incomingTx()] },
    historicalPriceUSD: new Error('ERR_NET')
  })
  await wrk._setRebatesSyncState({ lastSyncedTs: 1, lastRunTs: 0 })

  const out = await wrk.runRebatesSync({})

  t.is(out.added, 1)
  t.is((await storedRebates(wrk))[0].priceUSD, undefined)
})

test('setWrkExtData update re-prices the row when its timestamp changes', async (t) => {
  const newTs = REBATE_TS + 60 * 60 * 1000
  const wrk = makeWrk({ bucketPrices: { [priceBucket(newTs)]: 50000 } })
  await wrk._putRebatesKeyedRow(POOL_REBATES_BEE, TXID_A, {
    txid: TXID_A, ts: REBATE_TS, amountBTC: 1, source: 'auto', priceUSD: 64000
  })

  await wrk.setWrkExtData({
    key: POOL_REBATES_UPDATE_KEY,
    value: { txid: TXID_A, ts: newTs, amountBTC: 1 }
  })

  t.is((await storedRebates(wrk))[0].priceUSD, 50000, 'the price follows the moment, not the row')
})

test('setWrkExtData update drops a price it cannot re-derive for a new timestamp', async (t) => {
  const wrk = makeWrk()
  await wrk._putRebatesKeyedRow(POOL_REBATES_BEE, TXID_A, {
    txid: TXID_A, ts: REBATE_TS, amountBTC: 1, source: 'auto', priceUSD: 64000
  })

  await wrk.setWrkExtData({
    key: POOL_REBATES_UPDATE_KEY,
    value: { txid: TXID_A, ts: REBATE_TS + 1000, amountBTC: 1 }
  })

  t.is((await storedRebates(wrk))[0].priceUSD, undefined, 'a wrong price is worse than no price')
})

test('setWrkExtData update keeps the stored price when the timestamp is unchanged', async (t) => {
  const wrk = makeWrk()
  await wrk._putRebatesKeyedRow(POOL_REBATES_BEE, TXID_A, {
    txid: TXID_A, ts: REBATE_TS, amountBTC: 1, source: 'auto', priceUSD: 64000
  })

  await wrk.setWrkExtData({
    key: POOL_REBATES_UPDATE_KEY,
    value: { txid: TXID_A, ts: REBATE_TS, amountBTC: 2 }
  })

  const [row] = await storedRebates(wrk)
  t.is(row.amountBTC, 2)
  t.is(row.priceUSD, 64000, 'an amount edit does not lose the receipt price')
})

test('setWrkExtData update rejects a timestamp past the store key range', async (t) => {
  const wrk = makeWrk()
  await wrk._putRebatesKeyedRow(POOL_REBATES_BEE, TXID_A, { txid: TXID_A, ts: 1000, amountBTC: 1 })

  await t.exception(
    () => wrk.setWrkExtData({ key: POOL_REBATES_UPDATE_KEY, value: { txid: TXID_A, ts: 2 ** 48, amountBTC: 1 } }),
    /ERR_INVALID_TS/
  )
})
