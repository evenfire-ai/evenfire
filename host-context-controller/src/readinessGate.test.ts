import { describe, expect, it } from 'vitest'
import { resolveHostAuthoritativeFn, resolveProviderAuthoritativeFn } from './readinessGate'

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
