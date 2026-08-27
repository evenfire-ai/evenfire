/**
 * U4 seam — per-user connection partitioning for oauth mcp-servers.
 *
 * Invariants pinned here (mini-spec 03, spec §U4):
 *  - SHARED sentinel never collides with a real userId (T2 property-test).
 *  - Catalog dedup by serverName across N per-user partitions.
 *  - Fail-closed: oauth-user + undefined/'anonymous' userId → no token, no forward.
 *  - Identity isolation: user A's partition/Bearer is never used for user B.
 *  - Revocation purge: detachServer removes every ClientKey of that serverName.
 *  - Reconcile no-change branch preserves live per-user partitions.
 *  - Keyspace property-tests on the re-keyed manager (T2).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import type { McpServerInfo } from '../../types'
import { createBrokerTokenProvider } from '../brokerTokenProvider'
import type { McpTokenProvider } from '../client'
import {
  McpManager,
  type McpPrincipal,
  type McpTokenProviderFactory,
  SHARED_PRINCIPAL,
  serializeClientKey,
  serverNameFromClientKey,
  userPrincipal,
} from '../manager'

// ─── SDK mocks (constructable; capture per-transport headers) ────────────────

interface MockTransport {
  requestHeaders: Record<string, string>
  close: ReturnType<typeof vi.fn>
}

const sdk: {
  transports: MockTransport[]
  callToolImpl: ((headers: Record<string, string>) => Promise<unknown>) | null
  connectImpl: (() => Promise<void>) | null
} = { transports: [], callToolImpl: null, connectImpl: null }

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class MockClient {
    private transport: MockTransport | null = null
    connect = vi.fn(async (t: MockTransport) => {
      this.transport = t
      if (sdk.connectImpl) await sdk.connectImpl()
    })
    close = vi.fn().mockResolvedValue(undefined)
    listTools = vi.fn(async () => ({
      tools: [{ name: 'do', description: 'demo tool', inputSchema: { type: 'object' } }],
    }))
    callTool = vi.fn(async () => {
      const headers = this.transport?.requestHeaders ?? {}
      if (sdk.callToolImpl) return sdk.callToolImpl(headers)
      return { content: [{ type: 'text', text: 'ok' }], authorization: headers['Authorization'] }
    })
  },
}))

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class MockStreamable {
    requestHeaders: Record<string, string>
    close = vi.fn().mockResolvedValue(undefined)
    constructor(_url: URL, opts?: { requestInit?: { headers?: Record<string, string> } }) {
      this.requestHeaders = opts?.requestInit?.headers ?? {}
      sdk.transports.push(this as unknown as MockTransport)
    }
  },
}))

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: class MockSSE {
    close = vi.fn().mockResolvedValue(undefined)
  },
}))

// ─── Helpers ─────────────────────────────────────────────────────────────────

function oauthUserServer(name = 'gh'): McpServerInfo {
  return {
    name,
    contextRef: 'ctx-1',
    transport: { type: 'streamableHttp', url: `http://${name}/mcp` },
    // HCC v2 inventory shape: the seam dispatches on authKind, not auth/oauth.
    authKind: 'oauth-user',
    enabled: true,
    status: { deployed: true, ready: true },
  }
}

function oauthContextServer(name = 'ctx-gh'): McpServerInfo {
  return {
    name,
    contextRef: 'ctx-1',
    transport: { type: 'streamableHttp', url: `http://${name}/mcp` },
    // Shared-identity oauth: the seam routes every caller to ONE SHARED partition.
    authKind: 'oauth-context',
    enabled: true,
    status: { deployed: true, ready: true },
  }
}

/** Records (server, principal) each provider was built for and the tokens it hands out. */
function recordingFactory(): {
  factory: McpTokenProviderFactory
  built: Array<{ server: string; principal: string }>
} {
  const built: Array<{ server: string; principal: string }> = []
  const factory: McpTokenProviderFactory = (
    server: McpServerInfo,
    principal: McpPrincipal
  ): McpTokenProvider => {
    if (principal.kind === 'shared') {
      built.push({ server: server.name, principal: 'shared' })
      return { resolve: async () => undefined, refresh: async () => undefined }
    }
    const uid = principal.userId
    built.push({ server: server.name, principal: uid })
    const token = `token-for-${uid}`
    return { resolve: async () => token, refresh: async () => token }
  }
  return { factory, built }
}

/** A tool call whose entry and completion can be observed/controlled by the test. */
function gatedCall(): {
  entered: Promise<void>
  enter: () => void
  gate: Promise<void>
  release: () => void
} {
  let enterResolve!: () => void
  const entered = new Promise<void>(r => (enterResolve = r))
  let gateResolve!: () => void
  const gate = new Promise<void>(r => (gateResolve = r))
  return { entered, enter: () => enterResolve(), gate, release: () => gateResolve() }
}

beforeEach(() => {
  sdk.transports = []
  sdk.callToolImpl = null
  sdk.connectImpl = null
})

// ─── T2 · SHARED sentinel property-test ──────────────────────────────────────

describe('ClientKey — SHARED sentinel never collides with a real userId', () => {
  it('no userId string serializes to the SHARED key (fuzz)', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (serverName, userId) => {
        const sharedKey = serializeClientKey(serverName, SHARED_PRINCIPAL)
        const userKey = serializeClientKey(serverName, userPrincipal(userId))
        expect(userKey).not.toBe(sharedKey)
      })
    )
  })

  it('sentinel-lookalike userIds never collide with the SHARED key', () => {
    // fc.string() effectively never emits the values that could plausibly
    // collide (the 's' discriminator, the 'shared' word, the serverName, or the
    // serialized shared key itself), so pin them explicitly: the ['u',…] vs
    // ['s',…] tuple discriminator must keep every real user distinct from SHARED.
    const serverName = 'srv'
    const sharedKey = serializeClientKey(serverName, SHARED_PRINCIPAL)
    const adversarial = ['s', 'shared', 'SHARED', '', ' ', serverName, 'u', sharedKey]
    for (const userId of adversarial) {
      expect(serializeClientKey(serverName, userPrincipal(userId))).not.toBe(sharedKey)
    }
  })

  it('serialization is injective over (serverName, principal) and round-trips serverName', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.string(), (serverName, a, b) => {
        const ka = serializeClientKey(serverName, userPrincipal(a))
        const kb = serializeClientKey(serverName, userPrincipal(b))
        // distinct users → distinct keys; same user → same key
        expect(ka === kb).toBe(a === b)
        // serverName round-trips out of either flavor of key
        expect(serverNameFromClientKey(ka)).toBe(serverName)
        expect(serverNameFromClientKey(serializeClientKey(serverName, SHARED_PRINCIPAL))).toBe(
          serverName
        )
      })
    )
  })
})

// ─── Catalog dedup ───────────────────────────────────────────────────────────

describe('Catalog dedup by serverName across per-user partitions', () => {
  it('N per-user partitions of one oauth server yield the tool once', async () => {
    const { factory } = recordingFactory()
    const manager = new McpManager(undefined, undefined, factory)
    await manager.addServer(oauthUserServer())

    // Lazily admit two per-user partitions.
    await manager.callTool('gh__do', {}, { userId: 'alice' })
    await manager.callTool('gh__do', {}, { userId: 'bob' })

    expect(manager.getAllTools().map(t => t.name)).toEqual(['gh__do'])
    expect(manager.getConnectedServers()).toEqual(['gh'])
    expect(manager.hasConnectedServers()).toBe(true)
    // describeCapabilities counts by serverName, not by live connection.
    expect(manager.describeCapabilities()).toContain('access to 1 MCP server(s)')
  })
})

// ─── Fail-closed ─────────────────────────────────────────────────────────────

describe('Fail-closed: oauth-user with no/anonymous userId', () => {
  it('undefined userId never resolves a token nor forwards the call', async () => {
    const { factory, built } = recordingFactory()
    const manager = new McpManager(undefined, undefined, factory)
    await manager.addServer(oauthUserServer())
    const transportsAfterRepresentative = sdk.transports.length

    const res = await manager.callTool('gh__do', {}, {})
    expect(res.isError).toBe(true)
    expect(String((res.result as { error: string }).error)).toMatch(/auth/i)
    // No per-user provider built, no new transport opened (call not forwarded).
    expect(built.filter(b => b.principal !== 'shared')).toEqual([])
    expect(sdk.transports.length).toBe(transportsAfterRepresentative)
  })

  it("'anonymous' userId is rejected the same way", async () => {
    const { factory, built } = recordingFactory()
    const manager = new McpManager(undefined, undefined, factory)
    await manager.addServer(oauthUserServer())

    const res = await manager.callTool('gh__do', {}, { userId: 'anonymous' })
    expect(res.isError).toBe(true)
    expect(built.filter(b => b.principal !== 'shared')).toEqual([])
  })
})

// ─── Identity isolation ──────────────────────────────────────────────────────

describe('Identity isolation: A partition never serves B', () => {
  it('each per-user connection carries only its own Bearer token', async () => {
    const { factory } = recordingFactory()
    const manager = new McpManager(undefined, undefined, factory)
    await manager.addServer(oauthUserServer())

    const a = await manager.callTool('gh__do', {}, { userId: 'alice' })
    const b = await manager.callTool('gh__do', {}, { userId: 'bob' })

    expect((a.result as { authorization?: string }).authorization).toBe('Bearer token-for-alice')
    expect((b.result as { authorization?: string }).authorization).toBe('Bearer token-for-bob')

    // The representative connection carries NO Authorization (token-less catalog).
    const authHeaders = sdk.transports.map(t => t.requestHeaders['Authorization'])
    expect(authHeaders).toContain(undefined)
    expect(authHeaders).toContain('Bearer token-for-alice')
    expect(authHeaders).toContain('Bearer token-for-bob')
    // Alice's token is never present on more than her own connection.
    expect(authHeaders.filter(h => h === 'Bearer token-for-alice')).toHaveLength(1)
  })

  it('re-calling as the same user reuses the partition (no second connection)', async () => {
    const { factory } = recordingFactory()
    const manager = new McpManager(undefined, undefined, factory)
    await manager.addServer(oauthUserServer())

    await manager.callTool('gh__do', {}, { userId: 'alice' })
    const transportsAfterFirst = sdk.transports.length
    await manager.callTool('gh__do', {}, { userId: 'alice' })
    expect(sdk.transports.length).toBe(transportsAfterFirst)
  })
})

// ─── Broker principal binding (PR #319 C2/H1) ────────────────────────────────
//
// End-to-end proof of the load-bearing invariant: the userId a tool call
// carries (options.userId — the authenticated task sender, see
// toolRegistryAdapter) is the SAME value the mcp-host POSTs to the control-api
// broker as the grant subject. Composes the REAL manager with the REAL
// brokerTokenProvider (only the network `fetch` is stubbed); the broker
// principal is NEVER a hand-minted fixture. control-api trusting that body
// userId is the documented seam — mcp-host's contract is that it only ever
// sends the caller's own identity.

describe('Broker principal binding: POST subject is the caller, never crossed', () => {
  /** Factory wiring the REAL broker provider for user principals, mirroring
   *  main.ts createMcpTokenProviderFactory grantScope='user': user → broker
   *  (server, userId); SHARED → token-less catalog representative. Captures every
   *  broker POST body so the test asserts what identity actually left the host. */
  function brokerFactory(): {
    factory: McpTokenProviderFactory
    bodies: Array<{ mcpServerName?: string; userId?: string; contextId?: string }>
  } {
    const bodies: Array<{ mcpServerName?: string; userId?: string; contextId?: string }> = []
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { userId?: string }
      bodies.push(body)
      return {
        status: 200,
        json: async () => ({ token: `tok-for-${body.userId}`, expiresAt: null }),
      } as unknown as Response
    })
    const factory: McpTokenProviderFactory = (server, principal) =>
      principal.kind === 'user'
        ? createBrokerTokenProvider(
            server,
            { userId: principal.userId },
            {
              gatewayUrl: () => 'http://gateway:8092',
              controlToken: () => 'control-jwt',
              fetchImpl: fetchImpl as unknown as typeof fetch,
            }
          )
        : { resolve: async () => undefined, refresh: async () => undefined }
    return { factory, bodies }
  }

  it('the userId POSTed to the broker equals the callTool userId (per caller)', async () => {
    const { factory, bodies } = brokerFactory()
    const manager = new McpManager(undefined, undefined, factory)
    await manager.addServer(oauthUserServer())

    await manager.callTool('gh__do', {}, { userId: 'alice' })
    await manager.callTool('gh__do', {}, { userId: 'bob' })

    // Every broker exchange carries exactly the caller's own identity — no other.
    expect(bodies).toContainEqual({ mcpServerName: 'gh', userId: 'alice' })
    expect(bodies).toContainEqual({ mcpServerName: 'gh', userId: 'bob' })
    expect(bodies.every(b => b.userId === 'alice' || b.userId === 'bob')).toBe(true)
    // Alice's identity is emitted once; bob's connect never POSTs alice's userId.
    expect(bodies.filter(b => b.userId === 'alice')).toHaveLength(1)

    // And the resolved Bearer lands only on that caller's own connection.
    const authHeaders = sdk.transports.map(t => t.requestHeaders['Authorization'])
    expect(authHeaders).toContain('Bearer tok-for-alice')
    expect(authHeaders).toContain('Bearer tok-for-bob')
    expect(authHeaders.filter(h => h === 'Bearer tok-for-alice')).toHaveLength(1)
  })

  it('never POSTs a userId for the token-less SHARED catalog representative', async () => {
    const { factory, bodies } = brokerFactory()
    const manager = new McpManager(undefined, undefined, factory)
    // addServer opens the SHARED representative (catalog population) with no user.
    await manager.addServer(oauthUserServer())

    // No per-user call yet → the representative must not have brokered any grant.
    expect(bodies).toEqual([])
  })
})

// ─── oauth-context dispatch (U6-host: shared identity) ───────────────────────
//
// The load-bearing invariant of the oauth-context sabor (manager.callTool
// `isOauthUser = authKind === 'oauth-user'`, factory main.ts:844): a context
// server routes EVERY caller to the single SHARED partition — it never opens a
// per-user partition, and that one connection carries the context Bearer. All
// other manager tests use oauthUserServer; without this case a regression that
// per-user-partitioned a context server, or dropped its context Bearer, would
// stay green (R1-M2, T5).

describe('oauth-context routes every caller to the single SHARED partition', () => {
  /** Mirrors main.ts createMcpTokenProviderFactory for authKind='oauth-context':
   *  the SHARED representative itself resolves the (context) token; NO per-user
   *  provider is ever built. Records every (server, principal) built. */
  function contextFactory(): {
    factory: McpTokenProviderFactory
    built: Array<{ server: string; principal: string }>
  } {
    const built: Array<{ server: string; principal: string }> = []
    const factory: McpTokenProviderFactory = (server, principal) => {
      built.push({
        server: server.name,
        principal: principal.kind === 'shared' ? 'shared' : principal.userId,
      })
      // Even the SHARED representative of a context server carries the context
      // Bearer (unlike oauth-user, whose representative is token-less).
      return { resolve: async () => 'context-bearer', refresh: async () => 'context-bearer' }
    }
    return { factory, built }
  }

  it('alice and bob reuse one SHARED connection with the context Bearer, no per-user partition', async () => {
    const { factory, built } = contextFactory()
    const manager = new McpManager(undefined, undefined, factory)
    await manager.addServer(oauthContextServer())
    // addServer opened exactly the SHARED representative.
    const transportsAfterRepresentative = sdk.transports.length

    const a = await manager.callTool('ctx-gh__do', {}, { userId: 'alice' })
    const b = await manager.callTool('ctx-gh__do', {}, { userId: 'bob' })

    // (b) Both callers succeed on the SAME shared connection — no new transport.
    expect(a.isError).toBe(false)
    expect(b.isError).toBe(false)
    expect(sdk.transports.length).toBe(transportsAfterRepresentative)

    // (c) That one connection carries the context Bearer for both callers.
    expect((a.result as { authorization?: string }).authorization).toBe('Bearer context-bearer')
    expect((b.result as { authorization?: string }).authorization).toBe('Bearer context-bearer')

    // (a) No per-user partition was ever built — only the SHARED representative,
    // and it is not idle-evictable (the per-user eviction sweep is a no-op).
    expect(built.every(x => x.principal === 'shared')).toBe(true)
    expect(manager.getConnectedServers()).toEqual(['ctx-gh'])
    expect(manager.evictIdleUserPartitions(0)).toBe(0)
    expect(manager.getConnectedServers()).toEqual(['ctx-gh'])
  })
})

// ─── Revocation purge ────────────────────────────────────────────────────────

describe('Revocation: detachServer purges every ClientKey of the serverName', () => {
  it('removes representative + all per-user partitions from all maps', async () => {
    const { factory } = recordingFactory()
    const manager = new McpManager(undefined, undefined, factory)
    await manager.addServer(oauthUserServer())
    await manager.callTool('gh__do', {}, { userId: 'alice' })
    await manager.callTool('gh__do', {}, { userId: 'bob' })
    expect(manager.getConnectedServers()).toEqual(['gh'])

    await manager.detachServer('gh')()

    expect(manager.getConnectedServers()).toEqual([])
    expect(manager.getAllTools()).toEqual([])
    expect(manager.hasConnectedServers()).toBe(false)
    expect(manager.status.get('gh')).toBeUndefined()
  })
})

// ─── LRU + TTL eviction of per-user partitions ───────────────────────────────

describe('evictIdleUserPartitions — TTL sweep (mini-spec §6)', () => {
  it('evicts idle per-user partitions but keeps the SHARED representative', async () => {
    const { factory } = recordingFactory()
    const manager = new McpManager(undefined, undefined, factory)
    await manager.addServer(oauthUserServer())
    await manager.callTool('gh__do', {}, { userId: 'alice' })
    await manager.callTool('gh__do', {}, { userId: 'bob' })

    // maxIdleMs=0 → every per-user partition is past TTL; SHARED is exempt.
    const evicted = manager.evictIdleUserPartitions(0)
    expect(evicted).toBe(2)

    // Representative survives → catalog and connectivity intact.
    expect(manager.getConnectedServers()).toEqual(['gh'])
    expect(manager.getAllTools().map(t => t.name)).toEqual(['gh__do'])

    // A later call re-admits the evicted partition lazily.
    const transportsBefore = sdk.transports.length
    await manager.callTool('gh__do', {}, { userId: 'alice' })
    expect(sdk.transports.length).toBe(transportsBefore + 1)
  })

  it('never evicts a partition with an in-flight tool call (TTL and LRU passes)', async () => {
    const { factory } = recordingFactory()
    const manager = new McpManager(undefined, undefined, factory)
    await manager.addServer(oauthUserServer())

    // Hold a tool call open, and signal when it has actually entered client.callTool.
    let enteredResolve!: () => void
    const entered = new Promise<void>(r => (enteredResolve = r))
    let releaseCall!: () => void
    const gate = new Promise<void>(r => (releaseCall = r))
    sdk.callToolImpl = async () => {
      enteredResolve()
      await gate
      return { content: [{ type: 'text', text: 'ok' }] }
    }

    const inFlight = manager.callTool('gh__do', {}, { userId: 'alice' })
    await entered // refcount is now > 0

    // Both eviction passes must skip the in-flight partition.
    expect(manager.evictIdleUserPartitions(0)).toBe(0)
    expect(manager.evictIdleUserPartitions(0, 0)).toBe(0)
    expect(manager.getConnectedServers()).toEqual(['gh'])

    releaseCall()
    await inFlight

    // Once the call completes the partition is eligible again.
    expect(manager.evictIdleUserPartitions(0)).toBe(1)
  })

  it('does not evict a re-admitted partition mid-call after a force-eviction (H1 race)', async () => {
    const { factory } = recordingFactory()
    const manager = new McpManager(undefined, undefined, factory)
    await manager.addServer(oauthUserServer())

    const callA = gatedCall()
    const callB = gatedCall()
    const queue = [callA, callB]
    sdk.callToolImpl = async () => {
      const call = queue.shift()
      if (!call) throw new Error('unexpected extra callTool')
      call.enter()
      await call.gate
      return { content: [{ type: 'text', text: 'ok' }] }
    }

    // Call A (alice) in flight.
    const aPromise = manager.callTool('gh__do', {}, { userId: 'alice' })
    await callA.entered

    // Force-evict alice's partition (config change → replaceServer → evictPartitionsExcept).
    await manager.replaceServer(oauthUserServer())

    // Re-admit alice as call B, held open (fresh partition + fresh in-flight token set).
    const bPromise = manager.callTool('gh__do', {}, { userId: 'alice' })
    await callB.entered

    // A completes: its finally must remove ONLY A's token, not zero B's set.
    callA.release()
    await aPromise

    // B is still in flight → must NOT be evicted by either pass.
    expect(manager.evictIdleUserPartitions(0)).toBe(0)
    expect(manager.evictIdleUserPartitions(0, 0)).toBe(0)
    expect(manager.getConnectedServers()).toEqual(['gh'])

    callB.release()
    await bPromise
    // Now B is done → evictable.
    expect(manager.evictIdleUserPartitions(0)).toBe(1)
  })
})

// ─── Representative self-heal (class-a transient failure) ────────────────────

describe('Representative connect failure self-heals on retry (mini-spec §5, class-a)', () => {
  it('re-admits a ready oauth server after a transient representative failure', async () => {
    const { factory } = recordingFactory()
    const manager = new McpManager(undefined, undefined, factory)

    // First representative connect fails transiently; second succeeds.
    let fail = true
    sdk.connectImpl = async () => {
      if (fail) {
        fail = false
        throw new Error('transient connect failure')
      }
    }

    await expect(manager.addServer(oauthUserServer())).rejects.toThrow(/transient/)
    // Not connected, but recorded as known inventory (so it is not deleted and
    // stays retryable — the reconcile "not-connected-but-ready → addServer"
    // branch fires again on the next poll rather than wedging on serverState).
    expect(manager.getConnectedServers()).toEqual([])
    expect(manager.getKnownServers()).toEqual(['gh'])
    expect(manager.status.get('gh')?.state).toBe('failed')

    // Retry (what the next reconcile poll does) → self-heals.
    const outcome = await manager.addServer(oauthUserServer())
    expect(outcome).toBe('applied')
    expect(manager.getConnectedServers()).toEqual(['gh'])
    expect(manager.getAllTools().map(t => t.name)).toEqual(['gh__do'])
  })
})

// ─── Reconcile no-change branch preserves partitions ─────────────────────────

describe('Reconcile no-change preserves live per-user partitions', () => {
  it('re-admitting the identical server config keeps existing partitions', async () => {
    const { factory } = recordingFactory()
    const manager = new McpManager(undefined, undefined, factory)
    const server = oauthUserServer()
    await manager.addServer(server)
    await manager.callTool('gh__do', {}, { userId: 'alice' })
    const transportsBefore = sdk.transports.length

    // Identical config → "already connected" no-op branch (mirrors the reconcile
    // no-change branch that only records serverState).
    const outcome = await manager.addServer({ ...server })
    expect(outcome).toBe('applied')

    // Alice's partition survives: another call reuses it (no new connection).
    await manager.callTool('gh__do', {}, { userId: 'alice' })
    expect(sdk.transports.length).toBe(transportsBefore)
    expect(manager.getConnectedServers()).toEqual(['gh'])
  })
})

// ─── R4-M3 · detachServer purges the `clients` map for EVERY ClientKey ────────
//
// The "detachServer purges every ClientKey" invariant was only pinned via the
// `byServer` projections (getConnectedServers/getAllTools). Removing
// `this.clients.delete(key)` from detachServer leaves byServer cleared (so those
// projections stay green) while stale clients survive in the private `clients`
// map. The observable of a surviving key: a later admission that SHOULD open a
// fresh connection instead silently reuses the stale client. Re-admitting the
// same server + users after a detach must therefore open a FULL set of fresh
// connections (representative + each per-user partition).

describe('R4-M3 — detachServer purges the clients map for every ClientKey', () => {
  it('a re-admitted server + users open fresh connections (no stale ClientKey reused)', async () => {
    const { factory } = recordingFactory()
    const manager = new McpManager(undefined, undefined, factory)
    await manager.addServer(oauthUserServer())
    await manager.callTool('gh__do', {}, { userId: 'alice' })
    await manager.callTool('gh__do', {}, { userId: 'bob' })

    await manager.detachServer('gh')()

    // Count only connections opened AFTER the detach.
    sdk.transports = []
    await manager.addServer(oauthUserServer()) // SHARED representative
    await manager.callTool('gh__do', {}, { userId: 'alice' }) // per-user partition
    await manager.callTool('gh__do', {}, { userId: 'bob' }) // per-user partition

    // Exactly 3 fresh connections: representative + alice + bob. If detachServer
    // left any ClientKey (SHARED or per-user) in `clients`, that partition would
    // reuse its stale client and open fewer than 3 (removing clients.delete →
    // representative re-enters via replaceServer + both users reuse stale → 1).
    expect(sdk.transports.length).toBe(3)
  })
})

// ─── R4-M4 · replaceServer keeps the SHARED representative (keepKey) alive ─────
//
// evictPartitionsExcept skips `keepKey` (the freshly-installed SHARED
// representative). Removing `if (key === keepKey) continue` evicts it too, but
// that mutant is MASKED whenever a per-user partition exists (M2's
// representativeClient fallback returns the per-user client, so
// getConnectedServers/getAllTools stay green). This test pins the invariant with
// ZERO per-user partitions, where nothing can mask an evicted representative.
//
// NOTE (interdependence with M2, not fixed here): if a per-user partition were
// present, the M2 fallback would keep getConnectedServers green even with the
// representative evicted — this test deliberately holds no per-user partition so
// it pins keepKey directly given the current code.

describe('R4-M4 — replaceServer keeps the SHARED representative alive', () => {
  it('the SHARED representative survives the swap (no per-user partitions to mask it)', async () => {
    const { factory } = recordingFactory()
    const manager = new McpManager(undefined, undefined, factory)
    await manager.addServer(oauthUserServer())

    // No per-user calls: the only ClientKey is the SHARED representative.
    const outcome = await manager.replaceServer(oauthUserServer())
    expect(outcome).toBe('applied')

    // Representative survived → catalog + connectivity intact. With the keepKey
    // skip removed, evictPartitionsExcept would delete the SHARED key and both
    // would be empty.
    expect(manager.getConnectedServers()).toEqual(['gh'])
    expect(manager.getAllTools().map(t => t.name)).toEqual(['gh__do'])
  })
})

// ─── R4-M5 · a terminal McpAuthError evicts the per-user partition (T5) ────────
//
// The PR body states a terminal McpAuthError "then evicts the partition", but no
// test pinned it: removing `this.evictPartition(key)` from callTool's McpAuthError
// branch stayed green. The McpAuthError is produced by the REAL client (a 401 that
// survives its single forced-refresh retry — T1, never hand-minted). Observable of
// the eviction: the NEXT call by the same user must RE-ADMIT a fresh partition
// (a fresh factory build), instead of reusing the still-connected stale client.

describe('R4-M5 — a terminal McpAuthError evicts the per-user partition', () => {
  it('re-admits the per-user partition on the next call after a terminal 401', async () => {
    const { factory, built } = recordingFactory()
    const manager = new McpManager(undefined, undefined, factory)
    await manager.addServer(oauthUserServer())

    // callTool throws a structured 401 on both the initial call and the client's
    // single forced-refresh retry → the real client raises a terminal
    // McpAuthError(401), which the manager treats as a terminal auth failure.
    let phase: '401' | 'ok' = '401'
    sdk.callToolImpl = async () => {
      if (phase === '401') {
        const err = new Error('http 401') as Error & { code: number }
        err.code = 401
        throw err
      }
      return { content: [{ type: 'text', text: 'ok' }] }
    }

    const first = await manager.callTool('gh__do', {}, { userId: 'alice' })
    expect(first.isError).toBe(true)
    expect(first.connectRequired).toEqual({ mcpServerName: 'gh' })
    // Alice's partition was admitted exactly once so far (the 401 reconnect reuses
    // the same tokenProvider — it does NOT rebuild via the manager factory).
    expect(built.filter(b => b.principal === 'alice')).toHaveLength(1)

    // The partition must have been evicted → the next call RE-ADMITS alice (a
    // second factory build). Without evictPartition, the still-connected stale
    // client is reused and no second admission happens.
    phase = 'ok'
    const second = await manager.callTool('gh__do', {}, { userId: 'alice' })
    expect(second.isError).toBe(false)
    expect(built.filter(b => b.principal === 'alice')).toHaveLength(2)
  })
})
