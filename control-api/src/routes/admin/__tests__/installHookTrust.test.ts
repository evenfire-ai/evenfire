/**
 * install-hook trust policy (guardrails spec §8.4 / registry gap #1).
 *
 * entries.trust_level is publisher-influenced, so the saga honors it only for a
 * CURATED org: the cluster's OWN org (from resolvePublishScope) and official
 * evenfire (@clerum/@evenfire) are auto-curated; CONTROL_API_CURATED_HOOK_ORGS
 * is a purely additive allowlist for OTHER third-party orgs (empty by default).
 * Every non-curated org is capped at the default cap (mid).
 */
import { describe, expect, it } from 'vitest'
import { resolveHookTrustLevel } from '../registry.js'

const entry = (name: string, trust_level: string) => ({ name, trust_level })

describe('resolveHookTrustLevel', () => {
  it('official evenfire (@clerum/@evenfire) is auto-curated regardless of cluster org', () => {
    expect(resolveHookTrustLevel(entry('@clerum/x', 'high'), null)).toBe('high')
    expect(resolveHookTrustLevel(entry('@evenfire/scan', 'high'), '@acme')).toBe('high')
  })

  it("the cluster's OWN org is auto-curated (no env entry needed)", () => {
    // @acme is this deployment's publish scope → honor its trust_level.
    expect(resolveHookTrustLevel(entry('@acme/pii-redact', 'high'), '@acme')).toBe('high')
  })

  it('a third-party org (not cluster, not evenfire, not in the env) is capped at mid', () => {
    // @acme's self-tagged high is NOT honored when it is not the cluster org.
    expect(resolveHookTrustLevel(entry('@acme/pii-redact', 'high'), '@othercorp')).toBe('mid')
    expect(resolveHookTrustLevel(entry('@acme/pii-redact', 'high'), null)).toBe('mid')
  })

  it('a capped org keeps a level below the cap (min of column and cap)', () => {
    expect(resolveHookTrustLevel(entry('@acme/scan', 'low'), null)).toBe('low')
    expect(resolveHookTrustLevel(entry('@acme/scan', 'mid'), null)).toBe('mid')
  })

  it('an unscoped name is treated as non-curated and capped', () => {
    expect(resolveHookTrustLevel(entry('pii-redact', 'high'), '@acme')).toBe('mid')
  })

  it('a missing/blank trust_level defaults to low', () => {
    expect(resolveHookTrustLevel(entry('@clerum/x', ''), null)).toBe('low')
  })
})
