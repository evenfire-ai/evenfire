import { describe, expect, it } from 'vitest'
import { parseEntityChangeFrame } from '../entityChangeStream'

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

  it('turns unknown versions and event types into a full safe resynchronization', () => {
    expect(
      parseEntityChangeFrame(
        JSON.stringify({ schemaVersion: 2, type: 'future.event', cursor: CURSOR })
      )
    ).toEqual({
      schemaVersion: 1,
      type: 'resync_required',
      cursor: CURSOR,
      scopes: ['gfs', 'authorization'],
    })
  })

  it('rejects malformed JSON and invalid cursors', () => {
    expect(() => parseEntityChangeFrame('{')).toThrow('Malformed entity-change frame')
    expect(() =>
      parseEntityChangeFrame(JSON.stringify({ schemaVersion: 1, type: 'heartbeat', cursor: '1' }))
    ).toThrow('Invalid entity-change cursor')
  })
})
