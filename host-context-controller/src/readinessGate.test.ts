import { describe, expect, it, vi } from 'vitest'
import {
  type ReadinessInventoryDetail,
  isProbeReadinessAuthoritative,
  probeReadinessReasonsFromDetail,
  readinessReasonsFromDetail,
  resolveHostAuthoritativeFn,
  resolveProbeAuthoritativeFn,
  resolveProviderAuthoritativeFn,
  resolveReadinessDetailFn,
} from './readinessGate'

function authoritativeDetail(
  overrides: Partial<ReadinessInventoryDetail> = {}
): ReadinessInventoryDetail {
  return {
    stopped: false,
    mcpServerCacheSynced: true,
    contextCacheSynced: true,
    hostCacheSynced: true,
    safetyInventoryCertified: true,
    contextRevisionAligned: true,
    serverRevisionAligned: true,
    ...overrides,
  }
}

describe('resolveProviderAuthoritativeFn (dev-mode readiness gate — B1)', () => {
  it('dev provider (no watcher) is unconditionally authoritative', () => {
    // Regression for R3-B1: main.ts left this undefined for DevMcpServerProvider,
    // so the ContextMapperServer fail-closed default (() => false) pinned /ready
    // and every /api/v1/* endpoint at 503 forever in dev mode. There is no
    // NetworkPolicy inventory to certify in dev, so authority must be granted.
    expect(resolveProviderAuthoritativeFn(null)()).toBe(true)
  })

  it('production watcher delegates to the live inventory certification', () => {
    let asked = false
    const watcher = {
      isReadinessInventoryAuthoritative: () => {
        asked = true
        return false
      },
    }
    // Delegates (returns the watcher's verdict) rather than a constant.
    expect(resolveProviderAuthoritativeFn(watcher)()).toBe(false)
    expect(asked).toBe(true)
    watcher.isReadinessInventoryAuthoritative = () => true
    expect(resolveProviderAuthoritativeFn(watcher)()).toBe(true)
  })
})

describe('resolveHostAuthoritativeFn (dev-mode desktop gate — R2-M1)', () => {
  it('dev provider (no watcher) is unconditionally authoritative', () => {
    // Regression for R2-M1: main.ts left this undefined for DevMcpServerProvider,
    // so the ContextMapperServer fail-closed default (() => false) pinned every
    // /api/v1/desktop/* response at 503 after setReady(true) — where the base
    // answered 200 {status:'inactive'}. There is no Host inventory to certify in
    // dev, so authority must mirror the provider gate and be granted.
    expect(resolveHostAuthoritativeFn(null)()).toBe(true)
  })

  it('production watcher delegates to the live Host inventory certification', () => {
    let asked = false
    const watcher = {
      isHostInventoryAuthoritative: () => {
        asked = true
        return false
      },
    }
    // Delegates (returns the watcher's verdict) rather than a constant.
    expect(resolveHostAuthoritativeFn(watcher)()).toBe(false)
    expect(asked).toBe(true)
    watcher.isHostInventoryAuthoritative = () => true
    expect(resolveHostAuthoritativeFn(watcher)()).toBe(true)
  })
})

describe('resolveReadinessDetailFn', () => {
  it('omits detail when there is no watcher', () => {
    expect(resolveReadinessDetailFn(null)).toBeUndefined()
  })

  it('delegates to the watcher inventory detail', () => {
    const detail = authoritativeDetail({ mcpServerCacheSynced: false })
    const watcher = { getReadinessInventoryDetail: () => detail }
    expect(resolveReadinessDetailFn(watcher)?.()).toEqual(detail)
  })
})

describe('readinessReasonsFromDetail', () => {
  it('returns no reasons when every inventory clause is true', () => {
    expect(readinessReasonsFromDetail(authoritativeDetail())).toEqual([])
  })

  it('maps each false clause to a closed reason key', () => {
    expect(readinessReasonsFromDetail(authoritativeDetail({ stopped: true }))).toEqual([
      'controller_stopped',
    ])
    expect(
      readinessReasonsFromDetail(authoritativeDetail({ mcpServerCacheSynced: false }))
    ).toEqual(['mcp_watch_unsynced'])
    expect(readinessReasonsFromDetail(authoritativeDetail({ contextCacheSynced: false }))).toEqual([
      'context_watch_unsynced',
    ])
    expect(readinessReasonsFromDetail(authoritativeDetail({ hostCacheSynced: false }))).toEqual([
      'host_watch_unsynced',
    ])
    expect(
      readinessReasonsFromDetail(authoritativeDetail({ safetyInventoryCertified: false }))
    ).toEqual(['safety_pass_uncertified'])
    expect(
      readinessReasonsFromDetail(authoritativeDetail({ contextRevisionAligned: false }))
    ).toEqual(['revocation_revision_mismatch'])
    expect(
      readinessReasonsFromDetail(authoritativeDetail({ serverRevisionAligned: false }))
    ).toEqual(['revocation_revision_mismatch'])
  })
})

describe('isProbeReadinessAuthoritative (A1-T01)', () => {
  it('stays authoritative when only phase-2 certification is down', () => {
    expect(
      isProbeReadinessAuthoritative(
        authoritativeDetail({
          safetyInventoryCertified: false,
          contextRevisionAligned: false,
          serverRevisionAligned: false,
        })
      )
    ).toBe(true)
  })

  it.each([
    ['stopped', { stopped: true }],
    ['mcpServerCacheSynced', { mcpServerCacheSynced: false }],
    ['contextCacheSynced', { contextCacheSynced: false }],
    ['hostCacheSynced', { hostCacheSynced: false }],
  ] as const)('is false when probe clause %s is flipped', (_name, override) => {
    expect(isProbeReadinessAuthoritative(authoritativeDetail(override))).toBe(false)
  })
})

describe('resolveProbeAuthoritativeFn', () => {
  it('A1-T02 does not call the 6-clause inventory predicate', () => {
    const sixClause = vi.fn(() => false)
    const watcher = {
      getReadinessInventoryDetail: () =>
        authoritativeDetail({
          safetyInventoryCertified: false,
          contextRevisionAligned: false,
          serverRevisionAligned: false,
        }),
      isReadinessInventoryAuthoritative: sixClause,
    }
    expect(resolveProbeAuthoritativeFn(watcher)()).toBe(true)
    expect(sixClause).not.toHaveBeenCalled()
  })

  it('A1-T03 grants authority when there is no watcher (R3-B1)', () => {
    expect(resolveProbeAuthoritativeFn(null)()).toBe(true)
  })

  it('A1-T14 re-reads inventory detail on every invocation', () => {
    let detail = authoritativeDetail({ safetyInventoryCertified: false })
    const watcher = { getReadinessInventoryDetail: () => detail }
    const probeFn = resolveProbeAuthoritativeFn(watcher)
    expect(probeFn()).toBe(true)
    detail = { ...detail, hostCacheSynced: false }
    expect(probeFn()).toBe(false)
    detail = { ...detail, hostCacheSynced: true }
    expect(probeFn()).toBe(true)
  })
})

describe('probeReadinessReasonsFromDetail (A1-T04)', () => {
  it('emits only the host watch reason when phase-2 clauses are also down', () => {
    expect(
      probeReadinessReasonsFromDetail(
        authoritativeDetail({
          hostCacheSynced: false,
          safetyInventoryCertified: false,
          contextRevisionAligned: false,
        })
      )
    ).toEqual(['host_watch_unsynced'])
  })
})
