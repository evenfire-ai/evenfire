import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  MAX_RATE_LIMIT_BUCKET_KEY_BYTES,
  boundedBucketKey,
} from '../src/services/rateLimitBucketKey.js'

describe('rate-limit bucket storage identity', () => {
  const aliases = [
    ['admin_codex_read:', 'admin_subscription_read:'],
    ['admin_codex_write:', 'admin_subscription_write:'],
    ['codex_oauth_callback:', 'subscription_oauth_callback:'],
  ] as const

  it.each(aliases)(
    'preserves the opaque legacy %s identity for long renamed keys',
    (oldPrefix, newPrefix) => {
      const suffix = 'fixture_'.repeat(100)
      const expected = `sha256-long-key:${createHash('sha256')
        .update(oldPrefix + suffix)
        .digest('hex')}`
      expect(boundedBucketKey(oldPrefix + suffix)).toBe(expected)
      expect(boundedBucketKey(newPrefix + suffix)).toBe(expected)
    }
  )

  it('keeps unrelated and embedded namespace text unchanged', () => {
    const key = 'unrelated:admin_subscription_read:' + 'fixture_'.repeat(100)
    expect(boundedBucketKey(key)).toBe(
      `sha256-long-key:${createHash('sha256').update(key).digest('hex')}`
    )
  })

  it('keeps already bounded neutral namespaces for the database migration', () => {
    const key = 'admin_subscription_read:fixture'
    expect(boundedBucketKey(key)).toBe(key)
  })

  it('uses the byte boundary and keeps stored keys bounded', () => {
    const oldKey = 'admin_codex_read:' + 'é'.repeat(MAX_RATE_LIMIT_BUCKET_KEY_BYTES)
    const newKey = 'admin_subscription_read:' + 'é'.repeat(MAX_RATE_LIMIT_BUCKET_KEY_BYTES)
    expect(boundedBucketKey(newKey)).toBe(boundedBucketKey(oldKey))
    expect(Buffer.byteLength(boundedBucketKey(newKey))).toBeLessThan(
      MAX_RATE_LIMIT_BUCKET_KEY_BYTES
    )
  })
})
