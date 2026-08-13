/**
 * install-hook trust policy (guardrails spec §8.4 / registry gap #1).
 *
 * entries.trust_level is publisher-influenced, so the saga honors it only for a
 * platform-curated org and caps every other org. Uses the default config
 * (curated: @clerum,@evenfire; cap: mid).
 */
import { describe, expect, it } from 'vitest'
import { resolveHookTrustLevel } from '../registry.js'

const entry = (name: string, trust_level: string) => ({ name, trust_level })

describe('resolveHookTrustLevel', () => {
  it('honors the column for a curated org', () => {
    expect(resolveHookTrustLevel(entry('@clerum/pii-redact', 'high'))).toBe('high')
    expect(resolveHookTrustLevel(entry('@evenfire/scan', 'mid'))).toBe('mid')
  })

  it('caps a non-curated org at the default cap (mid) — a self-published high is NOT honored', () => {
    // The exact §8.4 gap: @acme self-tagged its way to trust_level high.
    expect(resolveHookTrustLevel(entry('@acme/pii-redact', 'high'))).toBe('mid')
  })

  it('a non-curated org below the cap keeps its lower level (min of column and cap)', () => {
    expect(resolveHookTrustLevel(entry('@acme/scan', 'low'))).toBe('low')
    expect(resolveHookTrustLevel(entry('@acme/scan', 'mid'))).toBe('mid')
  })

  it('an unscoped name (no @org/) is treated as non-curated and capped', () => {
    expect(resolveHookTrustLevel(entry('pii-redact', 'high'))).toBe('mid')
  })

  it('a missing/blank trust_level defaults to low', () => {
    expect(resolveHookTrustLevel(entry('@clerum/x', ''))).toBe('low')
  })
})
