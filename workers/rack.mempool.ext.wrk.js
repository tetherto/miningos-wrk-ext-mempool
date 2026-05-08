'use strict'

const async = require('async')
const TetherWrkBase = require('@tetherto/tether-wrk-base/workers/base.wrk.tether')
const MempoolApi = require('./lib/mempool.api')
const { setTimeout: sleep } = require('timers/promises')
const {
  BTC_SATS, REWARD_AVG_TIMES, MS_24_HOURS,
  STAT_PRICES,
  MEMPOOL_TAG,
  HISTORICAL_PRICES_DATA_KEY,
  STAT_BLOCKSIZES,
  HISTORICAL_BLOCKSIZES_DATA_KEY,
  STAT_HASHRATE_HISTORY,
  HISTORICAL_HASHRATE_DATA_KEY
} = require('./lib/constants')
const { getUTCMidnightTwoYearsAgo, getUTCMidnightTimestampsLast2Years, getUTCMidnightToday } = require('./lib/utils')
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

        this.mempoolDb = await this.store_s1.getBee({ name: 'mempool' }, { keyEncoding: 'binary' })
        await this.mempoolDb.ready()

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
          'mempool-historical-data-fetch',
          this.saveHistoricalData.bind(this),
          this.conf.mempool.historicalDataFetchIntervalMs || 43200000
        )
        try {
          await this.saveHistoricalData()
        } catch (error) {
          console.log('ERR_SAVE_HISTORICAL_DATA', error)
        }
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
      await this._saveToDbKey(statKey, ts, { ts, priceUSD: price.prices[0].USD })
    }
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
      '2y'
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
          start: getUTCMidnightTwoYearsAgo(),
          end: Date.now(),
          key: STAT_HASHRATE_HISTORY,
          tag: MEMPOOL_TAG
        })
      } catch (_) {}

      if (hashratesResponse.length < 726) {
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
      console.log('ERR_FETCH_HISTORICAL_BLOCKSIZES', error)
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
      const timestamps = getUTCMidnightTimestampsLast2Years()
      let blocksResponse = []

      try {
        blocksResponse = await this._getDbData(`${STAT_BLOCKSIZES}-${MEMPOOL_TAG}`, {
          start: getUTCMidnightTwoYearsAgo(),
          end: Date.now()
        })
      } catch (_) {}

      if (blocksResponse.length < 726) {
        for (const ts of timestamps) {
          await this._fetchAndSaveHistoricalBlockSize(ts)
        }
      } else {
        await this._fetchAndSaveHistoricalBlockSize(getUTCMidnightToday())
      }
    } catch (error) {
      console.log('ERR_FETCH_HISTORICAL_BLOCKSIZES', error)
    } finally {
      this.fetchingHistoricalBlocksData = false
    }
  }

  async saveHistoricalPrices () {
    if (this.fetchingHistoricalPricesData) return
    this.fetchingHistoricalPricesData = true

    try {
      const timestamps = getUTCMidnightTimestampsLast2Years()
      let pricesResponse = []

      try {
        pricesResponse = await this._getDbData(`${STAT_PRICES}-${MEMPOOL_TAG}`, {
          start: getUTCMidnightTwoYearsAgo(),
          end: Date.now()
        })
      } catch (_) {}

      if (pricesResponse.length < 726) {
        for (const ts of timestamps) {
          await this._fetchAndSaveHistoricalPrice(ts)
        }
      } else {
        await this._fetchAndSaveHistoricalPrice(getUTCMidnightToday())
      }
    } catch (error) {
      console.log('ERR_FETCH_HISTORICAL_PRICES', error)
    } finally {
      this.fetchingHistoricalPricesData = false
    }
  }

  async saveHistoricalData () {
    try {
      await this.saveHistoricalPrices()
    } catch (error) {
      console.log('ERR_SAVE_HISTORICAL_DATA_PRICES', error)
    }
    try {
      await this.saveHistoricalBlockSizes()
    } catch (error) {
      console.log('ERR_SAVE_HISTORICAL_DATA_BLOCKSIZES', error)
    }
    try {
      await this.saveHistoricalHashrates()
    } catch (error) {
      console.log('ERR_SAVE_HISTORICAL_DATA_HASHRATES', error)
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

  async _fetchWithDelay (fn, obj, args) {
    // fetch api data with delay due to api rate limits
    await sleep(1000)
    try {
      return await fn.call(obj, args)
    } catch (e) {
      console.error(new Date().toISOString(), e)
    }

    return null
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

  async getWrkExtData (args) {
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
