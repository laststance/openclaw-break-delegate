import type { DatabaseSync } from 'node:sqlite'
import type { ReviewReceipt } from './coordinator.js'

const pageSize = 40
// The local protocol allows 256 KiB including its JSON envelope and newline.
const pageBytes = 192 * 1024

export interface ReviewPage {
  breakId: string | null
  rows: ReviewReceipt[]
  nextCursor: string | null
}
export interface ReviewQuery {
  breakId?: string
  cursor?: string
}
interface Position {
  breakId: string
  after: number
  upper: number
}

function decode(cursor: string): Position {
  if (cursor.length > 512) throw Error('Invalid review cursor')
  const [breakId, after, upper] = JSON.parse(
    Buffer.from(cursor, 'base64url').toString('utf8'),
  ) as unknown[]
  if (
    typeof breakId !== 'string' ||
    typeof after !== 'number' ||
    !Number.isSafeInteger(after) ||
    typeof upper !== 'number' ||
    !Number.isSafeInteger(upper) ||
    after < 0 ||
    after > upper
  )
    throw Error('Invalid review cursor')
  return { breakId, after, upper }
}

/**
 * Read local receipts in immutable insertion order. The continuation pins the selected
 * break and its original upper bound, even if a new break or later receipts appear.
 * @example const first = readReviewPage(db, {})
 */
export function readReviewPage(
  db: DatabaseSync,
  query: ReviewQuery,
): ReviewPage {
  const cursor = query.cursor ? decode(query.cursor) : undefined
  if (cursor && query.breakId && cursor.breakId !== query.breakId)
    throw Error('Review cursor belongs to another break')
  const breakId =
    cursor?.breakId ??
    query.breakId ??
    db.prepare('SELECT id FROM sv_breaks ORDER BY rowid DESC LIMIT 1').get()?.id
  if (typeof breakId !== 'string')
    return { breakId: null, rows: [], nextCursor: null }
  const upper =
    cursor?.upper ??
    Number(
      db
        .prepare(
          'SELECT COALESCE(MAX(rowid),0) AS n FROM sv_reviews WHERE breakId=?',
        )
        .get(breakId)?.n,
    )
  const after = cursor?.after ?? 0
  const records = db
    .prepare(
      'SELECT rowid AS seq,breakId,sessionId,questionId,question,answer,outcome,reason,at FROM sv_reviews WHERE breakId=? AND rowid>? AND rowid<=? ORDER BY rowid LIMIT ?',
    )
    .iterate(breakId, after, upper, pageSize + 1)
  const rows: ReviewReceipt[] = []
  let last = after,
    bytes = 1024,
    nextCursor: string | null = null
  for (const record of records) {
    const { seq, ...receipt } = record
    const cost = Buffer.byteLength(JSON.stringify(receipt)) + 1
    if (rows.length >= pageSize || bytes + cost > pageBytes) {
      // A supported hook card is at most 8 bounded questions and their selected labels.
      if (!rows.length)
        throw Error('A stored receipt exceeds the local review page limit')
      nextCursor = Buffer.from(JSON.stringify([breakId, last, upper])).toString(
        'base64url',
      )
      break
    }
    rows.push(receipt as unknown as ReviewReceipt)
    bytes += cost
    last = Number(seq)
  }
  return { breakId, rows, nextCursor }
}
