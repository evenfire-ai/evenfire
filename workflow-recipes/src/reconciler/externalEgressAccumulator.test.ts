import { describe, expect, it } from 'vitest'
import {
  RESOLVED_AT_ANNOTATION,
  STATE_ANNOTATION,
  TARGETS_ANNOTATION,
  emptyState,
  reconcileEgressState,
  serializeState,
} from '@clerum/network-policy-core'
import { accumulateExternalEgress } from './externalEgressAccumulator'
import type { ResolveResult } from './fqdnResolver'

const CONFIG = { overlapMs: 300_000, maxEntries: 128 }
const NOW = 1_000_000_000

function okResolve(
  entries: Array<{ fqdn: string; port: number; ip: string; ttlSeconds: number }>
): ResolveResult {
  return {
    resolved: entries.map(e => ({
      cidr: `${e.ip}/32`,
      port: e.port,
      reason: undefined,
      source: { kind: 'fqdn' as const, fqdn: e.fqdn },
      ttlSeconds: e.ttlSeconds,
    })),
    failures: [],
  }
}

// Build previous-round annotations by folding one OK round into empty state.
function previousAnnotations(
  entries: Array<{ fqdn: string; port: number; ip: string; ttlSeconds: number }>,
  at: number
): Record<string, string> {
  const out = reconcileEgressState(
    emptyState(),
    entries.map(e => ({
      fqdn: e.fqdn,
      port: e.port,
      kind: 'ok' as const,
      ips: [e.ip],
      ttlMs: e.ttlSeconds * 1000,
    })),
    at,
    CONFIG
  )
  return serializeState(out.state)
}

describe('accumulateExternalEgress — observation building & mapping', () => {
  it('accumulates OK resolutions into effective /32 entries and stamps annotations', () => {
    const out = accumulateExternalEgress({
      externals: [
        { fqdn: 'api.github.com', port: 443 },
        { fqdn: 'api.anthropic.com', port: 443 },
      ],
      resolveResult: okResolve([
        { fqdn: 'api.github.com', port: 443, ip: '140.82.112.3', ttlSeconds: 15 },
        { fqdn: 'api.anthropic.com', port: 443, ip: '160.79.104.10', ttlSeconds: 300 },
      ]),
      previousAnnotations: undefined,
      now: NOW,
      config: CONFIG,
    })

    expect(out.changed).toBe(true)
    expect(out.resolved.map(r => r.cidr).sort()).toEqual(['140.82.112.3/32', '160.79.104.10/32'])
    expect(out.resolved.every(r => r.source.kind === 'fqdn')).toBe(true)
    expect(out.annotations[STATE_ANNOTATION]).toBeTruthy()
    expect(out.annotations[TARGETS_ANNOTATION]).toContain('api.github.com=140.82.112.3/32')
    expect(out.annotations[RESOLVED_AT_ANNOTATION]).toBe(new Date(NOW).toISOString())
    expect(out.frozenFqdns).toEqual([])
    expect(out.overCap).toBe(false)
  })

  it('maps entry expiry off the fqdn TTL + overlap (github 15s window)', () => {
    const out = accumulateExternalEgress({
      externals: [{ fqdn: 'api.github.com', port: 443 }],
      resolveResult: okResolve([
        { fqdn: 'api.github.com', port: 443, ip: '140.82.112.3', ttlSeconds: 15 },
      ]),
      previousAnnotations: undefined,
      now: NOW,
      config: CONFIG,
    })
    expect(out.entries).toHaveLength(1)
    expect(out.entries[0].expiresAt).toBe(NOW + 15_000 + CONFIG.overlapMs)
  })
})

describe('accumulateExternalEgress — H1 fail-static under transient DNS failure', () => {
  it('FREEZES a previously-authorized fqdn whose resolution went transient', () => {
    const prev = previousAnnotations(
      [{ fqdn: 'api.github.com', port: 443, ip: '140.82.112.3', ttlSeconds: 15 }],
      NOW
    )
    const resolveResult: ResolveResult = {
      resolved: [],
      failures: [{ fqdn: 'api.github.com', error: 'ESERVFAIL', retryable: true }],
    }
    const out = accumulateExternalEgress({
      externals: [{ fqdn: 'api.github.com', port: 443 }],
      resolveResult,
      previousAnnotations: prev,
      // well past TTL + overlap: a naive window would have expired it
      now: NOW + 15_000 + CONFIG.overlapMs + 60_000,
      config: CONFIG,
    })
    // The IP is CONSERVED (frozen), not pruned.
    expect(out.resolved.map(r => r.cidr)).toEqual(['140.82.112.3/32'])
    expect(out.frozenFqdns).toContain('api.github.com')
  })
})

describe('accumulateExternalEgress — M1 renewalDue (audit #299)', () => {
  it('flags renewalDue (set unchanged) when the persisted window is within overlap/2 of lapsing', () => {
    // expiresAt = NOW + 15000 + 300000; overlap/2 = 150000. now past NOW+165000 → due.
    const prev = previousAnnotations(
      [{ fqdn: 'api.github.com', port: 443, ip: '140.82.112.3', ttlSeconds: 15 }],
      NOW
    )
    const out = accumulateExternalEgress({
      externals: [{ fqdn: 'api.github.com', port: 443 }],
      resolveResult: okResolve([
        { fqdn: 'api.github.com', port: 443, ip: '140.82.112.3', ttlSeconds: 15 },
      ]),
      previousAnnotations: prev,
      now: NOW + 200_000,
      config: CONFIG,
    })
    expect(out.changed).toBe(false)
    expect(out.renewalDue).toBe(true)
  })

  it('does NOT flag renewalDue right after a write (window fresh)', () => {
    const prev = previousAnnotations(
      [{ fqdn: 'api.github.com', port: 443, ip: '140.82.112.3', ttlSeconds: 15 }],
      NOW
    )
    const out = accumulateExternalEgress({
      externals: [{ fqdn: 'api.github.com', port: 443 }],
      resolveResult: okResolve([
        { fqdn: 'api.github.com', port: 443, ip: '140.82.112.3', ttlSeconds: 15 },
      ]),
      previousAnnotations: prev,
      now: NOW + 1000,
      config: CONFIG,
    })
    expect(out.changed).toBe(false)
    expect(out.renewalDue).toBe(false)
  })
})

describe('accumulateExternalEgress — F1 revocation of a removed fqdn (audit #299)', () => {
  it('REVOKES a fqdn removed from the declared externals, keeping the still-declared one', () => {
    // Prior state accumulated TWO fqdns.
    const prev = previousAnnotations(
      [
        { fqdn: 'api.github.com', port: 443, ip: '140.82.112.3', ttlSeconds: 15 },
        { fqdn: 'api.anthropic.com', port: 443, ip: '160.79.104.10', ttlSeconds: 300 },
      ],
      NOW
    )
    // This round the recipe declares ONLY anthropic (github was removed from spec).
    const out = accumulateExternalEgress({
      externals: [{ fqdn: 'api.anthropic.com', port: 443 }],
      resolveResult: okResolve([
        { fqdn: 'api.anthropic.com', port: 443, ip: '160.79.104.10', ttlSeconds: 300 },
      ]),
      previousAnnotations: prev,
      now: NOW + 1000, // well within the github window: a naive freeze would keep it
      config: CONFIG,
    })
    // The removed fqdn's IP is GONE (revoked immediately), not frozen forever.
    expect(out.resolved.map(r => r.cidr)).toEqual(['160.79.104.10/32'])
    expect(out.frozenFqdns).toEqual([])
  })

  it('does NOT confuse a transient failure (declared, keep) with a removal (undeclared, drop)', () => {
    const prev = previousAnnotations(
      [
        { fqdn: 'api.github.com', port: 443, ip: '140.82.112.3', ttlSeconds: 15 },
        { fqdn: 'api.anthropic.com', port: 443, ip: '160.79.104.10', ttlSeconds: 300 },
      ],
      NOW
    )
    // github is STILL declared but its DNS transiently fails → freeze (keep).
    // anthropic is REMOVED from the declared set → revoke (drop).
    const out = accumulateExternalEgress({
      externals: [{ fqdn: 'api.github.com', port: 443 }],
      resolveResult: {
        resolved: [],
        failures: [{ fqdn: 'api.github.com', error: 'ESERVFAIL', retryable: true }],
      },
      previousAnnotations: prev,
      now: NOW + 1000,
      config: CONFIG,
    })
    expect(out.resolved.map(r => r.cidr)).toEqual(['140.82.112.3/32'])
    expect(out.frozenFqdns).toEqual(['api.github.com'])
  })
})

describe('accumulateExternalEgress — permanent failure expires normally', () => {
  it('does NOT freeze a fqdn that failed permanently (no records)', () => {
    const prev = previousAnnotations(
      [{ fqdn: 'gone.example.com', port: 443, ip: '93.184.216.10', ttlSeconds: 30 }],
      NOW
    )
    const resolveResult: ResolveResult = {
      resolved: [],
      failures: [{ fqdn: 'gone.example.com', error: 'no A or AAAA records', retryable: false }],
    }
    const out = accumulateExternalEgress({
      externals: [{ fqdn: 'gone.example.com', port: 443 }],
      resolveResult,
      previousAnnotations: prev,
      now: NOW + 30_000 + CONFIG.overlapMs + 1,
      config: CONFIG,
    })
    // Past its window with an OK-eligible (permanent) round → it expires.
    expect(out.resolved).toEqual([])
    expect(out.frozenFqdns).not.toContain('gone.example.com')
  })
})

describe('accumulateExternalEgress — H4 no-op', () => {
  it('reports changed=false when the effective set is unchanged (only timestamps renew)', () => {
    const prev = previousAnnotations(
      [{ fqdn: 'api.anthropic.com', port: 443, ip: '160.79.104.10', ttlSeconds: 300 }],
      NOW
    )
    const out = accumulateExternalEgress({
      externals: [{ fqdn: 'api.anthropic.com', port: 443 }],
      resolveResult: okResolve([
        { fqdn: 'api.anthropic.com', port: 443, ip: '160.79.104.10', ttlSeconds: 300 },
      ]),
      previousAnnotations: prev,
      now: NOW + 10_000,
      config: CONFIG,
    })
    expect(out.changed).toBe(false)
    expect(out.resolved.map(r => r.cidr)).toEqual(['160.79.104.10/32'])
  })

  // H-E: a rename onto the SAME ip/port renders an identical ipBlock, so the
  // reconciler's egress-signature gate alone would skip the write and discard the
  // re-attributed state. The accumulator must report changed=true (the signal the
  // gate now also consumes) and persist the IP under the NEW fqdn, so a later
  // rotation of the new name keeps the carried-over IP's overlap grace.
  it('H-E: a rename onto the same IP/port reports changed=true and re-attributes state', () => {
    const prev = previousAnnotations(
      [{ fqdn: 'old.example.com', port: 443, ip: '1.2.3.4', ttlSeconds: 300 }],
      NOW
    )
    const out = accumulateExternalEgress({
      externals: [{ fqdn: 'new.example.com', port: 443 }],
      resolveResult: okResolve([
        { fqdn: 'new.example.com', port: 443, ip: '1.2.3.4', ttlSeconds: 300 },
      ]),
      previousAnnotations: prev,
      now: NOW + 10_000,
      config: CONFIG,
    })
    expect(out.changed).toBe(true)
    expect(out.resolved.map(r => r.cidr)).toEqual(['1.2.3.4/32'])
    expect(out.entries.map(e => e.fqdn)).toEqual(['new.example.com'])
  })
})

describe('accumulateExternalEgress — H5 rehydration', () => {
  it('rehydrates previous entries and MERGES a newly observed IP (accumulation across restart)', () => {
    const prev = previousAnnotations(
      [{ fqdn: 'api.github.com', port: 443, ip: '140.82.112.3', ttlSeconds: 15 }],
      NOW
    )
    const out = accumulateExternalEgress({
      externals: [{ fqdn: 'api.github.com', port: 443 }],
      resolveResult: okResolve([
        // GitHub rotated to a new single IP; the old one is still within window
        { fqdn: 'api.github.com', port: 443, ip: '140.82.112.4', ttlSeconds: 15 },
      ]),
      previousAnnotations: prev,
      now: NOW + 5_000,
      config: CONFIG,
    })
    expect(out.resolved.map(r => r.cidr).sort()).toEqual(['140.82.112.3/32', '140.82.112.4/32'])
    expect(out.changed).toBe(true)
  })
})

describe('accumulateExternalEgress — H3 eviction / overCap', () => {
  it('evicts to the cap NEVER rejects, and always keeps the freshly observed IP', () => {
    // Seed a previous set at the cap with old (soonest-to-expire) IPs.
    const seed = Array.from({ length: 4 }, (_, i) => ({
      fqdn: 'pool.example.com',
      port: 443,
      ip: `10.0.0.${i + 1}`,
      ttlSeconds: 10,
    }))
    const prev = previousAnnotations(seed, NOW)
    const out = accumulateExternalEgress({
      externals: [{ fqdn: 'pool.example.com', port: 443 }],
      resolveResult: okResolve([
        { fqdn: 'pool.example.com', port: 443, ip: '10.0.0.99', ttlSeconds: 10 },
      ]),
      previousAnnotations: prev,
      now: NOW + 1_000,
      config: { overlapMs: 300_000, maxEntries: 4 },
    })
    expect(out.overCap).toBe(true)
    expect(out.evicted.length).toBeGreaterThan(0)
    expect(out.entries).toHaveLength(4)
    // The freshly observed IP must survive eviction.
    expect(out.resolved.map(r => r.cidr)).toContain('10.0.0.99/32')
  })
})
