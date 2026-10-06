'use strict'

const { BTC_SATS } = require('./constants')

// Every confirmed transaction paying `address` is a rebate, except those that
// also spend from it: change from our own outgoing transfers looks like an
// incoming payment but is not a rebate.
function extractRebates (txs, address) {
  const rebates = []
  const seen = new Set()

  for (const tx of Array.isArray(txs) ? txs : []) {
    if (!tx?.txid || !tx.status?.confirmed || !Number.isFinite(tx.status.block_time)) continue
    if (seen.has(tx.txid)) continue

    const inputs = Array.isArray(tx.vin) ? tx.vin : []
    if (inputs.some((vin) => vin?.prevout?.scriptpubkey_address === address)) continue

    const sats = (Array.isArray(tx.vout) ? tx.vout : [])
      .filter((vout) => vout?.scriptpubkey_address === address)
      .reduce((sum, vout) => sum + (Number(vout.value) || 0), 0)
    if (sats <= 0) continue

    seen.add(tx.txid)
    rebates.push({
      ts: tx.status.block_time * 1000,
      amountBTC: sats / BTC_SATS,
      txid: tx.txid,
      sender: inputs.find((vin) => vin?.prevout?.scriptpubkey_address)?.prevout.scriptpubkey_address,
      receiver: address,
      source: 'auto'
    })
  }

  return rebates
}

// Schedules are the minute/hour subset of cron, evaluated in UTC so site
// locations stay out of config files (a timezone names the site). "0 4 * * *"
// runs daily at a South American site's midnight; "*/5 * * * *" and
// "15 * * * *" style sub-daily schedules are for staging, where waiting a day
// per sync makes testing impractical. Day, month and weekday must stay "*".
function parseSyncCron (expr) {
  const parts = String(expr ?? '').trim().split(/\s+/)
  if (parts.length !== 5 || parts[2] !== '*' || parts[3] !== '*' || parts[4] !== '*') {
    throw new Error('ERR_INVALID_SYNC_CRON')
  }

  const [minutePart, hourPart] = parts
  const cron = { minute: '*', hour: '*', minuteStep: null }

  if (minutePart.startsWith('*/')) {
    const step = Number(minutePart.slice(2))
    if (!Number.isInteger(step) || step < 1 || step > 59) throw new Error('ERR_INVALID_SYNC_CRON')
    cron.minuteStep = step
  } else if (minutePart !== '*') {
    const minute = Number(minutePart)
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error('ERR_INVALID_SYNC_CRON')
    cron.minute = minute
  }

  if (hourPart !== '*') {
    const hour = Number(hourPart)
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error('ERR_INVALID_SYNC_CRON')
    cron.hour = hour
  }

  return cron
}

const MINUTE_MS = 60 * 1000

function cronMatches (ts, { minute, hour, minuteStep }) {
  const date = new Date(ts)
  if (hour !== '*' && date.getUTCHours() !== hour) return false
  if (minuteStep) return date.getUTCMinutes() % minuteStep === 0
  return minute === '*' || date.getUTCMinutes() === minute
}

// The most recent scheduled fire time at or before `now`; a run is due when
// the last completed run predates it. Every accepted schedule fires at least
// once a day, so the scan terminates within 24h of minutes.
function lastCronFire (now, cron) {
  let ts = now - (now % MINUTE_MS)
  while (!cronMatches(ts, cron)) ts -= MINUTE_MS
  return ts
}

module.exports = {
  extractRebates,
  parseSyncCron,
  lastCronFire
}
