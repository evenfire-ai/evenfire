import { describe, expect, it } from 'vitest'
import { resolveProviderAuthoritativeFn } from './readinessGate'

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
