import { rateLimitPool } from '../db.js'

const WINDOW_MS = 60_000
type RateLimitQuery = (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>

export type RateLimitCheck = {
  allowed: boolean
  remaining: number
  resetMs: number
  windowStartMs: number
  count: number
  backendAvailable: boolean
}

export async function checkAndIncrementStrict(key: string, limit: number) {
  return checkAndIncrementStrictWithQuery(
    (text, values) => rateLimitPool.query(text, values),
    key,
    limit
  )
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
