import { describe, expect, it } from 'vitest'
import {
  type UserHomeConflictCode,
  type UserHomeState,
  parseUserHomeConflictDetail,
  transitionUserHomeState,
} from '../src/gfs/userHomeState.js'

const pending: UserHomeState = {
  state: 'pending',
  drive: null,
  conflictCode: null,
  conflictDetail: null,
}
const ready: UserHomeState = {
  state: 'ready',
  drive: 'main',
  conflictCode: null,
  conflictDetail: null,
}
const detail = { resourceIds: ['12345678-1234-4567-89ab-123456789abc'] }
const conflict = (code: UserHomeConflictCode): UserHomeState => ({
  state: 'conflict',
  drive: 'main',
  conflictCode: code,
  conflictDetail: detail,
})

describe('user-home lifecycle', () => {
  it('accepts the D22 IDs-only shape and rejects extra keys or non-UUID values', () => {
    const valid = {
      resourceIds: ['12345678-1234-4567-89ab-123456789abc'],
      grantIds: ['87654321-1234-4567-89ab-123456789abc'],
      shareIds: [],
    }
    expect(parseUserHomeConflictDetail(valid)).toEqual(valid)
    for (const invalid of [
      { resourceIds: valid.resourceIds, name: 'a-file.txt' },
      { resourceIds: valid.resourceIds, grantIds: ['not-a-uuid'] },
      { grantIds: valid.grantIds },
      { resourceIds: '12345678-1234-4567-89ab-123456789abc' },
    ]) {
      expect(() => parseUserHomeConflictDetail(invalid)).toThrow(
        'Invalid user-home conflict detail'
      )
    }
  })

  it('allows pending to become ready, conflict, or retired with a null drive', () => {
    expect(transitionUserHomeState(pending, { type: 'provisioned', drive: 'main' })).toEqual(ready)
    expect(
      transitionUserHomeState(pending, {
        type: 'conflict',
        drive: 'main',
        code: 'path_conflict',
        detail,
      })
    ).toEqual(conflict('path_conflict'))
    expect(transitionUserHomeState(pending, { type: 'retire' })).toEqual({
      state: 'retired',
      drive: null,
      conflictCode: null,
      conflictDetail: null,
    })
  })

  it.each(['path_conflict', 'ancestor_grant_conflict', 'ownership_conflict'] as const)(
    'allows %s to retire and clears both conflict fields',
    code => {
      expect(transitionUserHomeState(conflict(code), { type: 'retire' })).toEqual({
        state: 'retired',
        drive: 'main',
        conflictCode: null,
        conflictDetail: null,
      })
    }
  )

  it.each(['path_conflict', 'ancestor_grant_conflict'] as const)(
    'permits retry but not restore-owner for %s',
    code => {
      expect(transitionUserHomeState(conflict(code), { type: 'retry' })).toEqual({
        state: 'pending',
        drive: 'main',
        conflictCode: null,
        conflictDetail: null,
      })
      expect(() => transitionUserHomeState(conflict(code), { type: 'restore-owner' })).toThrow()
    }
  )

  it('requires restore-owner rather than retry for an ownership conflict', () => {
    expect(
      transitionUserHomeState(conflict('ownership_conflict'), { type: 'restore-owner' })
    ).toEqual(ready)
    expect(() =>
      transitionUserHomeState(conflict('ownership_conflict'), { type: 'retry' })
    ).toThrow()
  })

  it('allows an owner grant loss or retirement from ready', () => {
    expect(transitionUserHomeState(ready, { type: 'owner-grant-lost', detail })).toEqual(
      conflict('ownership_conflict')
    )
    expect(transitionUserHomeState(ready, { type: 'retire' })).toEqual({
      state: 'retired',
      drive: 'main',
      conflictCode: null,
      conflictDetail: null,
    })
  })

  it.each([
    [pending, { type: 'retry' }],
    [pending, { type: 'restore-owner' }],
    [pending, { type: 'owner-grant-lost', detail }],
    [ready, { type: 'provisioned', drive: 'main' }],
    [ready, { type: 'conflict', drive: 'main', code: 'path_conflict', detail }],
    [ready, { type: 'retry' }],
    [ready, { type: 'restore-owner' }],
    [conflict('path_conflict'), { type: 'provisioned', drive: 'main' }],
    [conflict('path_conflict'), { type: 'conflict', drive: 'main', code: 'path_conflict', detail }],
    [conflict('path_conflict'), { type: 'owner-grant-lost', detail }],
    [
      { state: 'retired', drive: null, conflictCode: null, conflictDetail: null },
      { type: 'retire' },
    ],
    [
      { state: 'retired', drive: null, conflictCode: null, conflictDetail: null },
      { type: 'retry' },
    ],
    [
      { state: 'retired', drive: null, conflictCode: null, conflictDetail: null },
      { type: 'restore-owner' },
    ],
    [
      { state: 'retired', drive: null, conflictCode: null, conflictDetail: null },
      { type: 'provisioned', drive: 'main' },
    ],
    [
      { state: 'retired', drive: null, conflictCode: null, conflictDetail: null },
      { type: 'conflict', drive: 'main', code: 'path_conflict', detail },
    ],
    [
      { state: 'retired', drive: null, conflictCode: null, conflictDetail: null },
      { type: 'owner-grant-lost', detail },
    ],
  ] as const)(
    'rejects an unsupported transition while an allowed transition succeeds',
    (current, action) => {
      expect(transitionUserHomeState(pending, { type: 'provisioned', drive: 'main' })).toEqual(
        ready
      )
      expect(() => transitionUserHomeState(current, action)).toThrow('Invalid user-home transition')
    }
  )
})
