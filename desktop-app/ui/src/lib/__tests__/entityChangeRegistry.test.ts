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
})
