'use strict'

/**
 * @see https://mempool.space/docs/api/rest
 */
class MempoolApi {
  constructor (http) {
    this._http = http
  }

  async _request (apiPath) {
    const { body: resp } = await this._http.get(apiPath, { encoding: 'json' })
    return resp
  }

  async getPrices () {
    return await this._request('/v1/prices')
  }

  async getBlockHeight () {
    return await this._request('/blocks/tip/height')
  }

  async getBlockRewards () {
    return await this._request('/v1/mining/blocks/rewards/3y')
  }

  async getAdjustments () {
    return await this._request('/v1/difficulty-adjustment')
  }

  async getHashrate (timeperiod = '3d') {
    return await this._request(`/v1/mining/hashrate/${timeperiod}`)
  }

  async getTransactionFees () {
    return await this._request('/v1/fees/recommended')
  }

  async getHistoricalPrices ({ currency, timestamp }) {
    return await this._request(`/v1/historical-price?currency=${currency}&timestamp=${timestamp}`)
  }

  async getBlockByTimestamp (timestamp) {
    return await this._request(`/v1/mining/blocks/timestamp/${timestamp}`)
  }

  async getBlock (hash) {
    return await this._request(`/v1/block/${hash}`)
  }

  // The esplora-style /txs/chain/:txid route is not served by electrum-backed
  // mempool instances (our self-hosted upstream 404s on it); the after_txid
  // query form paginates on both backends.
  async getAddressTxs ({ address, afterTxid }) {
    const suffix = afterTxid ? `?after_txid=${afterTxid}` : ''
    return await this._request(`/address/${address}/txs${suffix}`)
  }
}

module.exports = MempoolApi
