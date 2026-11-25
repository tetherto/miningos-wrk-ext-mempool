'use strict'

const { MS_1_HOUR, HTTP_STATUS_NOT_FOUND, HTTP_STATUS_INTERNAL_ERROR } = require('./constants')

const ERR_EMPTY_PAGE = 'ERR_BLOCK_STATS_EMPTY_PAGE'

const hourBucket = (ts) => Math.floor(ts / MS_1_HOUR) * MS_1_HOUR

const toBlockStat = (block) => {
  const stat = {
    height: block?.height,
    ts: block?.timestamp * 1000,
    reward: block?.extras?.reward,
    totalFees: block?.extras?.totalFees,
    size: block?.size
  }
  if (!Object.values(stat).every(Number.isFinite)) throw new Error('ERR_BLOCK_STATS_INVALID_BLOCK')
  return stat
}

// Upstream answered, and the answer is that it cannot produce this block: a
// block its own index is broken for. Gateway errors, timeouts and rate limits
// are not this - they say nothing about the block and are simply retried.
const isBlockUnservable = (err) =>
  err?.status === HTTP_STATUS_INTERNAL_ERROR || err?.status === HTTP_STATUS_NOT_FOUND

// A page that answered but does not hold the block it was asked for: the same
// broken block, reported as a hole rather than as an error.
const isPageUnusable = (err) => isBlockUnservable(err) || err?.message === ERR_EMPTY_PAGE

// The unbroken run of blocks ending at `to`, oldest first and no lower than
// `from`. A page shorter than asked for comes back as a shorter run - never as
// a run with a hole in it, which would leave a block out of the sums for good.
const pickBlocks = (page, from, to) => {
  if (!Array.isArray(page)) throw new Error('ERR_BLOCK_STATS_INVALID_PAGE')

  const byHeight = new Map()
  for (const block of page) {
    if (Number.isInteger(block?.height)) byHeight.set(block.height, block)
  }

  const blocks = []
  for (let height = to; height >= from && byHeight.has(height); height--) {
    blocks.unshift(toBlockStat(byHeight.get(height)))
  }
  if (!blocks.length) throw new Error(ERR_EMPTY_PAGE)
  return blocks
}

const groupByHour = (blocks) => {
  const hours = new Map()
  for (const block of blocks) {
    const ts = hourBucket(block.ts)
    if (!hours.has(ts)) hours.set(ts, [])
    hours.get(ts).push(block)
  }
  return hours
}

// Heights are synced as one unbroken range that only grows at its ends, so a
// block inside the height span a row already covers has been counted before:
// re-running a page after a crash between the row write and the cursor write
// adds nothing twice.
const addBlocksToRow = (row, ts, blocks) => {
  const next = row
    ? { ...row }
    : { ts, blockCount: 0, blockRewardSum: 0, blockTotalFeesSum: 0, blockSizeSum: 0 }

  const covers = (height) => !!row && height >= row.minHeight && height <= row.maxHeight

  for (const block of blocks) {
    if (covers(block.height)) continue
    next.minHeight = next.blockCount ? Math.min(next.minHeight, block.height) : block.height
    next.maxHeight = next.blockCount ? Math.max(next.maxHeight, block.height) : block.height
    next.blockCount++
    next.blockRewardSum += block.reward
    next.blockTotalFeesSum += block.totalFees
    next.blockSizeSum += block.size
  }

  return next
}

// A block added out of order, after upstream could not serve it when its
// height was walked. It sits inside the span the row already covers, so the
// span cannot tell whether it was counted - its height is listed instead.
const addLateBlockToRow = (row, ts, block) => {
  if (row?.lateHeights?.includes(block.height)) return row
  if (!row) return { ...addBlocksToRow(null, ts, [block]), lateHeights: [block.height] }

  return {
    ...row,
    blockCount: row.blockCount + 1,
    blockRewardSum: row.blockRewardSum + block.reward,
    blockTotalFeesSum: row.blockTotalFeesSum + block.totalFees,
    blockSizeSum: row.blockSizeSum + block.size,
    minHeight: Math.min(row.minHeight, block.height),
    maxHeight: Math.max(row.maxHeight, block.height),
    lateHeights: [...(row.lateHeights || []), block.height]
  }
}

module.exports = {
  hourBucket,
  toBlockStat,
  isBlockUnservable,
  isPageUnusable,
  addLateBlockToRow,
  pickBlocks,
  groupByHour,
  addBlocksToRow
}
