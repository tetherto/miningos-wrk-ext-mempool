'use strict'

const { BTC_SATS } = require('./constants')

// Each configured address belongs to one site phase, so a rebate is
// attributed per receiving address: one row per (txid, address), holding the
// amount that address received. Transactions that also spend from any of the
// addresses are still judged against all of them as one estate - change from
// our own outgoing transfers and moves between our own addresses look like
// incoming payments but are not rebates.
function extractRebates (txs, addresses) {
  const addressSet = new Set(Array.isArray(addresses) ? addresses : [addresses])
  const rebates = []
  const seen = new Set()

  for (const tx of Array.isArray(txs) ? txs : []) {
    if (!tx?.txid || !tx.status?.confirmed || !Number.isFinite(tx.status.block_time)) continue
    if (seen.has(tx.txid)) continue
    seen.add(tx.txid)

    const inputs = Array.isArray(tx.vin) ? tx.vin : []
    if (inputs.some((vin) => addressSet.has(vin?.prevout?.scriptpubkey_address))) continue

    const satsByAddress = new Map()
    for (const vout of Array.isArray(tx.vout) ? tx.vout : []) {
      const address = vout?.scriptpubkey_address
      if (!addressSet.has(address) || !(Number(vout.value) > 0)) continue
      satsByAddress.set(address, (satsByAddress.get(address) || 0) + Number(vout.value))
    }

    const sender = inputs.find((vin) => vin?.prevout?.scriptpubkey_address)?.prevout.scriptpubkey_address
    for (const [receiver, sats] of satsByAddress) {
      rebates.push({
        ts: tx.status.block_time * 1000,
        amountBTC: sats / BTC_SATS,
        txid: tx.txid,
        sender,
        receiver,
        source: 'auto'
      })
    }
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
