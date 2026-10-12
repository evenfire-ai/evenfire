import { describe, expect, it } from 'vitest'
import {
  ENTITY_CHANGE_MAX_FRAME_CHARS,
  parseEntityChangeFrame,
  parseEntityChangeRetryAfterMs,
} from '../entityChangeStream'

const CURSOR = 'a20c37c5-d996-48b0-8f49-a8e2f5f41234'

describe('parseEntityChangeFrame', () => {
  it('accepts only coarse invalidation scopes and never exposes other payload fields', () => {
    expect(
      parseEntityChangeFrame(
        JSON.stringify({
          schemaVersion: 1,
          type: 'scope.invalidated',
          cursor: CURSOR,
          scopes: ['gfs', 'authorization', 'forbidden'],
          entityId: 'must-not-be-forwarded',
          path: '/private/name',
        })
      )
    ).toEqual({
      schemaVersion: 1,
      type: 'scope.invalidated',
      cursor: CURSOR,
      scopes: ['gfs', 'authorization'],
    })
  })

  it('skips unknown scopes, close reasons, and forward-compatible event types', () => {
    expect(
      parseEntityChangeFrame(
        JSON.stringify({
          schemaVersion: 1,
          type: 'scope.invalidated',
          cursor: CURSOR,
          scopes: ['future-scope'],
        })
      )
    ).toBeNull()
    expect(
      parseEntityChangeFrame(
        JSON.stringify({
          schemaVersion: 1,
          type: 'stream.closing',
          cursor: CURSOR,
          reason: 'future-reason',
        })
      )
    ).toBeNull()
    expect(
      parseEntityChangeFrame(
        JSON.stringify({ schemaVersion: 1, type: 'future.event', cursor: CURSOR })
      )
    ).toBeNull()
  })

  it('rejects unsupported schemas instead of forcing a resync of visible state', () => {
    expect(() =>
      parseEntityChangeFrame(
        JSON.stringify({ schemaVersion: 2, type: 'future.event', cursor: CURSOR })
      )
    ).toThrow('Unsupported entity-change schema version')
  })

  it('rejects malformed JSON and invalid cursors', () => {
    expect(() => parseEntityChangeFrame('{')).toThrow('Malformed entity-change frame')
    expect(() =>
      parseEntityChangeFrame(JSON.stringify({ schemaVersion: 1, type: 'heartbeat', cursor: '1' }))
    ).toThrow('Invalid entity-change cursor')
  })

  it('rejects frames above the shared Desktop and Control UI limit', () => {
    const oversized = JSON.stringify({
      schemaVersion: 1,
      type: 'heartbeat',
      cursor: CURSOR,
      observedAt: 'x'.repeat(ENTITY_CHANGE_MAX_FRAME_CHARS),
    })
    expect(oversized.length).toBeGreaterThan(ENTITY_CHANGE_MAX_FRAME_CHARS)
    expect(() => parseEntityChangeFrame(oversized)).toThrow('frame exceeded its limit')
  })
})

describe('parseEntityChangeRetryAfterMs', () => {
  it('supports seconds and HTTP dates while bounding untrusted delays', () => {
    const now = Date.parse('2026-09-29T12:00:00.000Z')
    expect(parseEntityChangeRetryAfterMs('5', now)).toBe(5_000)
    expect(parseEntityChangeRetryAfterMs('Tue, 29 Sep 2026 12:00:10 GMT', now)).toBe(10_000)
    expect(parseEntityChangeRetryAfterMs('3600', now)).toBe(5 * 60 * 1000)
    expect(parseEntityChangeRetryAfterMs('not-a-date', now)).toBeUndefined()
  })
})
