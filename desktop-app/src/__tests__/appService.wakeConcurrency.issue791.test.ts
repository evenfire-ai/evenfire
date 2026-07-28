import { describe, expect, it, vi } from 'vitest'
import { AppService } from '../appService.js'
import { ApiError } from '../httpClient.js'

// Controller-level (unit) expression of plan §13.4 "Operation outcomes": when a
// user opens an agent and concurrently lists sessions, loads models, and sends a
// message against a suspended-then-waking stateless Host, every finite operation
// must (a) carry the wake grant so the proxy can bring the Host up bounded, and
// (b) surface the real post-wake result — never a fabricated empty session list
// and never a false success on a still-unavailable Host.
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/clerum-desktop-test'),
    getVersion: vi.fn(() => '0.1.286'),
    isPackaged: false,
    isReady: vi.fn(() => false),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
  shell: { openExternal: vi.fn() },
}))

const WAKE = 'host:wake:write'
const HOST = 'chatllm-stateless'

// A finite RPC that only resolves after a microtask, modelling rpc-proxy's
// wake-then-hold-then-retry: the caller's promise settles once the woken Host
// answered. Using a real deferred boundary makes the three concurrent calls
// genuinely interleave rather than resolve synchronously in call order.
function afterWakeHold<T>(value: T): Promise<T> {
  return Promise.resolve().then(() => Promise.resolve().then(() => value))
}

function concurrentHarness() {
  const issueRpcTokenForHostRefs = vi.fn().mockResolvedValue({ token: 'rpc-token' })
  const service = new AppService() as any
  service.sessionToken = 'session-token'
  service.me = { id: 7, teamId: 'team-1' }
  service.issueRpcTokenForHostRefs = issueRpcTokenForHostRefs
  service.rpcClient = {
    listSessions: vi.fn(),
    getHostModels: vi.fn(),
    invokeHostMessage: vi.fn(),
    loadSessionMessages: vi.fn(),
  }
  return { service, issueRpcTokenForHostRefs }
}

function scopesFor(issuer: ReturnType<typeof vi.fn>): unknown[] {
  return issuer.mock.calls.map(call => call[0])
}

describe('issue #791 — concurrent open/list/model/message against a waking stateless Host', () => {
  it('all three finite operations carry wake and return real post-wake results (no false-empty)', async () => {
    const { service, issueRpcTokenForHostRefs } = concurrentHarness()
    const sessions = {
      items: [
        { agent: HOST, chatId: 'chat-a', turnCount: 2, lastActivityAt: '2026-07-22T00:00:00Z' },
        { agent: HOST, chatId: 'chat-b', turnCount: 1, lastActivityAt: '2026-07-22T00:01:00Z' },
      ],
    }
    const models = {
      provider: 'claude',
      hostDefault: 'claude-opus-4-8',
      sessionModel: null,
      degraded: false,
      models: [{ name: 'claude-opus-4-8' }, { name: 'claude-haiku-4-5' }],
    }
    const message = { taskId: 'task-1', status: 'accepted' }
    service.rpcClient.listSessions.mockReturnValue(afterWakeHold(sessions))
    service.rpcClient.getHostModels.mockReturnValue(afterWakeHold(models))
    service.rpcClient.invokeHostMessage.mockReturnValue(afterWakeHold(message))

    // The user opened the agent: list sessions, load models, and send — all at
    // once, exactly as the workspace does on selection.
    const [listed, loaded, sent] = await Promise.all([
      service.listSessions(HOST, [HOST], '33333333-3333-4333-8333-333333333333'),
      service.getHostModels(HOST, 'chat-a', [HOST]),
      service.invokeHostMessage(HOST, { content: 'hello' }, [HOST]),
    ])

    // (a) Bounded waking: every finite op requested the wake grant so a
    // suspended Host could be woken for it.
    const requested = scopesFor(issueRpcTokenForHostRefs)
    expect(requested.length).toBe(3)
    for (const scope of requested) {
      expect(scope).toContain(WAKE)
    }
    // session list + models both ride the session-read family; the message
    // rides the message family — assert the exact families that appeared.
    expect(requested).toContainEqual(['host:session:read', WAKE])
    expect(requested).toContainEqual(['host:message:invoke', 'host:task:read', WAKE])

    // (b) No false-empty session catalog and no navigation loss: both chat
    // identities survive the concurrent wake.
    expect(listed.items).toHaveLength(2)
    expect(listed.items.map((s: { chatId: string }) => s.chatId)).toEqual(['chat-a', 'chat-b'])
    // Real model list + real message result, not a fabricated stand-in.
    expect(loaded.models).toHaveLength(2)
    expect(sent.taskId).toBe('task-1')
  })

  it('a still-unavailable Host fails loud under concurrency instead of fabricating an empty list', async () => {
    const { service } = concurrentHarness()
    const unavailable = new ApiError('runtime unavailable (503)', 503, '')
    // The session read never wakes to Ready; models happens to answer. The list
    // MUST reject — a fabricated `{ items: [] }` would be a false success that
    // silently drops the user's real sessions (plan §13.4).
    service.rpcClient.listSessions.mockReturnValue(afterWakeHold(Promise.reject(unavailable)))
    service.rpcClient.getHostModels.mockReturnValue(
      afterWakeHold({
        provider: 'claude',
        hostDefault: 'claude-opus-4-8',
        sessionModel: null,
        degraded: false,
        models: [{ name: 'claude-opus-4-8' }],
      })
    )

    const results = await Promise.allSettled([
      service.listSessions(HOST, [HOST], '44444444-4444-4444-8444-444444444444'),
      service.getHostModels(HOST, 'chat-a', [HOST]),
    ])

    expect(results[0].status).toBe('rejected')
    expect((results[0] as PromiseRejectedResult).reason).toBe(unavailable)
    // The concurrent model load is independent and still resolves — one waking
    // failure does not poison a sibling operation.
    expect(results[1].status).toBe('fulfilled')
  })
})
