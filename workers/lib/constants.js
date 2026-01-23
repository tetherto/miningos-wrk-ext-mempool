'use strict'

module.exports = {
  BTC_SATS: 100000000, // satoshis in 1 btc
  MS_24_HOURS: 24 * 60 * 60 * 1000,
  MS_180_DAYS: 180 * 24 * 60 * 60 * 1000,
  REWARD_AVG_TIMES: {
    '24h': 24 * 60 * 60 * 1000,
    '3d': 3 * 24 * 60 * 60 * 1000,
    '1w': 7 * 24 * 60 * 60 * 1000,
    '1m': 30 * 24 * 60 * 60 * 1000,
    '3m': 3 * 30 * 24 * 60 * 60 * 1000,
    '6m': 6 * 30 * 24 * 60 * 60 * 1000,
    '1y': 365 * 24 * 60 * 60 * 1000,
    '2y': 2 * 365 * 24 * 60 * 60 * 1000,
    '3y': (3 * 365 * 24 * 60 * 60 * 1000 - 24 * 60 * 60 * 1000) // Api returns ts one day behind
  },
  STAT_PRICES: 'stat-prices',
  STAT_BLOCKSIZES: 'stat-blocksizes',
  STAT_HASHRATE_HISTORY: 'stat-hashrate-history',
  MEMPOOL_TAG: 't-mempool',
  HISTORICAL_PRICES_DATA_KEY: 'HISTORICAL_PRICES',
  HISTORICAL_BLOCKSIZES_DATA_KEY: 'HISTORICAL_BLOCKSIZES',
  HISTORICAL_HASHRATE_DATA_KEY: 'HISTORICAL_HASHRATE'
}
