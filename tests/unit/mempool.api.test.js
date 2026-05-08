'use strict'

const test = require('brittle')
const MempoolApi = require('../../workers/lib/mempool.api')

test('MempoolApi methods call expected endpoints', async (t) => {
  const paths = []
  const http = {
    get: async (path) => {
      paths.push(path)
      return { body: { ok: true, path } }
    }
  }
  const api = new MempoolApi(http)

  await api.getPrices()
  await api.getBlockHeight()
  await api.getBlockRewards()
  await api.getAdjustments()
  await api.getHashrate()
  await api.getHashrate('2y')
  await api.getTransactionFees()
  await api.getHistoricalPrices({ currency: 'USD', timestamp: 1 })
  await api.getBlockByTimestamp(123)
  await api.getBlock('abc')

  t.alike(paths, [
    '/v1/prices',
    '/blocks/tip/height',
    '/v1/mining/blocks/rewards/3y',
    '/v1/difficulty-adjustment',
    '/v1/mining/hashrate/3d',
    '/v1/mining/hashrate/2y',
    '/v1/fees/recommended',
    '/v1/historical-price?currency=USD&timestamp=1',
    '/v1/mining/blocks/timestamp/123',
    '/v1/block/abc'
  ])
})
