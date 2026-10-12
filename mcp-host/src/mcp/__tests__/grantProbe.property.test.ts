import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { GrantExistsQuery } from '../grantExistenceClient'
import { type GrantProbeState, type McpCatalogBootstrapConfig, planProbe } from '../grantProbe'

function coord(mcpServerName: string, userId?: string): string {
  return JSON.stringify([mcpServerName, userId ?? null])
}
function coordOf(q: GrantExistsQuery): string {
  return coord(q.mcpServerName, q.userId)
}

const SERVERS = ['s1', 's2', 's3']
const USERS: (string | undefined)[] = ['u1', 'u2', undefined]

const arbQuery: fc.Arbitrary<GrantExistsQuery> = fc
  .record({
    mcpServerName: fc.constantFrom(...SERVERS),
    userId: fc.constantFrom(...USERS),
  })
  .map(({ mcpServerName, userId }) =>
    userId === undefined ? { mcpServerName } : { mcpServerName, userId }
  )

const arbQueries = fc.array(arbQuery, { maxLength: 8 })

const arbConfig: fc.Arbitrary<McpCatalogBootstrapConfig> = fc.record({
  enabled: fc.constant(true),
  waitBudgetMs: fc.constant(4000),
  probeTimeoutMs: fc.constant(2000),
  connectTimeoutMs: fc.constant(8000),
  negativeTtlMs: fc.integer({ min: 1, max: 100_000 }),
  failureTtlMs: fc.integer({ min: 1, max: 100_000 }),
  probesPerMin: fc.integer({ min: 1, max: 5 }),
  backoffMs: fc.integer({ min: 1, max: 100_000 }),
})

/** Build an arbitrary state whose caches reference some of the addressable coordinates. */
function arbState(now: number): fc.Arbitrary<GrantProbeState> {
  const allCoords = SERVERS.flatMap(s => USERS.map(u => coord(s, u)))
  const arbCoordSubset = fc.subarray(allCoords)
  const arbCoordTtlMap = fc.array(
    fc.tuple(fc.constantFrom(...allCoords), fc.integer({ min: now - 50_000, max: now + 50_000 })),
    { maxLength: allCoords.length }
  )
  return fc.record({
    absentUntil: arbCoordTtlMap.map(entries => new Map(entries)),
    failedUntil: arbCoordTtlMap.map(entries => new Map(entries)),
    inFlight: arbCoordSubset.map(cs => new Set(cs)),
    pausedUntil: fc.integer({ min: now - 50_000, max: now + 50_000 }),
    bucket: fc.record({
      windowStartMs: fc.integer({ min: now - 120_000, max: now }),
      used: fc.integer({ min: 0, max: 8 }),
    }),
  })
}

function cloneState(s: GrantProbeState): GrantProbeState {
  return {
    absentUntil: new Map(s.absentUntil),
    failedUntil: new Map(s.failedUntil),
    inFlight: new Set(s.inFlight),
    pausedUntil: s.pausedUntil,
    bucket: { ...s.bucket },
  }
}

const NOW = 1_000_000

describe('planProbe — property-based (T2)', () => {
  it('never asks a coordinate that is in-flight, negatively cached, failure-cached, or while paused', () => {
    fc.assert(
      fc.property(arbState(NOW), arbQueries, arbConfig, (state, queries, config) => {
        const r = planProbe(state, NOW, queries, config)
        const paused = NOW < state.pausedUntil
        for (const q of r.ask) {
          const c = coordOf(q)
          expect(state.inFlight.has(c)).toBe(false)
          expect(NOW < (state.failedUntil.get(c) ?? 0)).toBe(false)
          expect(NOW < (state.absentUntil.get(c) ?? 0)).toBe(false)
        }
        if (paused) expect(r.ask).toHaveLength(0)
      })
    )
  })

  it('respects the request budget: a plan asks (issues one batch) only when a window unit is free', () => {
    fc.assert(
      fc.property(arbState(NOW), arbQueries, arbConfig, (state, queries, config) => {
        const r = planProbe(state, NOW, queries, config)
        const windowExpired = NOW - state.bucket.windowStartMs >= 60_000
        const effectiveUsed = windowExpired ? 0 : state.bucket.used
        if (r.ask.length > 0) {
          expect(effectiveUsed).toBeLessThan(config.probesPerMin)
        }
      })
    )
  })

  it('is idempotent: re-planning the same queries against the resulting state asks nothing new', () => {
    fc.assert(
      fc.property(arbState(NOW), arbQueries, arbConfig, (state, queries, config) => {
        const first = planProbe(state, NOW, queries, config)
        const second = planProbe(first.state, NOW, queries, config)
        expect(second.ask).toHaveLength(0)
      })
    )
  })

  it('partitions every distinct coordinate into exactly one bucket', () => {
    fc.assert(
      fc.property(arbState(NOW), arbQueries, arbConfig, (state, queries, config) => {
        const r = planProbe(state, NOW, queries, config)
        const distinct = new Set(queries.map(coordOf))
        const buckets = [
          ...r.ask.map(coordOf),
          ...r.absentCached,
          ...r.failedCached,
          ...r.budgetExhausted,
          ...r.inFlight,
        ]
        // No coordinate appears in two buckets.
        expect(new Set(buckets).size).toBe(buckets.length)
        // The buckets cover exactly the distinct coordinates.
        expect(new Set(buckets)).toEqual(distinct)
        expect(buckets.length).toBe(distinct.size)
      })
    )
  })

  it('does not mutate the input state', () => {
    fc.assert(
      fc.property(arbState(NOW), arbQueries, arbConfig, (state, queries, config) => {
        const before = cloneState(state)
        planProbe(state, NOW, queries, config)
        expect(state.inFlight).toEqual(before.inFlight)
        expect(state.bucket).toEqual(before.bucket)
        expect(state.absentUntil).toEqual(before.absentUntil)
        expect(state.failedUntil).toEqual(before.failedUntil)
        expect(state.pausedUntil).toBe(before.pausedUntil)
      })
    )
  })

  it('is temporally monotone: advancing now never turns an asked coordinate into a skipped one', () => {
    fc.assert(
      fc.property(
        arbState(NOW),
        arbQueries,
        arbConfig,
        fc.integer({ min: 0, max: 200_000 }),
        (state, queries, config, delta) => {
          const early = planProbe(cloneState(state), NOW, queries, config)
          const late = planProbe(cloneState(state), NOW + delta, queries, config)
          const lateAsk = new Set(late.ask.map(coordOf))
          for (const q of early.ask) {
            expect(lateAsk.has(coordOf(q))).toBe(true)
          }
        }
      )
    )
  })
})
