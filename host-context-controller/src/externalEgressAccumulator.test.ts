import { describe, expect, it } from 'vitest'
import {
  RESOLVED_AT_ANNOTATION,
  STATE_ANNOTATION,
  TARGETS_ANNOTATION,
} from '@clerum/network-policy-core'
import {
  type AccumulateHostEgressInput,
  accumulateHostExactHostEgress,
} from './externalEgressAccumulator'

const CONFIG = { overlapMs: 300_000, maxEntries: 128 }
const T0 = 1_000_000_000_000 // fixed epoch ms; clock is injected, never Date.now()

function ok(ips: string[], ttlSeconds: number) {
  return { kind: 'ok' as const, ips, ttlSeconds }
}

function baseInput(
  overrides: Partial<AccumulateHostEgressInput> & Pick<AccumulateHostEgressInput, 'resolution'>
): AccumulateHostEgressInput {
  return {
    fqdn: 'api.github.com',
    port: 443,
    protocol: 'TCP',
    previousAnnotations: undefined,
    now: T0,
    config: CONFIG,
    ...overrides,
  }
}

describe('accumulateHostExactHostEgress — issue #299 sliding window (HCC)', () => {
  it('accumulates the UNION of rotating single-IP responses across rounds', () => {
    // Round 1: GitHub serves one A record.
    const r1 = accumulateHostExactHostEgress(baseInput({ resolution: ok(['140.82.112.3'], 15) }))
    expect(r1.cidrs).toEqual(['140.82.112.3/32'])
    expect(r1.changed).toBe(true)

    // Round 2 (TTL later): a DIFFERENT single A record. The effective set must be
    // the UNION, not a replacement — this is the whole fix for #299.
    const r2 = accumulateHostExactHostEgress(
      baseInput({
        resolution: ok(['140.82.112.4'], 15),
        previousAnnotations: r1.annotations,
        now: T0 + 20_000, // within the previous entry's TTL+overlap window
      })
    )
    expect(r2.cidrs).toEqual(['140.82.112.3/32', '140.82.112.4/32'])
    expect(r2.changed).toBe(true)
  })

  it('is a NO-OP (changed=false) when the same IP is re-observed (H4)', () => {
    const r1 = accumulateHostExactHostEgress(baseInput({ resolution: ok(['140.82.112.3'], 15) }))
    const r2 = accumulateHostExactHostEgress(
      baseInput({
        resolution: ok(['140.82.112.3'], 15),
        previousAnnotations: r1.annotations,
        now: T0 + 5_000, // only the timestamp advanced
      })
    )
    expect(r2.cidrs).toEqual(['140.82.112.3/32'])
    expect(r2.changed).toBe(false)
  })

  it('FREEZES the prior set on a transient failure and flags frozen (H1 fail-static)', () => {
    const r1 = accumulateHostExactHostEgress(
      baseInput({ resolution: ok(['140.82.112.3', '140.82.112.4'], 15) })
    )
    const r2 = accumulateHostExactHostEgress(
      baseInput({
        resolution: { kind: 'transient' },
        previousAnnotations: r1.annotations,
        now: T0 + 400_000, // past TTL+overlap: a naive expiry would drop these
      })
    )
    // Fail-static: transient must NOT prune — the pod keeps reaching GitHub.
    expect(r2.cidrs).toEqual(['140.82.112.3/32', '140.82.112.4/32'])
    expect(r2.frozen).toBe(true)
    expect(r2.changed).toBe(false)
  })

  it('returns an EMPTY set on a bootstrap transient (no prior) so the caller can fail loud', () => {
    const r = accumulateHostExactHostEgress(baseInput({ resolution: { kind: 'transient' } }))
    expect(r.cidrs).toEqual([])
    // No prior entries to freeze → nothing frozen; caller treats empty-bootstrap as failure.
    expect(r.frozen).toBe(false)
  })

  it('PRUNES expired entries on a permanent (genuine no-records) result', () => {
    const r1 = accumulateHostExactHostEgress(baseInput({ resolution: ok(['140.82.112.3'], 15) }))
    const r2 = accumulateHostExactHostEgress(
      baseInput({
        resolution: { kind: 'permanent' },
        previousAnnotations: r1.annotations,
        now: T0 + 400_000, // past TTL+overlap; permanent = subject to expiry
      })
    )
    expect(r2.cidrs).toEqual([])
  })

  it('rehydrates the legacy host=ip/32 targets annotation and freezes it on transient (H5)', () => {
    const legacy = { [TARGETS_ANNOTATION]: 'api.github.com=140.82.112.9/32' }
    const r = accumulateHostExactHostEgress(
      baseInput({ resolution: { kind: 'transient' }, previousAnnotations: legacy })
    )
    // Legacy set must NOT be blanked — it is rehydrated and frozen under transient.
    expect(r.cidrs).toEqual(['140.82.112.9/32'])
    expect(r.frozen).toBe(true)
  })

  it('evicts down to the cap (H3) instead of rejecting, and flags overCap', () => {
    const r = accumulateHostExactHostEgress(
      baseInput({
        resolution: ok(['1.1.1.1', '2.2.2.2', '3.3.3.3'], 15),
        config: { overlapMs: 300_000, maxEntries: 2 },
      })
    )
    expect(r.cidrs).toHaveLength(2)
    expect(r.overCap).toBe(true)
    expect(r.evicted).toBe(1)
  })

  it('flags renewalDue (set unchanged) when the persisted window is within overlap/2 of lapsing (M1)', () => {
    const r1 = accumulateHostExactHostEgress(baseInput({ resolution: ok(['140.82.112.3'], 15) }))
    // expiresAt = T0 + 15000 + 300000; overlap/2 = 150000 → due once now-T0 > 165000.
    const r2 = accumulateHostExactHostEgress(
      baseInput({
        resolution: ok(['140.82.112.3'], 15),
        previousAnnotations: r1.annotations,
        now: T0 + 200_000,
      })
    )
    expect(r2.changed).toBe(false)
    expect(r2.renewalDue).toBe(true)
  })

  it('does NOT flag renewalDue right after a write (window fresh)', () => {
    const r1 = accumulateHostExactHostEgress(baseInput({ resolution: ok(['140.82.112.3'], 15) }))
    const r2 = accumulateHostExactHostEgress(
      baseInput({
        resolution: ok(['140.82.112.3'], 15),
        previousAnnotations: r1.annotations,
        now: T0 + 1000,
      })
    )
    expect(r2.changed).toBe(false)
    expect(r2.renewalDue).toBe(false)
  })

  it('stamps both the state and resolved-at annotations for the caller to persist', () => {
    const r = accumulateHostExactHostEgress(baseInput({ resolution: ok(['140.82.112.3'], 15) }))
    expect(r.annotations[STATE_ANNOTATION]).toBeTruthy()
    expect(r.annotations[RESOLVED_AT_ANNOTATION]).toBe(new Date(T0).toISOString())
  })

  // ── issue #299 Phase 2 — provider-CIDR mode (D.2). HCC-1..6. ──
  const API_24 = [
    '192.30.252.0/22',
    '185.199.108.0/22',
    '140.82.112.0/20',
    '143.55.64.0/20',
    '20.201.28.148/32',
    '20.205.243.168/32',
    '20.87.245.6/32',
    '4.237.22.34/32',
    '4.228.31.149/32',
    '20.207.73.85/32',
    '20.27.177.116/32',
    '20.200.245.245/32',
    '20.175.192.149/32',
    '20.233.83.146/32',
    '20.29.134.17/32',
    '20.199.39.228/32',
    '20.217.135.0/32',
    '4.225.11.201/32',
    '4.208.26.200/32',
    '20.26.156.210/32',
    '172.182.252.137/32',
    '4.249.131.166/32',
    '48.202.248.39/32',
    '48.204.201.2/32',
  ]
  const stateEntries = (annotations: Record<string, string>) =>
    JSON.parse(annotations[STATE_ANNOTATION] ?? '[]') as unknown[]

  it('HCC-1: covered IPs render as ranges only; none enter the window', () => {
    const r = accumulateHostExactHostEgress(
      baseInput({ resolution: ok(['140.82.121.5', '140.82.121.6'], 15), providerRanges: API_24 })
    )
    expect(new Set(r.cidrs)).toEqual(new Set(API_24))
    expect(r.cidrs).toHaveLength(24)
    expect(r.uncoveredFreshIps).toEqual([])
    expect(stateEntries(r.annotations)).toEqual([]) // covered IPs never enter the /32 window
  })

  it('HCC-2: an uncovered fresh IP rides the window and fires the drift canary', () => {
    const r = accumulateHostExactHostEgress(
      baseInput({ resolution: ok(['140.82.121.5', '8.8.8.8'], 15), providerRanges: API_24 })
    )
    expect(new Set(r.cidrs)).toEqual(new Set([...API_24, '8.8.8.8/32']))
    expect(r.cidrs).toHaveLength(25)
    expect(r.uncoveredFreshIps).toEqual(['8.8.8.8'])
  })

  it('HCC-3 (G1): without providerRanges the output is /32 mode with no canary', () => {
    const r = accumulateHostExactHostEgress(
      baseInput({ resolution: ok(['140.82.112.3', '140.82.112.4'], 15) })
    )
    expect(r.cidrs).toEqual(['140.82.112.3/32', '140.82.112.4/32'])
    expect(r.uncoveredFreshIps).toEqual([])
    expect(r.changed).toBe(true)
  })

  it('HCC-4 (H8): steady state with a different covered IP writes nothing', () => {
    const r1 = accumulateHostExactHostEgress(
      baseInput({ resolution: ok(['140.82.121.5'], 15), providerRanges: API_24 })
    )
    const r2 = accumulateHostExactHostEgress(
      baseInput({
        resolution: ok(['140.82.121.6'], 15), // a DIFFERENT covered IP
        providerRanges: API_24,
        previousAnnotations: r1.annotations,
        now: T0 + 5_000,
      })
    )
    expect(r2.changed).toBe(false)
    expect(r2.renewalDue).toBe(false)
    expect(new Set(r2.cidrs)).toEqual(new Set(API_24))
  })

  it('HCC-5 (H8 drain): pre-existing /32s covered by new ranges drain then stop writing', () => {
    // Seed Phase-1 state with three /32 entries (no providerRanges yet).
    const seed = accumulateHostExactHostEgress(
      baseInput({ resolution: ok(['140.82.112.10', '140.82.112.11', '140.82.112.12'], 15) })
    )
    expect(seed.cidrs).toHaveLength(3)
    const ranges = ['140.82.112.0/20'] // covers all three seeded /32s
    const r1 = accumulateHostExactHostEgress(
      baseInput({
        resolution: ok(['140.82.121.9'], 15), // covered → nothing new enters the window
        providerRanges: ranges,
        previousAnnotations: seed.annotations,
        now: T0 + 320_000, // past TTL+overlap → the seeded /32s expire
      })
    )
    expect(r1.changed).toBe(true) // drain write
    expect(stateEntries(r1.annotations)).toEqual([])
    expect(r1.cidrs).toEqual(ranges)
    const r2 = accumulateHostExactHostEgress(
      baseInput({
        resolution: ok(['140.82.121.8'], 15),
        providerRanges: ranges,
        previousAnnotations: r1.annotations,
        now: T0 + 330_000,
      })
    )
    expect(r2.changed).toBe(false)
    expect(r2.cidrs).toEqual(ranges)
  })

  it('HCC-6: a transient failure keeps frozen residual /32s alongside the provider ranges', () => {
    const r1 = accumulateHostExactHostEgress(
      baseInput({ resolution: ok(['8.8.8.8', '9.9.9.9'], 15), providerRanges: API_24 })
    )
    expect(r1.uncoveredFreshIps).toEqual(['8.8.8.8', '9.9.9.9'])
    const r2 = accumulateHostExactHostEgress(
      baseInput({
        resolution: { kind: 'transient' },
        providerRanges: API_24,
        previousAnnotations: r1.annotations,
        now: T0 + 400_000, // past TTL+overlap: fail-static must freeze
      })
    )
    expect(r2.frozen).toBe(true)
    expect(new Set(r2.cidrs)).toEqual(new Set([...API_24, '8.8.8.8/32', '9.9.9.9/32']))
    expect(r2.uncoveredFreshIps).toEqual([])
  })
})
