/**
 * Eager per-user catalog bootstrap (spec §6.1, invariants 1/2/5/6/7/10/11/13/17).
 * `bootstrapUserCatalog(userId)` opens the remote oauth-user partitions the user
 * already has a grant for so the FIRST turn's catalog carries their tools —
 * without a prior failed `callTool` — while staying idempotent, bounded, and
 * best-effort.
 *
 * Fixtures come from the shared helper (T1): `brokerWiring` serves BOTH the probe
 * (`/grants/exists`) and the token mint (`/user-token`) from ONE grant store, so
 * "grant exists" means the identical thing to the bootstrap's decision and to the
 * connection's Authorization; `remoteUpstream({strict:true})` is the real
 * McpClient over a spec-compliant SDK mock (401 at token-less `initialize`).
 * Assertions are observable (T4): the catalog (`getAllTools`), the transports the
 * SDK constructed, the `/grants/exists` and `/user-token` POST counts, and the
 * returned summary.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { logger } from '../../logger'
import type { McpServerInfo } from '../../types'
import { checkGrantExistence } from '../grantExistenceClient'
import type { GrantExistenceChecker, McpCatalogBootstrapConfig } from '../grantProbe'
import { McpManager } from '../manager'
import { type RemoteUpstreamState, brokerWiring } from './helpers/brokerWiring'

// Strict (Slack/Notion-like) upstream + shared state. Plain literal in a
// synchronous vi.hoisted (imports aren't resolved that early); each vi.mock
// factory dynamically imports the builder.
const sdk = vi.hoisted<RemoteUpstreamState>(() => ({
  transports: [],
  probeAuth: [],
  callToolImpl: null,
  toolCall401Count: 0,
  connectGate: null,
}))
vi.mock('@modelcontextprotocol/sdk/client/index.js', async () => {
  const { remoteUpstream } = await import('./helpers/brokerWiring')
  return remoteUpstream({ strict: true }, sdk).clientModule
})
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', async () => {
  const { remoteUpstream } = await import('./helpers/brokerWiring')
  return remoteUpstream({ strict: true }, sdk).transportModule
})
vi.mock('@modelcontextprotocol/sdk/client/sse.js', async () => {
  const { remoteUpstream } = await import('./helpers/brokerWiring')
  return remoteUpstream({ strict: true }, sdk).sseModule
})

// The real SSRF guard is exercised in clientRemoteTarget.test.ts; here it must
// never touch DNS (the SDK is mocked, so its returned fetch is never invoked).
vi.mock('../../core/net/ssrf', () => ({
  SsrfBlockedError: class SsrfBlockedError extends Error {},
  resolvePinnedPublicIp: vi.fn(async () => '203.0.113.10'),
  pinnedFetch: vi.fn(() => vi.fn(async () => new Response('{}'))),
}))

function remoteOauthUserServer(name = 'gh'): McpServerInfo {
  return {
    name,
    transport: { type: 'streamableHttp', url: `https://${name}.example.com/mcp` },
    authKind: 'oauth-user',
    remote: true,
    enabled: true,
    status: { deployed: true, ready: true },
  }
}

function bootstrapConfig(over: Partial<McpCatalogBootstrapConfig> = {}): McpCatalogBootstrapConfig {
  return {
    enabled: true,
    waitBudgetMs: 4000,
    probeTimeoutMs: 2000,
    connectTimeoutMs: 8000,
    negativeTtlMs: 15000,
    failureTtlMs: 60000,
    probesPerMin: 20,
    backoffMs: 30000,
    ...over,
  }
}

interface Gated {
  manager: McpManager
  existsCalls: ReturnType<typeof brokerWiring>['existsCalls']
  userTokenCalls: ReturnType<typeof brokerWiring>['userTokenCalls']
  failExistsWith: ReturnType<typeof brokerWiring>['failExistsWith']
  /** vi.fn wrapper around the checker so a test can assert it was NOT invoked. */
  checkerSpy: ReturnType<typeof vi.fn>
}

function gatedManager(
  grantStore: Set<string>,
  cfgOver: Partial<McpCatalogBootstrapConfig> = {},
  now?: () => number,
  userPartitionMax?: number
): Gated {
  const { deps, factory, existsCalls, userTokenCalls, failExistsWith } = brokerWiring(grantStore)
  const checkerSpy = vi.fn<GrantExistenceChecker>((queries, { timeoutMs }) =>
    checkGrantExistence({ ...deps, timeoutMs }, queries)
  )
  const manager = new McpManager(undefined, undefined, factory, {
    grantExistence: checkerSpy,
    catalogBootstrap: bootstrapConfig(cfgOver),
    userPartitionMax,
    now,
  })
  return { manager, existsCalls, userTokenCalls, failExistsWith, checkerSpy }
}

beforeEach(() => {
  sdk.transports = []
  sdk.callToolImpl = null
  sdk.toolCall401Count = 0
  sdk.connectGate = null
})

describe('bootstrapUserCatalog (spec §6.1)', () => {
  // ── invariant 1 ──
  it('exposes an oauth-user tool on the first turn (no prior callTool)', async () => {
    const grantStore = new Set(['gh:alice'])
    const { manager, existsCalls } = gatedManager(grantStore)
    await manager.addServer(remoteOauthUserServer())

    // Before the bootstrap the per-user catalog is empty (no partition yet).
    expect(manager.getAllTools()).toEqual([])

    const summary = await manager.bootstrapUserCatalog('alice')

    expect(summary.candidates).toBe(1)
    expect(summary.admitted).toBe(1)
    // Observable (T4): the tool is in the catalog and the definitions list.
    expect(manager.getAllTools().map(t => t.name)).toEqual(['gh__do'])
    // One probe; the admitted partition authenticated with alice's Bearer.
    expect(existsCalls).toEqual([[{ mcpServerName: 'gh', userId: 'alice' }]])
    expect(sdk.transports).toHaveLength(1)
    expect(sdk.transports[0]!.requestHeaders['Authorization']).toBe('Bearer tok-alice')
  })

  // ── invariant 2 ──
  it('no grant ⇒ no partition, no /user-token, no initialize', async () => {
    const grantStore = new Set<string>() // no grant
    const { manager, existsCalls, userTokenCalls } = gatedManager(grantStore)
    await manager.addServer(remoteOauthUserServer())

    const summary = await manager.bootstrapUserCatalog('alice')

    expect(summary.candidates).toBe(1)
    expect(summary.admitted).toBe(0)
    expect(summary.skipped.absent).toBe(1)
    // No connection was ever attempted → no initialize, no token minted.
    expect(sdk.transports).toEqual([])
    expect(userTokenCalls).toEqual([])
    expect(manager.getAllTools()).toEqual([])
    // The probe DID run (single source of truth for the absence).
    expect(existsCalls).toEqual([[{ mcpServerName: 'gh', userId: 'alice' }]])
  })

  // ── invariant 5 ──
  it('N concurrent + N sequential ⇒ 1 POST, 1 connect (dedup)', async () => {
    const grantStore = new Set(['gh:alice'])
    const { manager, existsCalls } = gatedManager(grantStore)
    await manager.addServer(remoteOauthUserServer())

    // Concurrent: three turns of the same user coalesce onto one plan/probe/admit.
    const [a, b, c] = await Promise.all([
      manager.bootstrapUserCatalog('alice'),
      manager.bootstrapUserCatalog('alice'),
      manager.bootstrapUserCatalog('alice'),
    ])
    expect(existsCalls).toHaveLength(1)
    expect(sdk.transports).toHaveLength(1)
    expect([a.candidates, b.candidates, c.candidates]).toEqual([1, 1, 1])

    // Sequential: the partition is now live → zero candidates, zero round-trips.
    const again = await manager.bootstrapUserCatalog('alice')
    expect(again.candidates).toBe(0)
    expect(existsCalls).toHaveLength(1)
    expect(sdk.transports).toHaveLength(1)
    expect(manager.getAllTools().map(t => t.name)).toEqual(['gh__do'])
  })

  // ── invariant 6 ──
  it('steady-state (all partitions live) never calls the checker', async () => {
    const grantStore = new Set(['gh:alice'])
    const { manager, checkerSpy } = gatedManager(grantStore)
    await manager.addServer(remoteOauthUserServer())
    await manager.bootstrapUserCatalog('alice') // partition now live
    checkerSpy.mockClear()

    const summary = await manager.bootstrapUserCatalog('alice')
    expect(summary.candidates).toBe(0)
    expect(checkerSpy).not.toHaveBeenCalled()
  })

  // ── invariant 7 ──
  it('checker error ⇒ registry still built, probe_unknown, and backoff skips the next turn', async () => {
    let clock = 1_000
    const grantStore = new Set(['gh:alice'])
    const { manager, existsCalls, failExistsWith } = gatedManager(grantStore, {}, () => clock)
    await manager.addServer(remoteOauthUserServer())
    failExistsWith(500) // /grants/exists 5xx → execute throws

    const summary = await manager.bootstrapUserCatalog('alice')
    // The turn is not broken: a summary is returned, nothing admitted.
    expect(summary.candidates).toBe(1)
    expect(summary.probed).toBe(1)
    expect(summary.admitted).toBe(0)
    expect(summary.skipped.probe_unknown).toBe(1)
    expect(manager.getAllTools()).toEqual([])
    expect(existsCalls).toHaveLength(1)

    // Within backoffMs the probe is paused → the next turn issues no new POST.
    clock += 10_000 // < backoffMs (30s)
    const next = await manager.bootstrapUserCatalog('alice')
    expect(next.skipped.budget_exhausted).toBe(1)
    expect(existsCalls).toHaveLength(1)
  })

  // ── invariant 10 ──
  it('wait budget: a slow admission resolves the bootstrap at ~waitBudgetMs, then lands', async () => {
    const grantStore = new Set(['gh:alice'])
    const { manager, existsCalls } = gatedManager(grantStore, { waitBudgetMs: 40 })
    await manager.addServer(remoteOauthUserServer())

    // Hold the connect open past the wait budget.
    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    sdk.connectGate = () => gate

    const summary = await manager.bootstrapUserCatalog('alice')
    // The bootstrap did not wait for the admission: it timed out with 1 pending.
    expect(summary.timedOut).toBe(true)
    expect(summary.pending).toBe(1)
    expect(summary.admitted).toBe(0)
    expect(manager.getAllTools()).toEqual([])

    // The admission keeps running; releasing it populates the catalog with NO
    // new probe (the tool loop would pick it up on its next iteration).
    release()
    sdk.connectGate = null
    await vi.waitFor(() => expect(manager.getAllTools().map(t => t.name)).toEqual(['gh__do']))
    expect(existsCalls).toHaveLength(1)
  })

  // ── invariant 11 ──
  it('connect timeout: a hung admission is bounded by connectTimeoutMs, partition not installed', async () => {
    const grantStore = new Set(['gh:alice'])
    // connectTimeoutMs (20ms) fires before the wait budget (400ms).
    const { manager } = gatedManager(grantStore, { connectTimeoutMs: 20, waitBudgetMs: 400 })
    await manager.addServer(remoteOauthUserServer())

    // A connect that never resolves must be aborted by the connect budget.
    sdk.connectGate = () => new Promise<void>(() => {})

    const summary = await manager.bootstrapUserCatalog('alice')
    // The admission failed (timed out) within the wait budget — not left pending.
    expect(summary.timedOut).toBe(false)
    expect(summary.admitted).toBe(0)
    expect(summary.pending).toBe(0)
    expect(summary.skipped.admission_failed).toBe(1)
    // No partition installed.
    expect(manager.getAllTools()).toEqual([])
  })

  // ── signal (§6.5/§7.3): abort cuts the WAIT, never the manager-owned admission ──
  it('aborting the signal ends the wait but never the admission (it lands in background)', async () => {
    const grantStore = new Set(['gh:alice'])
    // Large budgets so the ABORT — not the wait budget or the connect timeout —
    // is what ends the wait, and the admission is never bounded out.
    const { manager, existsCalls } = gatedManager(grantStore, {
      waitBudgetMs: 5000,
      connectTimeoutMs: 5000,
    })
    await manager.addServer(remoteOauthUserServer())

    const controller = new AbortController()
    // Hold the (authenticated) connect open and abort the turn's signal the moment
    // the admission reaches connect — so the abort races an in-flight admission.
    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    sdk.connectGate = () => {
      controller.abort()
      return gate
    }

    const summary = await manager.bootstrapUserCatalog('alice', { signal: controller.signal })
    // The abort ended the wait exactly like a budget expiry, leaving 1 pending.
    expect(summary.timedOut).toBe(true)
    expect(summary.pending).toBe(1)
    expect(summary.admitted).toBe(0)
    expect(manager.getAllTools()).toEqual([])

    // The admission was NOT aborted: releasing the connect lands the partition
    // with NO new probe, and the catalog reflects it (the tool loop's next pass).
    release()
    sdk.connectGate = null
    await vi.waitFor(() => expect(manager.getAllTools().map(t => t.name)).toEqual(['gh__do']))
    expect(existsCalls).toHaveLength(1)
  })

  // ── snapshot: a background admission failure must not mutate the returned summary ──
  it('the returned summary.skipped is a stable snapshot after the wait budget expires', async () => {
    const grantStore = new Set(['gh:alice'])
    // The wait budget (20ms) expires while the admission is still connecting; the
    // connect timeout (80ms) then fails it AFTER the summary was returned.
    const { manager } = gatedManager(grantStore, { waitBudgetMs: 20, connectTimeoutMs: 80 })
    await manager.addServer(remoteOauthUserServer())
    sdk.connectGate = () => new Promise<void>(() => {}) // hang until connectTimeout fires

    const warnSpy = vi.spyOn(logger, 'warn')
    const summary = await manager.bootstrapUserCatalog('alice')
    expect(summary.timedOut).toBe(true)
    expect(summary.pending).toBe(1)
    // Captured before any admission settled: no failure counted yet.
    expect(summary.skipped.admission_failed).toBeUndefined()

    // The background admission now fails (connect timeout). Its `bump` must land on
    // the manager's live tally, NOT on the frozen object already handed to us.
    await vi.waitFor(() =>
      expect(
        warnSpy.mock.calls.some(
          ([fields]) => fields?.event === 'mcp_catalog_bootstrap_admission_failed'
        )
      ).toBe(true)
    )
    expect(summary.skipped.admission_failed).toBeUndefined()
    warnSpy.mockRestore()
  })

  // ── invariant 13 ──
  it('cap: userPartitionMax reached by another user ⇒ skipped.cap, no POST', async () => {
    const grantStore = new Set(['gh:alice', 'gh:bob'])
    const { manager, existsCalls } = gatedManager(grantStore, {}, undefined, 1)
    await manager.addServer(remoteOauthUserServer())
    // bob's partition fills the cap (via the lazy path — no /grants/exists).
    await manager.callTool('gh__do', {}, { userId: 'bob' })
    expect(existsCalls).toEqual([])

    const summary = await manager.bootstrapUserCatalog('alice')
    expect(summary.candidates).toBe(0)
    expect(summary.skipped.cap).toBe(1)
    expect(existsCalls).toEqual([]) // over the cap → never probed
  })

  // ── invariant 17 ──
  it('kill-switch: enabled:false ⇒ skipped.disabled, no probe, no connect', async () => {
    const grantStore = new Set(['gh:alice'])
    const { manager, existsCalls, userTokenCalls } = gatedManager(grantStore, { enabled: false })
    await manager.addServer(remoteOauthUserServer())

    const summary = await manager.bootstrapUserCatalog('alice')
    expect(summary.skipped.disabled).toBe(1)
    expect(summary.candidates).toBe(0)
    expect(existsCalls).toEqual([])
    expect(userTokenCalls).toEqual([])
    expect(sdk.transports).toEqual([])
  })
})
