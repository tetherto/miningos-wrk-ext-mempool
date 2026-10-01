'use strict'

const async = require('async')
const TetherWrkBase = require('@tetherto/tether-wrk-base/workers/base.wrk.tether')
const MempoolApi = require('./lib/mempool.api')
const { setTimeout: sleep } = require('timers/promises')
const {
  BTC_SATS, REWARD_AVG_TIMES, MS_24_HOURS,
  STAT_PRICES,
  STAT_PRICES_5M,
  MEMPOOL_TAG,
  HISTORICAL_PRICES_DATA_KEY,
  STAT_BLOCKSIZES,
  HISTORICAL_BLOCKSIZES_DATA_KEY,
  STAT_HASHRATE_HISTORY,
  HISTORICAL_HASHRATE_DATA_KEY,
  HISTORICAL_DATA_START_TS,
  PRICE_AT_TIMESTAMPS_DATA_KEY,
  PRICE_SAMPLE_INTERVAL_MS,
  ADDRESS_TXS_PAGE_SIZE,
  ADDRESS_TXS_MAX_PAGES,
  POOL_REBATES_DATA_KEY,
  POOL_REBATES_UPDATE_KEY,
  POOL_REBATES_DELETE_KEY,
  POOL_REBATES_BEE,
  POOL_REBATES_DELETED_BEE,
  POOL_REBATES_SYNC_BEE,
  REBATES_SYNC_TICK_MS,
  REBATES_SYNC_OVERLAP_MS,
  REBATES_SYNC_CRON_DEFAULT
} = require('./lib/constants')
const { extractRebates, parseDailyCron, lastCronFire } = require('./lib/rebatesSync')
const { getUTCMidnightTimestampsSince, getUTCMidnightToday, priceBucket } = require('./lib/utils')
const utilsStore = require('@tetherto/hp-svc-facs-store/utils')
const gLibUtilBase = require('@bitfinex/lib-js-util-base')
const mingo = require('mingo')

class WrkMempoolRack extends TetherWrkBase {
  constructor (conf, ctx) {
    super(conf, ctx)

    if (!ctx.rack) {
      throw new Error('ERR_PROC_RACK_UNDEFINED')
    }

    this.prefix = `${this.wtype}-${ctx.rack}`

    this.init()
    this.start()

    this.mempoolData = {
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
  }

  init () {
    super.init()

    this.loadConf('mempool', 'mempool')

    this.setInitFacs([
      ['fac', '@tetherto/hp-svc-facs-store', 's1', 's1', {
        storePrimaryKey: this.ctx.storePrimaryKey,
        storeDir: `store/${this.ctx.rack}-db`
      }, 0],
      ['fac', '@bitfinex/bfx-facs-interval', '0', 'mempool', {}, -10],
      ['fac', '@bitfinex/bfx-facs-http', '0', '0', {
        baseUrl: this.conf.mempool.baseUrl,
        timeout: 30 * 1000
      }, 0]
    ])
  }

  _start (cb) {
    async.series([
      (next) => { super._start(next) },
      async () => {
        this.net_r0.rpcServer.respond('getWrkExtData', async (req) => {
          return await this.net_r0.handleReply('getWrkExtData', req)
        })
        this.net_r0.rpcServer.respond('setWrkExtData', async (req) => {
          return await this.net_r0.handleReply('setWrkExtData', req)
        })

        this.mempoolDb = await this.store_s1.getBee({ name: 'mempool' }, { keyEncoding: 'binary' })
        await this.mempoolDb.ready()

        // Held open for the worker's lifetime: the sampler, the rebates sync
        // and the RPC read path all touch this store, and the _getBee/close-
        // per-call pattern used by _saveToDbKey would let one close the bee
        // under the other.
        this.prices5mDb = await this._getBee(`${STAT_PRICES_5M}-${MEMPOOL_TAG}`)

        const dbData = await this._readFromDb()
        if (dbData) this.mempoolData = dbData

        this.mempoolApi = new MempoolApi(this.http_0)
        await this.fetchMempoolData()
        this.interval_mempool.add(
          'mempool-data-fetch',
          this.fetchMempoolData.bind(this),
          this.conf.mempool.dataFetchIntervalMs || 1800000
        )
        this.interval_mempool.add(
          'mempool-price-sample',
          this.samplePrice.bind(this),
          this.conf.mempool.priceSampleIntervalMs || PRICE_SAMPLE_INTERVAL_MS
        )
        this.interval_mempool.add(
          'mempool-historical-data-fetch',
          this.saveHistoricalData.bind(this),
          this.conf.mempool.historicalDataFetchIntervalMs || 43200000
        )
        try {
          await this.saveHistoricalData()
        } catch (error) {
          console.error('ERR_SAVE_HISTORICAL_DATA', error)
        }

        this.interval_mempool.add(
          'rebates-sync',
          this.maybeRunRebatesSync.bind(this),
          REBATES_SYNC_TICK_MS
        )
        this.maybeRunRebatesSync()
      }
    ], cb)
  }

  async _fetchAndSaveHistoricalPrice (ts) {
    const api = this.mempoolApi
    const statKey = `${STAT_PRICES}-${MEMPOOL_TAG}`
    const price = await this._fetchWithDelay(
      api.getHistoricalPrices,
      api,
      { currency: 'USD', timestamp: ts / 1000 }
    )
    if (price?.prices?.[0]?.USD) {
      const priceUSD = price.prices[0].USD
      await this._saveToDbKey(statKey, ts, { ts, priceUSD })
      // UTC midnight is always an exact 5m boundary, so the daily series seeds
      // the bucket store for free - payouts dated at midnight (f2pool mining
      // dates) then resolve without a backfill.
      await this._savePriceBucket(priceBucket(ts), priceUSD)
    }
  }

  async _savePriceBucket (bucketTs, priceUSD) {
    await this.prices5mDb.put(
      utilsStore.convIntToBin(bucketTs),
      Buffer.from(JSON.stringify({ ts: bucketTs, priceUSD }))
    )
  }

  async _getPriceBucket (bucketTs) {
    const entry = await this.prices5mDb.get(utilsStore.convIntToBin(bucketTs))
    if (!entry) return null
    return JSON.parse(entry.value.toString())
  }

  async samplePrice () {
    if (this.samplingPrice) return
    this.samplingPrice = true

    try {
      const api = this.mempoolApi
      const prices = await this._fetchWithDelay(api.getPrices, api)
      if (!prices?.USD) return

      // Bucketed at response time rather than when the interval fired: the call
      // can sit behind other upstream work, and the price belongs to the moment
      // it was actually read.
      await this._savePriceBucket(priceBucket(Date.now()), prices.USD)
    } catch (error) {
      console.error('ERR_SAMPLE_PRICE', error)
    } finally {
      this.samplingPrice = false
    }
  }

  // Cache reads only - never fetches. Finance requests call this through an RPC
  // with a 15s timeout while every upstream call costs at least 5s, so fetching
  // here would time out the whole request and lose the buckets that did
  // resolve. Buckets with no stored price come back in `missing` so the caller
  // knows it fell back (the server-side backfill script clears them).
  async getPricesAtTimestamps ({ timestamps }) {
    const prices = {}
    const missing = []

    if (!Array.isArray(timestamps)) return { prices, missing }

    const buckets = [...new Set(
      timestamps.filter(Number.isFinite).map((ts) => priceBucket(ts))
    )]

    for (const bucketTs of buckets) {
      // convIntToBin writes a 6-byte unsigned int, so a bucket outside
      // [0, 2^48) would throw and poison the whole batch - one garbage
      // timestamp must not take down every bucket that did resolve.
      if (!this._isValidBeeTs(bucketTs)) {
        missing.push(bucketTs)
        continue
      }

      const entry = await this._getPriceBucket(bucketTs)
      if (entry?.priceUSD) prices[bucketTs] = entry.priceUSD
      else missing.push(bucketTs)
    }

    return { prices, missing }
  }

  _isValidBeeTs (ts) {
    return Number.isInteger(ts) && ts >= 0 && ts < 2 ** 48
  }

  async _saveHistoricalHashrate (hashrateObj) {
    const statKey = `${STAT_HASHRATE_HISTORY}-${MEMPOOL_TAG}`
    const ts = hashrateObj.timestamp * 1000
    const avgHashrateMHs = hashrateObj.avgHashrate / 1000000
    await this._saveToDbKey(statKey, ts, { ts, avgHashrateMHs })
  }

  async _fetchAndSaveHistoricalHashrates () {
    const api = this.mempoolApi
    const hashrateData = await this._fetchWithDelay(
      api.getHashrate,
      api,
      '3m'
    )
    if (!hashrateData?.hashrates) return
    for (const hashrateObj of hashrateData.hashrates) {
      await this._saveHistoricalHashrate(hashrateObj)
    }
  }

  async saveHistoricalHashrates () {
    if (this.fetchingHistoricalHashrates) return
    this.fetchingHistoricalHashrates = true
    let hashratesResponse = []

    try {
      try {
        hashratesResponse = await this._getDbData(`${STAT_HASHRATE_HISTORY}-${MEMPOOL_TAG}`, {
          start: HISTORICAL_DATA_START_TS,
          end: Date.now(),
          key: STAT_HASHRATE_HISTORY,
          tag: MEMPOOL_TAG
        })
      } catch (_) {}

      const timestamps = getUTCMidnightTimestampsSince(HISTORICAL_DATA_START_TS)

      if (hashratesResponse.length < timestamps.length - 1) {
        await this._fetchAndSaveHistoricalHashrates()
      } else {
        const api = this.mempoolApi
        const hashrateData = await this._fetchWithDelay(
          api.getHashrate,
          api,
          '3d'
        )
        if (!hashrateData?.hashrates) return
        const latestHashrateObj = hashrateData.hashrates.reduce((latest, current) => {
          return current.timestamp > latest.timestamp ? current : latest
        })
        await this._saveHistoricalHashrate(latestHashrateObj)
      }
    } catch (error) {
      console.error('ERR_FETCH_HISTORICAL_BLOCKSIZES', error)
    } finally {
      this.fetchingHistoricalHashrates = false
    }
  }

  async _fetchAndSaveHistoricalBlockSize (ts) {
    const api = this.mempoolApi
    const statKey = `${STAT_BLOCKSIZES}-${MEMPOOL_TAG}`
    const blockData = await this._fetchWithDelay(
      api.getBlockByTimestamp,
      api,
      ts / 1000
    )
    if (!blockData?.hash) return
    const block = await this._fetchWithDelay(api.getBlock, api, blockData.hash)
    if (!block) return
    await this._saveToDbKey(statKey, ts, {
      ts,
      blockSize: block.size,
      blockHash: blockData.hash,
      blockReward: block.extras?.reward,
      blockTotalFees: block.extras?.totalFees
    })
  }

  async saveHistoricalBlockSizes () {
    if (this.fetchingHistoricalBlocksData) return
    this.fetchingHistoricalBlocksData = true

    try {
      const timestamps = getUTCMidnightTimestampsSince(HISTORICAL_DATA_START_TS)
      let blocksResponse = []

      try {
        blocksResponse = await this._getDbData(`${STAT_BLOCKSIZES}-${MEMPOOL_TAG}`, {
          start: HISTORICAL_DATA_START_TS,
          end: Date.now(),
          limit: timestamps.length
        })
      } catch (_) {}

      if (blocksResponse.length < timestamps.length - 1) {
        for (const ts of timestamps) {
          await this._fetchAndSaveHistoricalBlockSize(ts)
        }
      } else {
        await this._fetchAndSaveHistoricalBlockSize(getUTCMidnightToday())
      }
    } catch (error) {
      console.error('ERR_FETCH_HISTORICAL_BLOCKSIZES', error)
    } finally {
      this.fetchingHistoricalBlocksData = false
    }
  }

  async saveHistoricalPrices () {
    if (this.fetchingHistoricalPricesData) return
    this.fetchingHistoricalPricesData = true

    try {
      const timestamps = getUTCMidnightTimestampsSince(HISTORICAL_DATA_START_TS)
      let pricesResponse = []

      try {
        pricesResponse = await this._getDbData(`${STAT_PRICES}-${MEMPOOL_TAG}`, {
          start: HISTORICAL_DATA_START_TS,
          end: Date.now(),
          limit: timestamps.length
        })
      } catch (_) {}

      if (pricesResponse.length < timestamps.length - 1) {
        for (const ts of timestamps) {
          await this._fetchAndSaveHistoricalPrice(ts)
        }
      } else {
        await this._fetchAndSaveHistoricalPrice(getUTCMidnightToday())
      }
    } catch (error) {
      console.error('ERR_FETCH_HISTORICAL_PRICES', error)
    } finally {
      this.fetchingHistoricalPricesData = false
    }
  }

  async saveHistoricalData () {
    try {
      await this.saveHistoricalPrices()
    } catch (error) {
      console.error('ERR_SAVE_HISTORICAL_DATA_PRICES', error)
    }
    try {
      await this.saveHistoricalBlockSizes()
    } catch (error) {
      console.error('ERR_SAVE_HISTORICAL_DATA_BLOCKSIZES', error)
    }
    try {
      await this.saveHistoricalHashrates()
    } catch (error) {
      console.error('ERR_SAVE_HISTORICAL_DATA_HASHRATES', error)
    }
  }

  async fetchMempoolData () {
    if (this.fetchingData) return
    this.fetchingData = true

    const api = this.mempoolApi
    const data = this.mempoolData

    try {
      const prices = await this._fetchWithDelay(api.getPrices, api)
      if (prices) this._savePrices(prices)

      const blockHeight = await this._fetchWithDelay(api.getBlockHeight, api)
      if (blockHeight) data.blockHeight = blockHeight

      const adjustments = await this._fetchWithDelay(api.getAdjustments, api)
      if (adjustments) this._saveAdjustments(adjustments)

      const hashrate = await this._fetchWithDelay(api.getHashrate, api)
      if (hashrate) {
        data.currentHashrate = hashrate.currentHashrate
        data.currentDifficulty = hashrate.currentDifficulty
      }

      const blockRewards = await this._fetchWithDelay(api.getBlockRewards, api)
      if (blockRewards) this._calculateRewardAvgs(blockRewards)

      const transactionFees = await this._fetchWithDelay(api.getTransactionFees, api)
      if (transactionFees) this._saveTransactionFees(transactionFees)

      await this._saveToDb(data)
    } catch (e) {
      console.error(new Date().toISOString(), e)
    } finally {
      this.fetchingData = false
    }
  }

  async _rateLimitDelay () {
    await sleep(1000)
  }

  async _fetchWithDelay (fn, obj, args) {
    // fetch api data with delay due to api rate limits.
    // Chained so the delay is a real gap between upstream calls rather than a
    // per-caller sleep: the price sampler runs on its own interval and would
    // otherwise fire alongside the polling cycles, both waking after the same
    // 5s and hitting the API together.
    const previous = this._apiChain || Promise.resolve()
    let release
    this._apiChain = new Promise((resolve) => { release = resolve })

    try {
      await previous
      await sleep(5000)
      try {
        return await fn.call(obj, args)
      } catch (e) {
        console.error(new Date().toISOString(), e)
      }

      return null
    } finally {
      release()
    }
  }

  async _saveToDb (data) {
    await this.mempoolDb.put('mempool', Buffer.from(JSON.stringify(data)))
  }

  async _readFromDb () {
    const data = await this.mempoolDb.get('mempool')
    if (!data) return null
    return JSON.parse(data.value.toString())
  }

  async _saveToDbKey (key, ts, data) {
    const db = await this._getBee(key)
    await db.put(utilsStore.convIntToBin(ts), Buffer.from(JSON.stringify(data)))
    await db.close()
  }

  async _getDbData (key, { start, end, limit = 100 }) {
    const db = await this._getBee(key)
    const stream = db.createReadStream({
      gte: utilsStore.convIntToBin(start),
      lte: utilsStore.convIntToBin(end),
      limit
    })
    const res = []
    for await (const entry of stream) {
      res.push(JSON.parse(entry.value.toString()))
    }
    await db.close()
    return res
  }

  async _getBee (name) {
    const db = await this.store_s1.getBee({ name }, { keyEncoding: 'binary' })
    await db.ready()
    return db
  }

  _savePrices (prices) {
    const pricesHistory = this.mempoolData.prices
    pricesHistory.push({ time: Date.now(), price: prices.USD })

    // keep history only for 24 hours
    this.mempoolData.prices = pricesHistory.filter(val => (Date.now() - val.time) <= MS_24_HOURS)
    this.mempoolData.currentPrice = prices.USD
    this.mempoolData.priceChange24Hrs = this._priceChange24Hours()
  }

  _priceChange24Hours () {
    const data = this.mempoolData
    const currentPrice = data.currentPrice
    const price24HoursAgo = data.prices.find(val => (Date.now() - val.time) >= MS_24_HOURS)
    if (!price24HoursAgo?.price) return 0
    return (currentPrice - price24HoursAgo.price) / price24HoursAgo.price * 100
  }

  _saveAdjustments (adjustments) {
    this.mempoolData.adjustments = {
      progressToDifficulty: adjustments.progressPercent,
      nextAdjustmentTs: adjustments.estimatedRetargetDate,
      nextAdjustmentExp: adjustments.difficultyChange,
      prevAdjustment: adjustments.previousRetarget,
      avgBlockTime: adjustments.timeAvg / (60 * 1000)
    }
  }

  _calculateRewardAvgs (rewards) {
    const rewardAvgs = { '24h': 0, '3d': 0, '1w': 0, '1m': 0, '3m': 0, '6m': 0, '1y': 0, '2y': 0, '3y': 0 }

    for (const rewardTimes in rewardAvgs) {
      const rewardsInRange = rewards.filter(val => Date.now() - (val.timestamp * 1000) >= REWARD_AVG_TIMES[rewardTimes])
      if (rewardsInRange.length) {
        const totalRewards = rewardsInRange.reduce((prev, val) => prev + val.avgRewards, 0)
        rewardAvgs[rewardTimes] = (totalRewards / rewardsInRange.length) / BTC_SATS
      }
    }
    this.mempoolData.blockRewardAvgs = rewardAvgs
  }

  _saveTransactionFees (fees) {
    this.mempoolData.transactionFees = {
      fastest: fees.fastestFee,
      halfHour: fees.halfHourFee,
      hour: fees.hourFee
    }
  }

  getThingType () {
    return 'mempool'
  }

  getThingTags () {
    return ['mempool']
  }

  _projection (data, fields = {}) {
    const query = new mingo.Query({})
    const cursor = query.find(data, fields)
    return cursor.all()
  }

  _getHistoricalExtDataLogKey (key) {
    if (key === HISTORICAL_BLOCKSIZES_DATA_KEY) return STAT_BLOCKSIZES
    if (key === HISTORICAL_HASHRATE_DATA_KEY) return STAT_HASHRATE_HISTORY
    if (key === HISTORICAL_PRICES_DATA_KEY) return STAT_PRICES
  }

  // Unlike the polled datasets, errors here must reach the caller: the rebates
  // sync treats a completed fetch as "window fully scanned", so a swallowed
  // error (as _fetchWithDelay does) would silently drop transactions.
  async _getAddressTxs ({ address, sinceTs }) {
    if (!address) throw new Error('ERR_ADDRESS_REQUIRED')
    const since = Number.isFinite(sinceTs) ? sinceTs : 0
    const txs = []
    let lastSeenTxid

    for (let page = 0; page < ADDRESS_TXS_MAX_PAGES; page++) {
      await this._rateLimitDelay()
      const batch = await this.mempoolApi.getAddressTxsChain({ address, lastSeenTxid })
      if (!Array.isArray(batch) || !batch.length) break

      for (const tx of batch) {
        if (!tx?.status?.confirmed) continue
        if (tx.status.block_time * 1000 < since) return txs
        txs.push(tx)
      }

      lastSeenTxid = batch[batch.length - 1]?.txid
      if (batch.length < ADDRESS_TXS_PAGE_SIZE) break
    }

    return txs
  }

  async _getRebatesKeyedRow (bee, key) {
    const db = await this._getBee(bee)
    const res = await db.get(key)
    await db.close()
    return res?.value ? JSON.parse(res.value.toString()) : null
  }

  async _putRebatesKeyedRow (bee, key, data) {
    const db = await this._getBee(bee)
    await db.put(key, Buffer.from(JSON.stringify(data)))
    await db.close()
  }

  async _readRebatesRows (bee) {
    const db = await this._getBee(bee)
    const rows = []
    for await (const entry of db.createReadStream()) {
      rows.push(JSON.parse(entry.value.toString()))
    }
    await db.close()
    return rows
  }

  async _deleteRebateRow (txid) {
    const db = await this._getBee(POOL_REBATES_BEE)
    await db.del(txid)
    await db.close()
  }

  async _getRebatesSyncState () {
    return (await this._getRebatesKeyedRow(POOL_REBATES_SYNC_BEE, 'state')) ?? {}
  }

  async _setRebatesSyncState (state) {
    await this._putRebatesKeyedRow(POOL_REBATES_SYNC_BEE, 'state', state)
  }

  // Runs once per scheduled cron fire (syncCron, UTC). lastRunTs only advances
  // when every configured address synced, so a failed run is retried on each
  // tick until the next fire passes with a completed run behind it.
  async maybeRunRebatesSync () {
    const conf = this.conf.mempool.rebates || {}
    const addresses = Array.isArray(conf.addresses) ? conf.addresses.filter(Boolean) : []
    if (!addresses.length || this._rebatesSyncRunning) return

    let cron
    try {
      cron = parseDailyCron(conf.syncCron || REBATES_SYNC_CRON_DEFAULT)
    } catch (err) {
      console.error(new Date().toISOString(), 'ERR_REBATES_SYNC_CRON', conf.syncCron)
      return
    }

    this._rebatesSyncRunning = true
    try {
      const state = await this._getRebatesSyncState()
      if ((state.lastRunTs || 0) >= lastCronFire(Date.now(), cron)) return

      const { added, firstRun } = await this.runRebatesSync({})
      if (!firstRun) console.log(new Date().toISOString(), `rebates sync completed, added ${added}`)
    } catch (err) {
      console.error(new Date().toISOString(), 'ERR_REBATES_SYNC', err)
    } finally {
      this._rebatesSyncRunning = false
    }
  }

  async runRebatesSync ({ now = Date.now() }) {
    const conf = this.conf.mempool.rebates || {}
    const addresses = Array.isArray(conf.addresses) ? conf.addresses.filter(Boolean) : []
    const state = await this._getRebatesSyncState()

    // No backfill: the first run only records the deployment moment, and every
    // later run picks up from the last successful one. An address added later
    // starts from the current cursor the same way - forward only.
    if (!Number.isFinite(state.lastSyncedTs)) {
      await this._setRebatesSyncState({ lastSyncedTs: now, lastRunTs: now })
      return { added: 0, firstRun: true }
    }

    // Windows overlap so a run close to the previous cutoff can never miss a
    // block; txid dedup makes the re-scanned span harmless.
    const sinceTs = state.lastSyncedTs - REBATES_SYNC_OVERLAP_MS
    const known = new Set((await this._readRebatesRows(POOL_REBATES_BEE)).map((row) => row.txid))
    const tombstones = new Set((await this._readRebatesRows(POOL_REBATES_DELETED_BEE)).map((row) => row.txid))

    let added = 0
    for (const address of addresses) {
      const txs = await this._getAddressTxs({ address, sinceTs })
      for (const rebate of extractRebates(txs, address)) {
        if (known.has(rebate.txid) || tombstones.has(rebate.txid)) continue
        const priceUSD = await this._getReceiptPriceUSD(rebate.ts)
        await this._putRebatesKeyedRow(
          POOL_REBATES_BEE,
          rebate.txid,
          priceUSD ? { ...rebate, priceUSD } : rebate
        )
        known.add(rebate.txid)
        added++
      }
    }

    await this._setRebatesSyncState({ lastSyncedTs: now, lastRunTs: now })
    return { added, firstRun: false }
  }

  // The USD value of a rebate at the moment it was received. The daily sync
  // runs within a day of receipt, so the local 5m store normally has the
  // bucket already; a rebate from further back (first run after an outage)
  // costs one historical lookup, whose result also lands in the bucket store.
  // A rebate that still cannot be priced is stored without a price - the
  // finance read path falls back to the daily price for it - and must never
  // fail the sync over it.
  async _getReceiptPriceUSD (ts) {
    const bucketTs = priceBucket(ts)
    const bucket = await this._getPriceBucket(bucketTs)
    if (bucket?.priceUSD) return bucket.priceUSD

    try {
      await this._rateLimitDelay()
      const res = await this.mempoolApi.getHistoricalPrices({ currency: 'USD', timestamp: Math.floor(ts / 1000) })
      const priceUSD = res?.prices?.[0]?.USD
      if (!priceUSD) return undefined

      await this._savePriceBucket(bucketTs, priceUSD)
      return priceUSD
    } catch (err) {
      console.error(new Date().toISOString(), 'ERR_REBATE_RECEIPT_PRICE', err.message)
      return undefined
    }
  }

  async _getPoolRebates ({ start, end, query, fields, sort, offset, limit }) {
    const rows = await this._readRebatesRows(POOL_REBATES_BEE)
    const bounded = rows.filter((row) =>
      (!Number.isFinite(start) || row.ts >= start) &&
      (!Number.isFinite(end) || row.ts <= end)
    )

    const mingoQuery = new mingo.Query(query || {})
    let cursor = mingoQuery.find(bounded, fields || {})
    if (!gLibUtilBase.isNil(sort)) cursor = cursor.sort(sort)
    const skip = Number(offset)
    if (Number.isFinite(skip) && skip > 0) cursor = cursor.skip(skip)
    const max = Number(limit)
    if (Number.isFinite(max) && max > 0) cursor = cursor.limit(max)

    return cursor.all()
  }

  async setWrkExtData (req) {
    const { key, value } = req || {}

    // Tombstoning a txid that was never synced is valid: it protects a deleted
    // manual rebate with that txid from reappearing through a later sync.
    if (key === POOL_REBATES_DELETE_KEY) {
      const txid = value?.txid
      if (!txid) throw new Error('ERR_TXID_REQUIRED')
      await this._deleteRebateRow(txid)
      await this._putRebatesKeyedRow(POOL_REBATES_DELETED_BEE, txid, { txid, deletedAt: Date.now() })
      return true
    }

    if (key === POOL_REBATES_UPDATE_KEY) {
      const { txid, ts, amountBTC, sender, receiver } = value || {}
      if (!txid) throw new Error('ERR_TXID_REQUIRED')
      // Upper bound keeps the re-price bucket lookup inside convIntToBin's
      // 6-byte range; anything past it is garbage input, not a timestamp.
      if (!Number.isInteger(ts) || ts <= 0 || !this._isValidBeeTs(ts)) throw new Error('ERR_INVALID_TS')
      if (!Number.isFinite(amountBTC) || amountBTC <= 0) throw new Error('ERR_INVALID_AMOUNT')

      const existing = await this._getRebatesKeyedRow(POOL_REBATES_BEE, txid)
      if (!existing) throw new Error('ERR_REBATE_NOT_FOUND')

      const next = { ...existing, ts, amountBTC, sender, receiver }
      if (ts !== existing.ts) {
        // The stored price belongs to the old moment. Re-derive from the local
        // bucket store only - this serves an RPC, so no upstream call budget;
        // an unknown bucket leaves the row unpriced and the read path falls
        // back to the daily price rather than keeping a wrong one.
        const bucket = await this._getPriceBucket(priceBucket(ts))
        next.priceUSD = bucket?.priceUSD || undefined
      }
      await this._putRebatesKeyedRow(POOL_REBATES_BEE, txid, next)
      return true
    }

    throw new Error('ERR_KEY_INVALID')
  }

  async getWrkExtData (args) {
    if (args.query?.key === POOL_REBATES_DATA_KEY) {
      return await this._getPoolRebates(args.query)
    }

    if (args.query?.key === PRICE_AT_TIMESTAMPS_DATA_KEY) {
      return await this.getPricesAtTimestamps(args.query)
    }

    if ([HISTORICAL_PRICES_DATA_KEY, HISTORICAL_BLOCKSIZES_DATA_KEY, HISTORICAL_HASHRATE_DATA_KEY].includes(args.query?.key)) {
      const key = `${this._getHistoricalExtDataLogKey(args.query.key)}-${MEMPOOL_TAG}`
      return await this._getDbData(key, args.query)
    }

    const { prices, ...apiData } = this.mempoolData

    if (!gLibUtilBase.isEmpty(args.fields)) return this._projection([apiData], args.fields)[0]
    return apiData
  }
}

module.exports = WrkMempoolRack
