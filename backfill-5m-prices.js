'use strict'

// backfill-5m-prices.js
//
// Drop this single file into the root of a miningos-wrk-ext-mempool checkout
// and run it from there (`node backfill-5m-prices.js ...`). It has no
// dependencies beyond what this repo already has installed.
//
// Fill the 5-minute BTC price store (`stat-prices-5m-t-mempool`) for moments in
// the PAST. The worker itself only looks forward — it samples the current price
// every 5 minutes — so any payout that happened before the sampler was deployed
// has no bucket to price against and falls back to that day's single price.
// This script closes that gap.
//
// Usage:
//   node backfill-5m-prices.js --from <when> --to <when>
//   node backfill-5m-prices.js --timestamps-file <file>
//
//   --from/--to        fill EVERY 5-minute bucket in the range (288 per day, so
//                      ~24 min of wall clock per day of history at the default delay)
//   --timestamps-file  fill only the buckets covering these moments — one ISO
//                      date or epoch-ms per line, or a JSON array. Prefer this:
//                      the work is then proportional to payouts, not to calendar
//                      time. Feed it the timestamps the finance API reports as
//                      missing (e.g. app-node's generate-price-backfill-timestamps.js).
//   --rack             which rack's store to use, i.e. store/<rack>-db (same
//                      name passed as --rack when starting the worker). Only
//                      needed when store/ holds more than one rack's data —
//                      see auto-inference below.
//   --store            store directory to open directly, overriding --rack and
//                      auto-inference entirely. Rarely needed.
//   --base-url         mempool API base (defaults to config/mempool.json)
//   --delay-ms         gap between upstream calls (default 5000, matching the worker)
//   --max-calls        stop after N upstream calls, for bounded maintenance windows
//   --dry-run          report what would be fetched, make no calls and no writes
//
// Store directory: with neither --store nor --rack, this scans store/ for
// directories the worker created for its price store (store/<rack>-db, the
// s1 fac — not store/<rack>, which is the base class's own P2P store, s0).
// Exactly one match is used automatically; zero or multiple matches require
// --rack or --store to disambiguate.
//
// Preconditions:
//   - the worker for this store must be STOPPED. Corestore is single-writer per
//     dir and takes an exclusive lock on <storeDir>/CORESTORE, but that lock was
//     observed NOT to fire on macOS even with the store open in another process,
//     so treat this as the operator's responsibility rather than something the
//     store reliably refuses. Two writers on one dir risk losing or corrupting
//     entries whether or not the lock catches it.
//
// Safe to interrupt and re-run: buckets that already hold a price are skipped,
// and buckets upstream cannot answer get a failure marker so later runs stop
// retrying them instead of burning the rate limit on the same dead timestamps.
//
// Stopping the worker leaves a gap in the forward series, but those are just
// more past buckets — a later run of this script fills them too.

const fs = require('fs')
const path = require('path')

const StoreFacility = require('@tetherto/hp-svc-facs-store')
const utilsStore = require('@tetherto/hp-svc-facs-store/utils')
const MempoolApi = require('./workers/lib/mempool.api')
const { STAT_PRICES_5M, MEMPOOL_TAG, PRICE_BUCKET_MS } = require('./workers/lib/constants')
const { priceBucket } = require('./workers/lib/utils')

const REPO_ROOT = __dirname
const BEE_NAME = `${STAT_PRICES_5M}-${MEMPOOL_TAG}`

// A bucket upstream has never answered for is retried a few times across runs,
// with a widening gap, then left alone. Some timestamps simply predate the
// price feed's own history and will never resolve.
const MAX_ATTEMPTS = 4
const RETRY_BACKOFF_MS = 6 * 60 * 60 * 1000

function parseArgs (argv) {
  const args = { dryRun: false, delayMs: 5000 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--store') args.store = argv[++i]
    else if (a === '--rack') args.rack = argv[++i]
    else if (a === '--from') args.from = argv[++i]
    else if (a === '--to') args.to = argv[++i]
    else if (a === '--timestamps-file') args.timestampsFile = argv[++i]
    else if (a === '--base-url') args.baseUrl = argv[++i]
    else if (a === '--delay-ms') args.delayMs = Number(argv[++i])
    else if (a === '--max-calls') args.maxCalls = Number(argv[++i])
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '-h' || a === '--help') args.help = true
    else throw new Error(`unknown arg: ${a}`)
  }
  return args
}

function usage () {
  console.log('Usage: node backfill-5m-prices.js (--from <when> --to <when> | --timestamps-file <file>)')
  console.log('       [--rack <name> | --store <dir>] [--base-url <url>] [--delay-ms 5000] [--max-calls N] [--dry-run]')
  console.log('Requires the worker for this store to be stopped.')
  console.log('With neither --rack nor --store, the store dir is auto-inferred from store/ (see file header).')
}

function parseTs (value) {
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric

  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) throw new Error(`cannot parse timestamp: ${value}`)
  return parsed
}

function readTimestampsFile (file) {
  const raw = fs.readFileSync(file, 'utf8').trim()
  if (raw.startsWith('[')) return JSON.parse(raw).map(parseTs)

  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map(parseTs)
}

function resolveBuckets (args) {
  if (args.timestampsFile) {
    const timestamps = readTimestampsFile(path.resolve(args.timestampsFile))
    return [...new Set(timestamps.map(priceBucket))].sort((a, b) => a - b)
  }

  const from = priceBucket(parseTs(args.from))
  const to = priceBucket(parseTs(args.to))
  if (from > to) throw new Error('--from must be before --to')

  const buckets = []
  for (let ts = from; ts <= to; ts += PRICE_BUCKET_MS) buckets.push(ts)
  return buckets
}

// The s1 fac names its dir `store/${rack}-db` (rack.mempool.ext.wrk.js:60);
// the base class's own P2P store sits alongside it at `store/${rack}` (s0,
// no suffix) and must not be mistaken for it.
function resolveStoreDir (args) {
  if (args.store) return path.resolve(args.store)
  if (args.rack) return path.join(REPO_ROOT, 'store', `${args.rack}-db`)

  const storeRoot = path.join(REPO_ROOT, 'store')
  let entries = []
  try {
    entries = fs.readdirSync(storeRoot, { withFileTypes: true })
  } catch (err) {
    throw new Error(`no --store/--rack given and ${storeRoot} does not exist`)
  }

  const candidates = entries
    .filter((e) => e.isDirectory() && e.name.endsWith('-db'))
    .map((e) => e.name)

  if (candidates.length === 0) {
    throw new Error(`no --store/--rack given and no *-db store found under ${storeRoot}`)
  }
  if (candidates.length > 1) {
    throw new Error(
      `no --store/--rack given and multiple stores found under ${storeRoot}: ${candidates.join(', ')} — ` +
      'pass --rack <name> or --store <dir> to disambiguate'
    )
  }

  console.log(`[backfill-5m-prices] --rack/--store not given, inferred store/${candidates[0]}`)
  return path.join(storeRoot, candidates[0])
}

function resolveBaseUrl (args) {
  if (args.baseUrl) return args.baseUrl

  const confPath = path.join(REPO_ROOT, 'config', 'mempool.json')
  if (!fs.existsSync(confPath)) {
    throw new Error(`no --base-url given and ${confPath} not found`)
  }

  const { baseUrl } = JSON.parse(fs.readFileSync(confPath, 'utf8'))
  if (!baseUrl) throw new Error(`no baseUrl in ${confPath}`)
  return baseUrl
}

// MempoolApi only needs `.get(path, opts) -> { body }`, so the script talks to
// the same endpoints through the same client the worker uses rather than
// rebuilding URLs, without pulling in the http facility's config wiring.
function createHttp (baseUrl) {
  return {
    async get (apiPath) {
      const res = await fetch(`${baseUrl}${apiPath}`)
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${apiPath}`)
      return { body: await res.json() }
    }
  }
}

function pStart (fac) { return new Promise((resolve, reject) => fac.start(err => err ? reject(err) : resolve())) }
function pStop (fac) { return new Promise((resolve, reject) => fac.stop(err => err ? reject(err) : resolve())) }

async function openStore (storeDir) {
  const fac = new StoreFacility({}, { ns: 's1', storeDir }, { env: 'production' })
  try {
    await pStart(fac)
  } catch (err) {
    // Only fires where the platform actually enforces the corestore lock; see
    // the preconditions note above.
    if (/could not be locked/i.test(err.message)) {
      throw new Error(`store ${storeDir} is locked — stop the worker using it before running this script`)
    }
    throw err
  }
  return fac
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function shouldSkip (existing) {
  if (!existing) return null
  if (existing.priceUSD) return 'present'

  const attempts = existing.attempts || 0
  if (attempts >= MAX_ATTEMPTS) return 'unavailable'

  const due = (existing.lastAttemptAt || 0) + RETRY_BACKOFF_MS * Math.pow(2, attempts - 1)
  if (Date.now() < due) return 'backoff'

  return null
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { usage(); return }
  if (!args.timestampsFile && (!args.from || !args.to)) {
    usage()
    process.exitCode = 1
    return
  }

  const storeDir = resolveStoreDir(args)
  if (!fs.existsSync(storeDir)) throw new Error(`store dir not found: ${storeDir}`)

  const buckets = resolveBuckets(args)
  const baseUrl = args.dryRun ? null : resolveBaseUrl(args)
  const api = args.dryRun ? null : new MempoolApi(createHttp(baseUrl))

  console.log(`[backfill-5m-prices] store   = ${storeDir}`)
  console.log(`[backfill-5m-prices] buckets = ${buckets.length}`)
  console.log(`[backfill-5m-prices] mode    = ${args.dryRun ? 'DRY-RUN (no calls, no writes)' : `WRITE via ${baseUrl}`}`)

  const fac = await openStore(storeDir)
  const counts = { present: 0, unavailable: 0, backoff: 0, filled: 0, failed: 0, remaining: 0 }

  try {
    const bee = await fac.getBee({ name: BEE_NAME }, { keyEncoding: 'binary' })
    await bee.ready()

    try {
      for (const [i, bucketTs] of buckets.entries()) {
        const progress = `${i + 1}/${buckets.length}`
        const key = utilsStore.convIntToBin(bucketTs)
        const entry = await bee.get(key)
        const existing = entry ? JSON.parse(entry.value.toString()) : null

        const skip = shouldSkip(existing)
        if (skip) { counts[skip]++; continue }

        if (args.dryRun) { counts.remaining++; continue }

        if (args.maxCalls && counts.filled + counts.failed >= args.maxCalls) {
          counts.remaining++
          continue
        }

        await sleep(args.delayMs)

        let priceUSD = null
        try {
          const res = await api.getHistoricalPrices({ currency: 'USD', timestamp: bucketTs / 1000 })
          priceUSD = res?.prices?.[0]?.USD || null
        } catch (err) {
          console.warn(`[backfill-5m-prices] ${new Date(bucketTs).toISOString()}: ${err.message}`)
        }

        if (priceUSD) {
          await bee.put(key, Buffer.from(JSON.stringify({ ts: bucketTs, priceUSD })))
          counts.filled++
          console.log(`[backfill-5m-prices] [${progress}] ${new Date(bucketTs).toISOString()} filled priceUSD=${priceUSD}`)
        } else {
          const attempts = (existing?.attempts || 0) + 1
          await bee.put(key, Buffer.from(JSON.stringify({
            ts: bucketTs,
            priceUSD: null,
            attempts,
            lastAttemptAt: Date.now()
          })))
          counts.failed++
          console.log(`[backfill-5m-prices] [${progress}] ${new Date(bucketTs).toISOString()} failed attempts=${attempts}`)
        }
      }
    } finally {
      await bee.close()
    }
  } finally {
    await pStop(fac)
  }

  console.log(
    `[backfill-5m-prices] DONE filled=${counts.filled} failed=${counts.failed} ` +
    `alreadyPresent=${counts.present} unavailable=${counts.unavailable} ` +
    `backoff=${counts.backoff} remaining=${counts.remaining}`
  )
}

main().catch(err => { console.error('[backfill-5m-prices] FAILED:', err.message); process.exit(1) })
