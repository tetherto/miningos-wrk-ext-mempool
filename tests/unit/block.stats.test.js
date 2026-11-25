'use strict'

const test = require('brittle')
const WrkMempoolRack = require('../../workers/rack.mempool.ext.wrk')
const {
  hourBucket,
  pickBlocks,
  groupByHour,
  addBlocksToRow,
  addLateBlockToRow,
  isBlockUnservable,
  isPageUnusable
} = require('../../workers/lib/blockStats')
const MempoolApi = require('../../workers/lib/mempool.api')
const {
  MS_1_HOUR,
  MEMPOOL_TAG,
  STAT_BLOCK_STATS_1H,
  HISTORICAL_BLOCK_STATS_DATA_KEY,
  BLOCK_STATS_START_TS,
  BLOCK_STATS_SYNC_BEE,
  BLOCK_STATS_CONFIRMATIONS,
  BLOCK_STATS_PAGE_SIZE,
  BLOCK_STATS_SKIPPED_RETRY_MS
} = require('../../workers/lib/constants')

const STAT_KEY = `${STAT_BLOCK_STATS_1H}-${MEMPOOL_TAG}`
const BLOCK_GAP_MS = 10 * 60 * 1000
const FIRST_HEIGHT = 1000

// Heights from FIRST_HEIGHT, ten minutes apart, starting two hours before the
// history start so a backfill has something to stop at.
const makeChain = (length) => Array.from({ length }, (_, i) => ({
  id: `hash-${FIRST_HEIGHT + i}`,
  height: FIRST_HEIGHT + i,
  timestamp: (BLOCK_STATS_START_TS - 2 * MS_1_HOUR + i * BLOCK_GAP_MS) / 1000,
  size: 1000000 + i,
  extras: { reward: 312500000 + i * 1000, totalFees: i * 1000 }
}))

const expectedRows = (blocks) => {
  const rows = {}
  for (const block of blocks) {
    const ts = hourBucket(block.timestamp * 1000)
    if (ts < BLOCK_STATS_START_TS) continue
    rows[ts] ??= { ts, blockCount: 0, blockRewardSum: 0, blockTotalFeesSum: 0, blockSizeSum: 0 }
    rows[ts].blockCount++
    rows[ts].blockRewardSum += block.extras.reward
    rows[ts].blockTotalFeesSum += block.extras.totalFees
    rows[ts].blockSizeSum += block.size
  }
  return rows
}

const storedSums = (wrk) => {
  const rows = {}
  for (const [ts, row] of wrk.rows) {
    const { minHeight, maxHeight, lateHeights, ...sums } = row
    rows[ts] = sums
  }
  return rows
}

const httpError = (status) => Object.assign(new Error(`ERR_HTTP: ${status}`), { status })

// `broken` heights behave like a block the upstream index cannot produce: the
// page holding one fails, and so does the block itself. `holes` are the same
// block reported the quiet way - the page answers without it.
const makeWrk = (chain, { pageSize = BLOCK_STATS_PAGE_SIZE } = {}) => {
  const wrk = Object.create(WrkMempoolRack.prototype)
  wrk.chain = chain
  wrk.rows = new Map()
  wrk.state = null
  wrk.pageCalls = []
  wrk.blockCalls = []
  wrk.broken = new Set()
  wrk.holes = new Set()
  wrk.brokenStatus = 500
  wrk.mempoolApi = {
    getBlockHeight: async () => wrk.chain[wrk.chain.length - 1].height,
    getBlocks: async (height) => {
      wrk.pageCalls.push(height)
      const page = wrk.chain
        .filter((block) => block.height <= height && block.height > height - pageSize)
        .reverse()
      if (page.some((block) => wrk.broken.has(block.height))) throw httpError(wrk.brokenStatus)
      return page.filter((block) => !wrk.holes.has(block.height))
    },
    getBlockHash: async (height) => {
      if (!wrk.chain.some((block) => block.height === height)) throw httpError(404)
      return `hash-${height}`
    },
    getBlock: async (hash) => {
      const block = wrk.chain.find((candidate) => candidate.id === hash)
      wrk.blockCalls.push(block.height)
      if (wrk.broken.has(block.height) || wrk.unservedHoles?.has(block.height)) throw httpError(wrk.brokenStatus)
      return block
    }
  }
  wrk._apiCall = async (fn, obj, args) => fn.call(obj, args)
  wrk._getDbRow = async (key, ts) => {
    if (key !== STAT_KEY) throw new Error(`unexpected key ${key}`)
    return wrk.rows.get(ts) ?? null
  }
  wrk._saveToDbKey = async (key, ts, data) => {
    if (key !== STAT_KEY) throw new Error(`unexpected key ${key}`)
    wrk.rows.set(ts, data)
  }
  wrk._getRebatesKeyedRow = async (bee, key) => {
    if (bee !== BLOCK_STATS_SYNC_BEE || key !== 'state') throw new Error('unexpected state read')
    return wrk.state
  }
  wrk._putRebatesKeyedRow = async (bee, key, data) => {
    if (bee !== BLOCK_STATS_SYNC_BEE || key !== 'state') throw new Error('unexpected state write')
    wrk.state = data
  }
  return wrk
}

const confirmed = (chain) => chain.slice(0, chain.length - BLOCK_STATS_CONFIRMATIONS)

const silenceErrors = (t) => {
  const original = console.error
  const seen = []
  console.error = (...args) => { seen.push(args) }
  t.teardown(() => { console.error = original })
  return seen
}

test('hourBucket floors to the UTC hour', (t) => {
  const hour = Date.UTC(2026, 10, 1, 13)
  t.is(hourBucket(hour), hour)
  t.is(hourBucket(hour + MS_1_HOUR - 1), hour)
  t.is(hourBucket(hour + MS_1_HOUR), hour + MS_1_HOUR)
})

test('pickBlocks returns the wanted heights oldest first', (t) => {
  const chain = makeChain(20)
  const blocks = pickBlocks([...chain].reverse(), FIRST_HEIGHT + 3, FIRST_HEIGHT + 6)

  t.alike(blocks.map((block) => block.height), [1003, 1004, 1005, 1006])
  t.alike(blocks[0], {
    height: 1003,
    ts: chain[3].timestamp * 1000,
    reward: chain[3].extras.reward,
    totalFees: chain[3].extras.totalFees,
    size: chain[3].size
  })
})

test('pickBlocks stops at a hole instead of skipping over it', (t) => {
  const chain = makeChain(10).filter((block) => block.height !== FIRST_HEIGHT + 4)
  const blocks = pickBlocks(chain, FIRST_HEIGHT, FIRST_HEIGHT + 9)

  t.alike(blocks.map((block) => block.height), [1005, 1006, 1007, 1008, 1009])
})

test('pickBlocks rejects a page it cannot use', (t) => {
  const chain = makeChain(5)
  t.exception(() => pickBlocks({ error: 'nope' }, FIRST_HEIGHT, FIRST_HEIGHT + 4), /ERR_BLOCK_STATS_INVALID_PAGE/)
  t.exception(() => pickBlocks([], FIRST_HEIGHT, FIRST_HEIGHT + 4), /ERR_BLOCK_STATS_EMPTY_PAGE/)
  t.exception(() => pickBlocks(chain, FIRST_HEIGHT + 10, FIRST_HEIGHT + 12), /ERR_BLOCK_STATS_EMPTY_PAGE/)

  const noReward = chain.map((block) => ({ ...block, extras: {} }))
  t.exception(() => pickBlocks(noReward, FIRST_HEIGHT, FIRST_HEIGHT + 4), /ERR_BLOCK_STATS_INVALID_BLOCK/)
})

test('groupByHour buckets blocks by their own timestamp', (t) => {
  const blocks = pickBlocks(makeChain(13), FIRST_HEIGHT, FIRST_HEIGHT + 12)
  const hours = groupByHour(blocks)

  t.alike([...hours.keys()], [
    BLOCK_STATS_START_TS - 2 * MS_1_HOUR,
    BLOCK_STATS_START_TS - MS_1_HOUR,
    BLOCK_STATS_START_TS
  ])
  t.alike([...hours.values()].map((list) => list.length), [6, 6, 1])
})

test('addBlocksToRow sums a new row and extends an existing one', (t) => {
  const ts = BLOCK_STATS_START_TS
  const block = (height, reward, totalFees, size) => ({ height, ts, reward, totalFees, size })

  const first = addBlocksToRow(null, ts, [block(10, 100, 10, 1000), block(11, 200, 20, 2000)])
  t.alike(first, {
    ts, blockCount: 2, blockRewardSum: 300, blockTotalFeesSum: 30, blockSizeSum: 3000, minHeight: 10, maxHeight: 11
  })

  const grown = addBlocksToRow(first, ts, [block(12, 50, 5, 500)])
  t.alike(grown, {
    ts, blockCount: 3, blockRewardSum: 350, blockTotalFeesSum: 35, blockSizeSum: 3500, minHeight: 10, maxHeight: 12
  })
  t.is(first.blockCount, 2, 'the stored row is not mutated')

  const older = addBlocksToRow(grown, ts, [block(8, 1, 1, 1), block(9, 1, 1, 1)])
  t.is(older.blockCount, 5, 'several blocks below the stored span are all counted')
  t.is(older.blockRewardSum, 352)
  t.is(older.minHeight, 8)
})

test('addBlocksToRow ignores blocks the row already covers', (t) => {
  const ts = BLOCK_STATS_START_TS
  const blocks = [10, 11, 12].map((height) => ({ height, ts, reward: 100, totalFees: 10, size: 1000 }))
  const row = addBlocksToRow(null, ts, blocks)

  t.alike(addBlocksToRow(row, ts, blocks), row)
  t.alike(addBlocksToRow(row, ts, [blocks[1]]), row)
})

test('syncBlockStats backfills every confirmed block down to the history start', async (t) => {
  const chain = makeChain(60)
  const wrk = makeWrk(chain)

  await wrk.syncBlockStats()

  t.alike(storedSums(wrk), expectedRows(confirmed(chain)))
  t.is(wrk.state.maxHeight, chain[chain.length - 1].height - BLOCK_STATS_CONFIRMATIONS)
  t.is(wrk.state.backfilledToTs, BLOCK_STATS_START_TS)
  t.is(wrk._blockStatsSyncRunning, false)
})

test('syncBlockStats stores nothing dated before the history start', async (t) => {
  const wrk = makeWrk(makeChain(60))

  await wrk.syncBlockStats()

  t.ok([...wrk.rows.keys()].every((ts) => ts >= BLOCK_STATS_START_TS))
  t.is(Math.min(...wrk.rows.keys()), BLOCK_STATS_START_TS)
})

test('syncBlockStats adds only the new confirmed blocks on later runs', async (t) => {
  const chain = makeChain(80)
  const wrk = makeWrk(chain.slice(0, 40))
  await wrk.syncBlockStats()

  wrk.chain = chain.slice(0, 43)
  wrk.pageCalls = []
  await wrk.syncBlockStats()
  t.alike(wrk.pageCalls, [1042 - BLOCK_STATS_CONFIRMATIONS], 'one page, no backfill once history is complete')
  t.alike(storedSums(wrk), expectedRows(confirmed(chain.slice(0, 43))))

  wrk.chain = chain
  await wrk.syncBlockStats()
  t.alike(storedSums(wrk), expectedRows(confirmed(chain)), 'a gap longer than one page is walked in full')
})

test('syncBlockStats run twice with no new block changes nothing', async (t) => {
  const wrk = makeWrk(makeChain(50))
  await wrk.syncBlockStats()
  const before = JSON.stringify([...wrk.rows])

  wrk.pageCalls = []
  await wrk.syncBlockStats()

  t.is(JSON.stringify([...wrk.rows]), before)
  t.alike(wrk.pageCalls, [])
})

test('syncBlockStats does not double count when the cursor write is lost', async (t) => {
  const chain = makeChain(70)
  const wrk = makeWrk(chain)
  const putState = wrk._putRebatesKeyedRow
  let writes = 0
  wrk._putRebatesKeyedRow = async (...args) => {
    if (++writes === 3) throw new Error('crash after rows were written')
    return putState(...args)
  }
  silenceErrors(t)

  await wrk.syncBlockStats()
  t.absent(wrk.state.backfilledToTs, 'the first run died part way through the backfill')

  wrk._putRebatesKeyedRow = putState
  await wrk.syncBlockStats()

  t.alike(storedSums(wrk), expectedRows(confirmed(chain)))
})

test('syncBlockStats does not double count when a forward page is replayed', async (t) => {
  const chain = makeChain(90)
  const wrk = makeWrk(chain.slice(0, 40))
  await wrk.syncBlockStats()

  const putState = wrk._putRebatesKeyedRow
  wrk._putRebatesKeyedRow = async () => { throw new Error('crash after rows were written') }
  silenceErrors(t)
  wrk.chain = chain
  await wrk.syncBlockStats()

  wrk._putRebatesKeyedRow = putState
  await wrk.syncBlockStats()

  t.alike(storedSums(wrk), expectedRows(confirmed(chain)))
})

test('syncBlockStats adapts to an upstream that serves shorter pages', async (t) => {
  const chain = makeChain(90)
  const wrk = makeWrk(chain.slice(0, 40), { pageSize: 10 })
  await wrk.syncBlockStats()
  t.alike(storedSums(wrk), expectedRows(confirmed(chain.slice(0, 40))))

  wrk.chain = chain
  await wrk.syncBlockStats()

  t.alike(storedSums(wrk), expectedRows(confirmed(chain)))
  t.is(wrk._blockStatsPageSize, 10)
})

test('syncBlockStats keeps what it has when a block is missing upstream', async (t) => {
  const chain = makeChain(60)
  const wrk = makeWrk(chain.slice(0, 30))
  await wrk.syncBlockStats()
  const before = JSON.stringify([...wrk.rows])

  const errors = silenceErrors(t)
  wrk.chain = chain.filter((block) => block.height !== FIRST_HEIGHT + 24)
  await wrk.syncBlockStats()

  t.is(JSON.stringify([...wrk.rows]), before, 'nothing past the hole is stored')
  t.is(errors[0][1], 'ERR_BLOCK_STATS_SYNC')

  wrk.chain = chain
  await wrk.syncBlockStats()
  t.alike(storedSums(wrk), expectedRows(confirmed(chain)), 'the walk resumes once the block is served')
})

test('syncBlockStats stops while upstream is rate limiting and resumes after', async (t) => {
  const chain = makeChain(70)
  const wrk = makeWrk(chain)
  const getBlocks = wrk.mempoolApi.getBlocks
  wrk.mempoolApi.getBlocks = async (height) => {
    if (wrk.pageCalls.length === 1) wrk._apiPausedUntil = Date.now() + 60000
    return getBlocks(height)
  }

  await wrk.syncBlockStats()
  t.is(wrk.pageCalls.length, 2)
  t.absent(wrk.state.backfilledToTs)

  wrk._apiPausedUntil = 0
  await wrk.syncBlockStats()
  t.alike(storedSums(wrk), expectedRows(confirmed(chain)))
})

test('syncBlockStats logs and releases the lock when the tip cannot be read', async (t) => {
  const wrk = makeWrk(makeChain(30))
  wrk.mempoolApi.getBlockHeight = async () => null
  const errors = silenceErrors(t)

  await wrk.syncBlockStats()

  t.is(errors[0][1], 'ERR_BLOCK_STATS_SYNC')
  t.is(wrk.rows.size, 0)
  t.is(wrk._blockStatsSyncRunning, false)
})

test('syncBlockStats skips while a previous run is still going', async (t) => {
  const wrk = makeWrk(makeChain(30))
  wrk._blockStatsSyncRunning = true

  await wrk.syncBlockStats()

  t.alike(wrk.pageCalls, [])
  t.is(wrk.state, null)
})

test('syncBlockStats resumes the backfill when the history start moves earlier', async (t) => {
  const chain = makeChain(60)
  const wrk = makeWrk(chain)
  await wrk.syncBlockStats()

  wrk.state = { ...wrk.state, backfilledToTs: BLOCK_STATS_START_TS + MS_1_HOUR }
  wrk.pageCalls = []
  await wrk.syncBlockStats()

  t.ok(wrk.pageCalls.length > 0)
  t.is(wrk.state.backfilledToTs, BLOCK_STATS_START_TS)
  t.alike(storedSums(wrk), expectedRows(confirmed(chain)))
})

test('isBlockUnservable is true only for an upstream that answered and could not', (t) => {
  t.ok(isBlockUnservable(httpError(500)))
  t.ok(isBlockUnservable(httpError(404)))
  t.absent(isBlockUnservable(httpError(429)))
  t.absent(isBlockUnservable(httpError(502)))
  t.absent(isBlockUnservable(httpError(503)))
  t.absent(isBlockUnservable(new Error('ETIMEDOUT')))
  t.absent(isBlockUnservable(new Error('ERR_BLOCK_STATS_INVALID_BLOCK')))
})

test('isPageUnusable also covers a page that answers without its block', (t) => {
  t.ok(isPageUnusable(httpError(500)))
  t.ok(isPageUnusable(new Error('ERR_BLOCK_STATS_EMPTY_PAGE')))
  t.absent(isPageUnusable(new Error('ERR_BLOCK_STATS_INVALID_PAGE')))
  t.absent(isPageUnusable(new Error('ERR_BLOCK_STATS_INVALID_BLOCK')))
  t.absent(isPageUnusable(httpError(503)))
})

test('addLateBlockToRow adds a block inside the covered span exactly once', (t) => {
  const ts = BLOCK_STATS_START_TS
  const block = (height) => ({ height, ts, reward: 100, totalFees: 10, size: 1000 })
  const row = addBlocksToRow(null, ts, [block(10), block(12)])

  const healed = addLateBlockToRow(row, ts, block(11))
  t.alike(healed, {
    ts, blockCount: 3, blockRewardSum: 300, blockTotalFeesSum: 30, blockSizeSum: 3000, minHeight: 10, maxHeight: 12, lateHeights: [11]
  })
  t.is(addLateBlockToRow(healed, ts, block(11)), healed, 'a replay changes nothing')
  t.is(row.blockCount, 2, 'the stored row is not mutated')

  t.alike(addLateBlockToRow(null, ts, block(11)), {
    ts, blockCount: 1, blockRewardSum: 100, blockTotalFeesSum: 10, blockSizeSum: 1000, minHeight: 11, maxHeight: 11, lateHeights: [11]
  })
})

test('syncBlockStats walks past a block upstream cannot serve', async (t) => {
  const chain = makeChain(70)
  const wrk = makeWrk(chain)
  const brokenHeight = FIRST_HEIGHT + 40
  wrk.broken.add(brokenHeight)
  const errors = silenceErrors(t)

  await wrk.syncBlockStats()

  const served = confirmed(chain).filter((block) => block.height !== brokenHeight)
  t.alike(storedSums(wrk), expectedRows(served), 'every other block is counted, history reaches the start')
  t.is(wrk.state.backfilledToTs, BLOCK_STATS_START_TS)
  t.alike(Object.keys(wrk.state.skipped), [String(brokenHeight)])
  t.ok(wrk.state.skipped[brokenHeight] > Date.now() + BLOCK_STATS_SKIPPED_RETRY_MS - 60000)
  t.is(wrk.blockCalls.length, BLOCK_STATS_PAGE_SIZE, 'only the failing page is read block by block')
  t.ok(errors.some((args) => String(args[1]).includes(`ERR_BLOCK_STATS_BLOCK_UNAVAILABLE height=${brokenHeight}`)))
})

test('syncBlockStats reads a block the page leaves out, in history and near the tip', async (t) => {
  const chain = makeChain(90)
  const wrk = makeWrk(chain.slice(0, 60))
  wrk.holes.add(FIRST_HEIGHT + 30)
  wrk.holes.add(FIRST_HEIGHT + 70)

  await wrk.syncBlockStats()
  t.alike(storedSums(wrk), expectedRows(confirmed(chain.slice(0, 60))), 'the hole is filled from the single-block read')
  t.is(wrk.state.backfilledToTs, BLOCK_STATS_START_TS, 'history is not stalled at the hole')

  wrk.chain = chain
  await wrk.syncBlockStats()
  t.alike(storedSums(wrk), expectedRows(confirmed(chain)))
  t.absent(wrk.state.skipped && Object.keys(wrk.state.skipped).length)
  t.absent(wrk._blockStatsPageSize, 'the page size narrowed on the way to the hole is not kept')
})

test('syncBlockStats skips a block that is missing from its page and cannot be read alone', async (t) => {
  const chain = makeChain(70)
  const wrk = makeWrk(chain)
  const holeHeight = FIRST_HEIGHT + 30
  wrk.holes.add(holeHeight)
  wrk.unservedHoles = new Set([holeHeight])
  silenceErrors(t)

  await wrk.syncBlockStats()

  t.alike(storedSums(wrk), expectedRows(confirmed(chain).filter((block) => block.height !== holeHeight)))
  t.alike(Object.keys(wrk.state.skipped), [String(holeHeight)])
  t.is(wrk.state.backfilledToTs, BLOCK_STATS_START_TS)
})

test('syncBlockStats keeps a first-run cursor from wiping other sync state', async (t) => {
  const wrk = makeWrk(makeChain(40))
  wrk.state = { skipped: { 5: 1 } }
  silenceErrors(t)

  await wrk.syncBlockStats()

  t.ok(Number.isInteger(wrk.state.maxHeight))
  t.is(wrk.state.skipped[5], 1)
})

test('_getBlockStat refuses a block that is not the height asked for', async (t) => {
  const chain = makeChain(10)
  const wrk = makeWrk(chain)
  wrk.mempoolApi.getBlockHash = async () => chain[3].id

  await t.exception(wrk._getBlockStat(FIRST_HEIGHT + 5), /ERR_BLOCK_STATS_HEIGHT_MISMATCH/)
})

test('syncBlockStats adds a skipped block once upstream serves it again', async (t) => {
  const chain = makeChain(70)
  const wrk = makeWrk(chain)
  const brokenHeight = FIRST_HEIGHT + 40
  wrk.broken.add(brokenHeight)
  silenceErrors(t)
  await wrk.syncBlockStats()

  wrk.broken.clear()
  wrk.blockCalls = []
  await wrk.syncBlockStats()
  t.alike(wrk.blockCalls, [], 'not retried before its wait is over')

  wrk.state = { ...wrk.state, skipped: { [brokenHeight]: Date.now() - 1 } }
  await wrk.syncBlockStats()
  t.alike(wrk.blockCalls, [brokenHeight])
  t.alike(storedSums(wrk), expectedRows(confirmed(chain)), 'the day is complete again')
  t.alike(wrk.state.skipped, {})

  wrk.state = { ...wrk.state, skipped: { [brokenHeight]: Date.now() - 1 } }
  await wrk.syncBlockStats()
  t.alike(storedSums(wrk), expectedRows(confirmed(chain)), 'a replayed retry does not count it twice')
})

test('syncBlockStats keeps waiting on a block that is still unavailable', async (t) => {
  const chain = makeChain(70)
  const wrk = makeWrk(chain)
  const brokenHeight = FIRST_HEIGHT + 40
  wrk.broken.add(brokenHeight)
  silenceErrors(t)
  await wrk.syncBlockStats()
  const before = JSON.stringify([...wrk.rows])

  wrk.state = { ...wrk.state, skipped: { [brokenHeight]: Date.now() - 1 } }
  await wrk.syncBlockStats()

  t.is(JSON.stringify([...wrk.rows]), before)
  t.ok(wrk.state.skipped[brokenHeight] > Date.now(), 'pushed back for another day')
})

test('syncBlockStats skips a broken block near the tip too', async (t) => {
  const chain = makeChain(90)
  const wrk = makeWrk(chain.slice(0, 40))
  await wrk.syncBlockStats()

  const brokenHeight = FIRST_HEIGHT + 50
  wrk.broken.add(brokenHeight)
  wrk.chain = chain
  silenceErrors(t)
  await wrk.syncBlockStats()

  t.alike(storedSums(wrk), expectedRows(confirmed(chain).filter((block) => block.height !== brokenHeight)))
  t.alike(Object.keys(wrk.state.skipped), [String(brokenHeight)])
  t.is(wrk.state.maxHeight, chain[chain.length - 1].height - BLOCK_STATS_CONFIRMATIONS)
})

test('syncBlockStats skips nothing when upstream fails block after block', async (t) => {
  const chain = makeChain(70)
  const wrk = makeWrk(chain)
  for (const block of chain.slice(30, 45)) wrk.broken.add(block.height)
  const errors = silenceErrors(t)

  await wrk.syncBlockStats()

  t.ok(errors.some((args) => String(args[2]).includes('ERR_BLOCK_STATS_UPSTREAM_UNHEALTHY')))
  t.absent(wrk.state.skipped, 'an unwell upstream is waited out, not skipped over')
  t.absent(wrk.state.backfilledToTs)

  wrk.broken.clear()
  await wrk.syncBlockStats()
  t.alike(storedSums(wrk), expectedRows(confirmed(chain)))
})

test('syncBlockStats does not fall back or skip on gateway and network errors', async (t) => {
  for (const status of [502, 503, 429, undefined]) {
    const chain = makeChain(70)
    const wrk = makeWrk(chain)
    wrk.broken.add(FIRST_HEIGHT + 40)
    wrk.brokenStatus = status
    silenceErrors(t)

    await wrk.syncBlockStats()

    t.alike(wrk.blockCalls, [], `no block-by-block read on ${status}`)
    t.absent(wrk.state.skipped)
    t.absent(wrk.state.backfilledToTs)
  }
})

test('getBlockHash reads the plain-text hash for a height', async (t) => {
  const hash = '000000000000000000000c51455703cde1758cd47e34fc903e95e592fadb21b0'
  const calls = []
  const api = new MempoolApi({
    get: async (path, opts) => {
      calls.push({ path, opts })
      return { body: `${hash}\n` }
    }
  })

  t.is(await api.getBlockHash(975644), hash)
  t.alike(calls, [{ path: '/block-height/975644', opts: { encoding: 'text' } }])
})

test('getBlockHash rejects anything that is not a block hash', async (t) => {
  for (const body of ['', '<html>Bad Gateway</html>', 'Block height out of range', 'abc123', undefined]) {
    const api = new MempoolApi({ get: async () => ({ body }) })
    await t.exception(api.getBlockHash(1), /ERR_BLOCK_HASH_INVALID/)
  }
})

test('getWrkExtData serves the hourly block stats store', async (t) => {
  const wrk = Object.create(WrkMempoolRack.prototype)
  const calls = []
  wrk._getDbData = async (key, query) => {
    calls.push({ key, query })
    return [{ ts: 1 }]
  }

  const query = { key: HISTORICAL_BLOCK_STATS_DATA_KEY, start: 1, end: 2, limit: 3 }
  const res = await wrk.getWrkExtData({ query })

  t.alike(res, [{ ts: 1 }])
  t.alike(calls, [{ key: STAT_KEY, query }])
})

test('_getDbRow reads one row by timestamp and closes the bee', async (t) => {
  const wrk = Object.create(WrkMempoolRack.prototype)
  let closed = 0
  const stored = new Map([[Buffer.from([0, 0, 0, 0, 0, 7]).toString('hex'), { ts: 7, blockCount: 2 }]])
  wrk._getBee = async (name) => {
    t.is(name, STAT_KEY)
    return {
      get: async (key) => {
        const row = stored.get(key.toString('hex'))
        return row ? { value: Buffer.from(JSON.stringify(row)) } : null
      },
      close: async () => { closed++ }
    }
  }

  t.alike(await wrk._getDbRow(STAT_KEY, 7), { ts: 7, blockCount: 2 })
  t.is(await wrk._getDbRow(STAT_KEY, 8), null)
  t.is(closed, 2)
})
