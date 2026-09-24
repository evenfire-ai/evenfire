import { createHash } from 'node:crypto'

/** Longest bucket key, in UTF-8 bytes, that the rate limiters store as given. */
export const MAX_RATE_LIMIT_BUCKET_KEY_BYTES = 512

const LONG_KEY_PREFIX = 'sha256-long-key:'

/**
 * The form of a bucket key that both limiter backends store.
 *
 * Several key builders include a value the client submits (an email, a login,
 * a token prefix, a route parameter). Without a bound, an unauthenticated
 * client can send one oversized value per request: Postgres rejects the upsert
 * (the btree entry limit is 2704 bytes), so the request falls through to the
 * process-memory counter, which keeps each key for its whole window. A key over
 * `MAX_RATE_LIMIT_BUCKET_KEY_BYTES` is therefore replaced by its SHA-256. The
 * same input always gives the same stored key, so an oversized value is still
 * counted and limited like any other; only its size changes. Keys at or under
 * the bound are returned unchanged, so existing buckets keep their keys.
 */
export function boundedBucketKey(key: string): string {
  if (Buffer.byteLength(key, 'utf8') <= MAX_RATE_LIMIT_BUCKET_KEY_BYTES) return key
  return `${LONG_KEY_PREFIX}${createHash('sha256').update(key).digest('hex')}`
}
