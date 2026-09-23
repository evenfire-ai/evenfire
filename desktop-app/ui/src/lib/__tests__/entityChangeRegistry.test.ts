import { describe, expect, it, vi } from 'vitest'
import { EntityChangeRegistry } from '../entityChangeRegistry'

describe('EntityChangeRegistry', () => {
  it('dispatches generic scope invalidations only to matching adapters', () => {
    const registry = new EntityChangeRegistry()
    const gfs = vi.fn()
    const authorization = vi.fn()
    registry.subscribe(['gfs'], gfs)
    registry.subscribe(['authorization'], authorization)

    registry.dispatch({
      schemaVersion: 1,
      type: 'scope.invalidated',
      cursor: '00000000-0000-0000-0000-000000000001',
      scopes: ['gfs'],
    })

    expect(gfs).toHaveBeenCalledOnce()
    expect(authorization).not.toHaveBeenCalled()
  })

  it('coalesces duplicate handler registrations for one multi-scope frame', () => {
    const registry = new EntityChangeRegistry()
    const adapter = vi.fn()
    registry.subscribe(['gfs', 'authorization'], adapter)

    registry.dispatch({
      schemaVersion: 1,
      type: 'resync_required',
      cursor: '00000000-0000-0000-0000-000000000001',
      scopes: ['gfs', 'authorization'],
    })

    expect(adapter).toHaveBeenCalledOnce()
  })

  it('invalidates all sensitive renderer state when the authenticated session expires', () => {
    const registry = new EntityChangeRegistry()
    const adapter = vi.fn()
    registry.subscribe(['gfs', 'authorization'], adapter)

    registry.dispatch({
      type: 'stream.closing',
      schemaVersion: 1,
      cursor: '00000000-0000-0000-0000-000000000001',
      reason: 'session_expired',
    })

    expect(adapter).toHaveBeenCalledWith({
      type: 'resync_required',
      schemaVersion: 1,
      cursor: '00000000-0000-0000-0000-000000000001',
      scopes: ['gfs', 'authorization'],
    })

    adapter.mockClear()
    registry.dispatch({
      type: 'stream.closing',
      schemaVersion: 1,
      cursor: '00000000-0000-0000-0000-000000000002',
      reason: 'max_lifetime',
    })
    expect(adapter).not.toHaveBeenCalled()
  })
})
