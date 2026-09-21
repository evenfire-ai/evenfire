/**
 * Orchestration of the proactive-refresh sweep (mini-spec L §6): enumerate →
 * claim → refresh → classify, best-effort per row, plus the per-server-CR DCR
 * dedup (§5 idempotency) and the time-based DCR sweep. The DB/K8s/refresh IO is
 * injected so this asserts the OBSERVABLE sweep summary (T4), not internal calls.
 *
 * The store enumeration/claim and `getAccessToken` are mocked as control-flow
 * seams; the refresh contract itself (token-endpoint → persisted row) is proven
 * by the real-Postgres suite and the reactive `tokenHelper` tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DbClient } from '../src/db.js'
import type { K8sGateway } from '../src/k8s.js'
import type { ExpiringDynamicClient } from '../src/oauth/dynamicClientStore.js'
import { listExpiringDynamicClients } from '../src/oauth/dynamicClientStore.js'
import type { OAuthGrantKey } from '../src/oauth/store.js'
import {
  claimRemoteGrantForRefresh,
  listRemoteGrantsInProactiveWindow,
} from '../src/oauth/store.js'
import type { GetAccessTokenResult } from '../src/oauth/tokenHelper.js'
import { getAccessToken } from '../src/oauth/tokenHelper.js'
import {
  type ProactiveRefreshSweepDeps,
  runProactiveRefreshSweep,
  startOauthProactiveRefreshCron,
  stopOauthProactiveRefreshCron,
} from '../src/services/oauthProactiveRefreshCron.js'

vi.mock('../src/oauth/store.js', async () => {
  const actual =
    await vi.importActual<typeof import('../src/oauth/store.js')>('../src/oauth/store.js')
  return {
    ...actual,
    listRemoteGrantsInProactiveWindow: vi.fn(),
    claimRemoteGrantForRefresh: vi.fn(),
  }
})
vi.mock('../src/oauth/dynamicClientStore.js', async () => {
  const actual = await vi.importActual<typeof import('../src/oauth/dynamicClientStore.js')>(
    '../src/oauth/dynamicClientStore.js'
  )
  return { ...actual, listExpiringDynamicClients: vi.fn() }
})
vi.mock('../src/oauth/tokenHelper.js', async () => {
  const actual = await vi.importActual<typeof import('../src/oauth/tokenHelper.js')>(
    '../src/oauth/tokenHelper.js'
  )
  return { ...actual, getAccessToken: vi.fn() }
})

const OPTS = { proactiveBufferMs: 300_000, reactiveBufferMs: 60_000, dcrWarnMs: 604_800_000 }
const gateway = {} as K8sGateway

const fakeTx: DbClient = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }
const deps: ProactiveRefreshSweepDeps = {
  db: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
  runInTransaction: work => work(fakeTx),
  encryptionKey: Buffer.alloc(32),
  fetchFn: vi.fn() as unknown as typeof fetch,
}

const sharedKey = (server: string, ctx: string): OAuthGrantKey => ({
  grantKind: 'shared',
  ownerKind: 'mcpserver',
  recipeNamespace: 'mcp-server',
  recipeName: server,
  contextId: ctx,
  oauthClientId: 'cid',
})

const mockedEnumerate = vi.mocked(listRemoteGrantsInProactiveWindow)
const mockedClaim = vi.mocked(claimRemoteGrantForRefresh)
const mockedGetToken = vi.mocked(getAccessToken)
const mockedDcrList = vi.mocked(listExpiringDynamicClients)

beforeEach(() => {
  vi.clearAllMocks()
  mockedEnumerate.mockResolvedValue([])
  mockedClaim.mockResolvedValue(true)
  mockedGetToken.mockResolvedValue({ kind: 'ok', accessToken: 'X' } as GetAccessTokenResult)
  mockedDcrList.mockResolvedValue([])
})

afterEach(() => {
  stopOauthProactiveRefreshCron()
})

describe('runProactiveRefreshSweep — token candidates', () => {
  it('empty candidates → all-zero summary, DCR sweep still runs', async () => {
    const summary = await runProactiveRefreshSweep(gateway, OPTS, deps)
    expect(summary.candidates).toBe(0)
    expect(summary.outcomes).toEqual({
      ok: 0,
      transient: 0,
      client_invalid: 0,
      no_grant: 0,
      skipped: 0,
      error: 0,
    })
    expect(mockedDcrList).toHaveBeenCalledOnce()
  })

  it('claimed + ok → outcome ok, and the refresh runs on the transaction client', async () => {
    mockedEnumerate.mockResolvedValue([sharedKey('srv-a', 'ctx-1')])
    const summary = await runProactiveRefreshSweep(gateway, OPTS, deps)
    expect(summary.outcomes.ok).toBe(1)
    // requireBackground:true (SEC-5) and refreshBufferMs = Bp, db = the tx client.
    expect(mockedGetToken).toHaveBeenCalledWith(
      expect.objectContaining({ grantKind: 'shared', requireBackground: true }),
      expect.objectContaining({ db: fakeTx, refreshBufferMs: OPTS.proactiveBufferMs })
    )
  })

  it('claim returns false (locked / renewed out of window) → skipped, no refresh', async () => {
    mockedEnumerate.mockResolvedValue([sharedKey('srv-a', 'ctx-1')])
    mockedClaim.mockResolvedValue(false)
    const summary = await runProactiveRefreshSweep(gateway, OPTS, deps)
    expect(summary.outcomes.skipped).toBe(1)
    expect(mockedGetToken).not.toHaveBeenCalled()
  })

  it('a per-row throw is counted as error and never aborts the sweep', async () => {
    mockedEnumerate.mockResolvedValue([sharedKey('srv-a', 'ctx-1'), sharedKey('srv-b', 'ctx-2')])
    mockedGetToken
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ kind: 'ok', accessToken: 'X' } as GetAccessTokenResult)
    const summary = await runProactiveRefreshSweep(gateway, OPTS, deps)
    expect(summary.outcomes.error).toBe(1)
    expect(summary.outcomes.ok).toBe(1)
    expect(summary.candidates).toBe(2)
  })

  it('transient refresh failure → transient outcome (row left to the reactive path)', async () => {
    mockedEnumerate.mockResolvedValue([sharedKey('srv-a', 'ctx-1')])
    mockedGetToken.mockResolvedValue({
      kind: 'refresh_failed',
      status: 503,
      detail: 'upstream',
    } as GetAccessTokenResult)
    const summary = await runProactiveRefreshSweep(gateway, OPTS, deps)
    expect(summary.outcomes.transient).toBe(1)
    expect(summary.outcomes.client_invalid).toBe(0)
  })

  it('§5 idempotency: N grants of one server-CR failing invalid_client apply DCR policy once', async () => {
    mockedEnumerate.mockResolvedValue([
      sharedKey('srv-a', 'ctx-1'),
      sharedKey('srv-a', 'ctx-2'),
      sharedKey('srv-a', 'ctx-3'),
    ])
    mockedGetToken.mockResolvedValue({
      kind: 'refresh_failed',
      status: 401,
      detail: 'invalid_client',
    } as GetAccessTokenResult)
    const summary = await runProactiveRefreshSweep(gateway, OPTS, deps)
    expect(summary.outcomes.client_invalid).toBe(3)
    expect(summary.dcrClientInvalidServers).toEqual(['mcpserver|mcp-server|srv-a'])
  })
})

describe('runProactiveRefreshSweep — DCR expiry sweep', () => {
  it('splits expiring (warn) from expired via the pure decision', async () => {
    const now = Date.now()
    const rows: ExpiringDynamicClient[] = [
      {
        serverNamespace: 'mcp-server',
        serverName: 'srv-warn',
        clientMode: 'confidential',
        clientSecretExpiresAt: new Date(now + 1000),
      },
      {
        serverNamespace: 'mcp-server',
        serverName: 'srv-expired',
        clientMode: 'confidential',
        clientSecretExpiresAt: new Date(now - 1000),
      },
    ]
    mockedDcrList.mockResolvedValue(rows)
    const summary = await runProactiveRefreshSweep(gateway, OPTS, deps)
    expect(summary.dcrExpiring).toBe(1)
    expect(summary.dcrExpired).toBe(1)
  })

  it('a DCR read failure does not fail the sweep (best-effort)', async () => {
    mockedDcrList.mockRejectedValue(new Error('db down'))
    await expect(runProactiveRefreshSweep(gateway, OPTS, deps)).resolves.toBeDefined()
  })
})

describe('startOauthProactiveRefreshCron — loop lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false })
  })
  afterEach(() => {
    stopOauthProactiveRefreshCron()
    vi.useRealTimers()
  })

  it('runs a sweep each interval and does not stack on double start', async () => {
    startOauthProactiveRefreshCron(gateway, { ...OPTS, intervalMs: 60_000 }, deps)
    startOauthProactiveRefreshCron(gateway, { ...OPTS, intervalMs: 60_000 }, deps)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mockedEnumerate).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mockedEnumerate).toHaveBeenCalledTimes(2)
  })

  it('stops cleanly', async () => {
    startOauthProactiveRefreshCron(gateway, { ...OPTS, intervalMs: 60_000 }, deps)
    await vi.advanceTimersByTimeAsync(60_000)
    const before = mockedEnumerate.mock.calls.length
    stopOauthProactiveRefreshCron()
    await vi.advanceTimersByTimeAsync(180_000)
    expect(mockedEnumerate.mock.calls.length).toBe(before)
  })
})
