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
import {
  contentEgressRequiresHighTrust,
  isContentBearingHook,
  resolveHookTrustLevel,
} from '../registry.js'

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

describe('content-bearing classification (§8.4/§8.7)', () => {
  it('moderate/postCallSuccess/onError are always content-bearing', () => {
    expect(isContentBearingHook(['moderate'])).toBe(true)
    expect(isContentBearingHook(['postCallSuccess'])).toBe(true)
    expect(isContentBearingHook(['onError'])).toBe(true)
  })

  it('preCall is content-bearing by default and when content, but NOT when metadata', () => {
    expect(isContentBearingHook(['preCall'])).toBe(true) // absent ⇒ conservative
    expect(isContentBearingHook(['preCall'], 'content')).toBe(true)
    expect(isContentBearingHook(['preCall'], 'metadata')).toBe(false)
  })

  it('contentAccess: metadata cannot make an inherently-content point content-free', () => {
    expect(isContentBearingHook(['moderate'], 'metadata')).toBe(true)
    expect(isContentBearingHook(['preCall', 'moderate'], 'metadata')).toBe(true)
  })

  it('an empty/unknown point set is not content-bearing', () => {
    expect(isContentBearingHook([])).toBe(false)
    expect(isContentBearingHook(undefined)).toBe(false)
    expect(isContentBearingHook(['somethingElse'])).toBe(false)
  })
})

describe('content/egress separation gate (§8.4)', () => {
  // The hole fix A closes: a preCall/onError egress hook below high trust must be refused.
  it('preCall + egress at mid trust → requires high (blocked)', () => {
    expect(
      contentEgressRequiresHighTrust({
        lifecyclePoints: ['preCall'],
        hasEgress: true,
        isRemote: false,
        trustLevel: 'mid',
      })
    ).toBe(true)
  })

  it('onError + remote target at low trust → requires high (blocked)', () => {
    expect(
      contentEgressRequiresHighTrust({
        lifecyclePoints: ['onError'],
        hasEgress: false,
        isRemote: true,
        trustLevel: 'low',
      })
    ).toBe(true)
  })

  it('moderate + egress at high trust → allowed', () => {
    expect(
      contentEgressRequiresHighTrust({
        lifecyclePoints: ['moderate'],
        hasEgress: true,
        isRemote: false,
        trustLevel: 'high',
      })
    ).toBe(false)
  })

  it('content WITHOUT egress at low trust → allowed (can see content, cannot exfiltrate)', () => {
    expect(
      contentEgressRequiresHighTrust({
        lifecyclePoints: ['preCall'],
        hasEgress: false,
        isRemote: false,
        trustLevel: 'low',
      })
    ).toBe(false)
  })

  it('egress WITHOUT content at low trust → allowed (nothing to leak)', () => {
    expect(
      contentEgressRequiresHighTrust({
        lifecyclePoints: [],
        hasEgress: true,
        isRemote: false,
        trustLevel: 'low',
      })
    ).toBe(false)
  })

  it('preCall metadata-only shaper + egress at low trust → allowed (content-free, B)', () => {
    expect(
      contentEgressRequiresHighTrust({
        lifecyclePoints: ['preCall'],
        contentAccess: 'metadata',
        hasEgress: true,
        isRemote: false,
        trustLevel: 'low',
      })
    ).toBe(false)
  })
})
