import { rateLimitPool } from '../db.js'

const WINDOW_MS = 60_000
const processBuckets = new Map<string, number>()
type RateLimitQuery = (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>

export async function checkAndIncrementStrict(key: string, limit: number) {
  const count = (processBuckets.get(key) ?? 0) + 1
  processBuckets.set(key, count)
  return {
    backendAvailable: true,
    allowed: count <= limit,
    count,
    resetMs: Date.now() + WINDOW_MS,
  }
}

export async function checkAndIncrementStrictWithQuery(
  query: RateLimitQuery,
  key: string,
  limit: number
) {
  return incrementFixedWindowWithQuery(query, key, limit)
}

export async function checkAndIncrement(key: string, limit: number) {
  return checkAndIncrementWithQuery(
    (text, values) => rateLimitPool.query(text, values),
    key,
    limit
  )
}

export async function checkAndIncrementWithQuery(
  query: RateLimitQuery,
  key: string,
  limit: number
) {
  return incrementFixedWindowWithQuery(query, key, limit)
}

async function incrementFixedWindowWithQuery(query: RateLimitQuery, key: string, limit: number) {
  const { rows } = await query(
    'INSERT INTO rate_limit_buckets ... ON CONFLICT DO UPDATE SET count = count + 1',
    [key, limit]
  )
  return {
    backendAvailable: true,
    allowed: true,
    count: rows.length,
    resetMs: Date.now() + WINDOW_MS,
  }
}
