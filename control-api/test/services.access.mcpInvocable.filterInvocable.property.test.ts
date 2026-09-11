import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { filterInvocable } from '../src/services/access/mcpInvocable.js'

// T2 — property-based test of the PURE `filterInvocable` (mini-spec 04 §5a-c).
// No I/O: grant-presence is passed AS DATA, so the whole contract is exercised
// with generated inputs rather than a live DB.

const NS = 'mcp-server'
const AUTH_TYPES = [undefined, 'none', 'oauth', 'bearer', 'basic', 'apiKey'] as const
const EXCLUDED_AUTH = new Set(['bearer', 'basic', 'apiKey'])

type GenServer = { name: string; authType: (typeof AUTH_TYPES)[number]; enabled: boolean }

// Every generated server carries a transport.url so url-resolvability is a
// constant — invocability then turns solely on enabled/auth-type/grant, which is
// what these properties probe.
function toCR(s: GenServer) {
  return {
    metadata: { name: s.name },
    spec: {
      enabled: s.enabled,
      auth: s.authType === undefined ? undefined : { type: s.authType },
      transport: { url: `http://${s.name}.${NS}.svc:3000/mcp` },
    },
  }
}

const serverArb: fc.Arbitrary<GenServer> = fc.record({
  name: fc.constantFrom('s1', 's2', 's3', 's4', 's5', 's6'),
  authType: fc.constantFrom(...AUTH_TYPES),
  enabled: fc.boolean(),
})

// A set of servers with distinct names + an arbitrary grant-presence subset of
// those names (models the resolver's computed `Set<serverName>`).
const scenarioArb = fc
  .uniqueArray(serverArb, { selector: s => s.name, minLength: 1, maxLength: 6 })
  .chain(servers =>
    fc.record({
      servers: fc.constant(servers),
      present: fc.subarray(servers.map(s => s.name)),
    })
  )

describe('filterInvocable — pure property tests (rpc-proxy rail: grantPresence provided)', () => {
  it('(a) an OAuth server is invocable ONLY when its name is in grantPresence', () => {
    fc.assert(
      fc.property(scenarioArb, ({ servers, present }) => {
        const names = new Set(servers.map(s => s.name))
        const presence = new Set(present)
        const out = filterInvocable(names, servers.map(toCR), NS, presence)
        for (const s of servers) {
          if (s.authType === 'oauth' && !presence.has(s.name)) {
            expect(out.has(s.name)).toBe(false)
          }
        }
      })
    )
  })

  it('(b) the auth-type allowlist NEVER admits bearer/basic/apiKey, whatever the grant state', () => {
    fc.assert(
      fc.property(scenarioArb, ({ servers, present }) => {
        const names = new Set(servers.map(s => s.name))
        // Even if the name were (nonsensically) in grantPresence, it stays out.
        const presence = new Set([...present, ...servers.map(s => s.name)])
        const out = filterInvocable(names, servers.map(toCR), NS, presence)
        for (const s of servers) {
          if (s.authType && EXCLUDED_AUTH.has(s.authType)) {
            expect(out.has(s.name)).toBe(false)
          }
        }
      })
    )
  })

  it('(c) an OAuth server is invocable IFF grant present AND enabled — membership drives it', () => {
    // At the pure level, a `grantScope=context` server presents identically to a
    // `user` one: the resolver computes its presence from the SHARED key
    // (decoupled from the caller's userId, mini-spec 04 §2 3b) and hands the same
    // Set in here. That decoupling is exercised end-to-end by U6(api); here the
    // observable contract is: name ∈ grantPresence ⇔ invocable (auth/enabled ok).
    fc.assert(
      fc.property(scenarioArb, ({ servers, present }) => {
        const names = new Set(servers.map(s => s.name))
        const presence = new Set(present)
        const out = filterInvocable(names, servers.map(toCR), NS, presence)
        for (const s of servers) {
          if (s.authType !== 'oauth') continue
          const expected = presence.has(s.name) && s.enabled !== false
          expect(out.has(s.name)).toBe(expected)
        }
      })
    )
  })

  it('`none`/absent servers are never grant-gated (invocable when enabled, regardless of grantPresence)', () => {
    fc.assert(
      fc.property(scenarioArb, ({ servers }) => {
        const names = new Set(servers.map(s => s.name))
        const out = filterInvocable(names, servers.map(toCR), NS, new Set())
        for (const s of servers) {
          if (s.authType === undefined || s.authType === 'none') {
            expect(out.has(s.name)).toBe(s.enabled !== false)
          }
        }
      })
    )
  })
})

describe('filterInvocable — catalog rail (grantPresence ABSENT): allowlist only, no grant gating', () => {
  it('OAuth servers pass on the auth-type allowlist alone; bearer/basic/apiKey still excluded', () => {
    fc.assert(
      fc.property(scenarioArb, ({ servers }) => {
        const names = new Set(servers.map(s => s.name))
        const out = filterInvocable(names, servers.map(toCR), NS /* no grantPresence */)
        for (const s of servers) {
          if (s.authType === 'oauth') {
            // Not gated by any grant here — invocable purely on enabled/url.
            expect(out.has(s.name)).toBe(s.enabled !== false)
          }
          if (s.authType && EXCLUDED_AUTH.has(s.authType)) {
            expect(out.has(s.name)).toBe(false)
          }
        }
      })
    )
  })
})
