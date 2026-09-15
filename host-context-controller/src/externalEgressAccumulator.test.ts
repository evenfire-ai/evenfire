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

  it('preserves resolved-at on a DNS failure instead of inventing a fresh resolution time', () => {
    const r1 = accumulateHostExactHostEgress(baseInput({ resolution: ok(['140.82.112.3'], 15) }))
    const r2 = accumulateHostExactHostEgress(
      baseInput({
        resolution: { kind: 'transient' },
        previousAnnotations: r1.annotations,
        now: T0 + 400_000,
      })
    )
    expect(r2.annotations[RESOLVED_AT_ANNOTATION]).toBe(new Date(T0).toISOString())
    expect(r2.resolvedAt).toBe(new Date(T0).toISOString())
  })

  it('derives resolved-at from proven structured state when the legacy timestamp is absent', () => {
    const r1 = accumulateHostExactHostEgress(baseInput({ resolution: ok(['140.82.112.3'], 15) }))
    const previousAnnotations = { ...r1.annotations }
    delete previousAnnotations[RESOLVED_AT_ANNOTATION]
    const r2 = accumulateHostExactHostEgress(
      baseInput({
        resolution: { kind: 'transient' },
        previousAnnotations,
        now: T0 + 400_000,
      })
    )
    expect(r2.resolvedAt).toBe(new Date(T0).toISOString())
    expect(r2.annotations[RESOLVED_AT_ANNOTATION]).toBe(new Date(T0).toISOString())
  })

  it('does not synthesize resolved-at for a bootstrap failure', () => {
    const r = accumulateHostExactHostEgress(baseInput({ resolution: { kind: 'transient' } }))
    expect(r.annotations[RESOLVED_AT_ANNOTATION]).toBeUndefined()
    expect(r.resolvedAt).toBeUndefined()
  })

  it('does not claim a DNS timestamp for legacy portless state during a failure', () => {
    const r = accumulateHostExactHostEgress(
      baseInput({
        resolution: { kind: 'transient' },
        previousAnnotations: {
          [TARGETS_ANNOTATION]: 'api.github.com=140.82.112.9/32',
        },
      })
    )
    expect(r.cidrs).toEqual(['140.82.112.9/32'])
    expect(r.resolvedAt).toBeUndefined()
    expect(r.annotations[RESOLVED_AT_ANNOTATION]).toBeUndefined()
  })
})
