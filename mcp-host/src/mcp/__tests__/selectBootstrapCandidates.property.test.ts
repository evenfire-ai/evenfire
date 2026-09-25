/**
 * Property tests for the PURE bootstrap classifier `selectBootstrapCandidates`
 * (spec §6.1, T2). A fuzz over server flavors, gates, factory presence, live/
 * in-flight keys and the cap explores the M1/M2/M7/M12–M14 precedence that a
 * hand-written case list cannot enumerate. Properties (per §T2):
 *   - never a local/static/disabled/not-ready/non-authoritative server;
 *   - oauth-context only when a factory is present;
 *   - never a live or in-flight key;
 *   - never a NEW oauth-user partition at/above the cap;
 *   - deterministic; and idempotent — marking the returned keys live yields ∅.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { McpServerInfo } from '../../types'
import {
  SHARED_PRINCIPAL,
  selectBootstrapCandidates,
  serializeClientKey,
  userPrincipal,
} from '../manager'

const USER = 'alice'

const arbAuthKind = fc.constantFrom<McpServerInfo['authKind']>(
  'oauth-user',
  'oauth-context',
  'static',
  undefined
)

const arbServer: fc.Arbitrary<McpServerInfo> = fc
  .record({
    name: fc.string({ minLength: 1, maxLength: 6 }).filter(s => !s.includes('"')),
    remote: fc.boolean(),
    authKind: arbAuthKind,
    enabled: fc.boolean(),
    authoritative: fc.option(fc.boolean(), { nil: undefined }),
    ready: fc.boolean(),
  })
  .map(r => ({
    name: r.name,
    transport: { type: 'streamableHttp' as const, url: `https://${r.name || 'x'}.example.com/mcp` },
    authKind: r.authKind,
    remote: r.remote,
    enabled: r.enabled,
    status: { deployed: true, authoritative: r.authoritative, ready: r.ready },
  }))

// Unique by name so each server owns one key (byServer/queries stay 1:1 with it).
const arbServers = fc.uniqueArray(arbServer, {
  maxLength: 6,
  selector: s => s.name,
})

/** The key selectBootstrapCandidates would assign a server (mirrors its logic). */
function keyOf(info: McpServerInfo): string | undefined {
  if (info.authKind === 'oauth-user') return serializeClientKey(info.name, userPrincipal(USER))
  if (info.authKind === 'oauth-context') return serializeClientKey(info.name, SHARED_PRINCIPAL)
  return undefined
}

function gateOk(info: McpServerInfo): boolean {
  return (
    info.enabled === true && info.status?.authoritative !== false && info.status?.ready === true
  )
}

describe('selectBootstrapCandidates — properties (T2)', () => {
  it('only remote oauth, gate-ok, non-live, non-in-flight servers become candidates', () => {
    fc.assert(
      fc.property(
        arbServers,
        fc.boolean(),
        fc.array(fc.nat(), { maxLength: 6 }),
        fc.array(fc.nat(), { maxLength: 6 }),
        (servers, factoryPresent, liveIdx, inflightIdx) => {
          const keys = servers.map(keyOf)
          const live = new Set(liveIdx.map(i => keys[i % Math.max(keys.length, 1)]).filter(Boolean))
          const inflight = new Set(
            inflightIdx.map(i => keys[i % Math.max(keys.length, 1)]).filter(Boolean)
          )
          const sel = selectBootstrapCandidates({
            userId: USER,
            infos: servers,
            hasLive: k => live.has(k),
            hasInFlight: k => inflight.has(k),
            factoryPresent,
            userPartitionCount: 0,
            userPartitionMax: undefined,
          })
          const byName = new Map(servers.map(s => [s.name, s]))
          for (const q of sel.queries) {
            const info = byName.get(q.mcpServerName)!
            expect(info.remote).toBe(true)
            expect(info.authKind === 'oauth-user' || info.authKind === 'oauth-context').toBe(true)
            expect(gateOk(info)).toBe(true)
            if (info.authKind === 'oauth-context') expect(factoryPresent).toBe(true)
            const key = keyOf(info)!
            expect(live.has(key)).toBe(false)
            expect(inflight.has(key)).toBe(false)
          }
        }
      )
    )
  })

  it('at/above the cap, no NEW oauth-user partition is a candidate', () => {
    fc.assert(
      fc.property(
        arbServers,
        fc.integer({ min: 0, max: 5 }),
        fc.integer({ min: 0, max: 5 }),
        (servers, count, max) => {
          const sel = selectBootstrapCandidates({
            userId: USER,
            infos: servers,
            hasLive: () => false,
            hasInFlight: () => false,
            factoryPresent: true,
            userPartitionCount: count,
            userPartitionMax: max,
          })
          const byName = new Map(servers.map(s => [s.name, s]))
          if (count >= max) {
            for (const q of sel.queries) {
              expect(byName.get(q.mcpServerName)!.authKind).not.toBe('oauth-user')
            }
          }
        }
      )
    )
  })

  it('is deterministic and idempotent (marking returned keys live ⇒ second pass empty)', () => {
    fc.assert(
      fc.property(arbServers, fc.boolean(), (servers, factoryPresent) => {
        const base = {
          userId: USER,
          infos: servers,
          hasLive: () => false,
          hasInFlight: () => false,
          factoryPresent,
          userPartitionCount: 0,
          userPartitionMax: undefined as number | undefined,
        }
        const first = selectBootstrapCandidates(base)
        const again = selectBootstrapCandidates(base)
        // Deterministic: same input, same queries.
        expect(again.queries).toEqual(first.queries)

        // Idempotent: once the returned partitions are live, nothing re-qualifies.
        const liveKeys = new Set([...first.byCoord.values()].map(c => c.key))
        const second = selectBootstrapCandidates({ ...base, hasLive: k => liveKeys.has(k) })
        expect(second.queries).toEqual([])
      })
    )
  })
})
