import { describe, expect, it, vi } from 'vitest'
import { AppService } from '../appService.js'

// Electron is mocked so `new AppService()` constructs without Keychain/app
// side-effects; the tests then stub `issueRpcTokenForHostRefs` + `rpcClient`
// to observe the EXACT scope array each operation requests from control-api.
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

// Lets the not-awaited stream `connect()` chain run far enough to reach its
// `issueRpcTokenForHostRefs` call without advancing real time (so the 1s
// reconnect backoff timer never fires and no handle leaks).
async function flushAsyncWork(iterations = 16): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve()
  }
}

/**
 * Wires an AppService with `issueRpcTokenForHostRefs` and `rpcClient` stubbed so
 * a test can assert the exact scope array a finite operation requests. Mirrors
 * the canonical `appService.hostModels.test.ts` / `appService.sessions.issue791`
 * harnesses — no team resolution, no real RPC token manager.
 */
function scopeHarness() {
  const issueRpcTokenForHostRefs = vi.fn().mockResolvedValue({ token: 'rpc-token' })
  const service = new AppService() as any
  service.sessionToken = 'session-token'
  service.me = { id: 7, teamId: 'team-1' }
  service.issueRpcTokenForHostRefs = issueRpcTokenForHostRefs
  service.rpcClient = {
    listSessions: vi.fn().mockResolvedValue({ items: [] }),
    loadSessionMessages: vi.fn().mockResolvedValue({ agent: 'a', chatId: 'c', turns: [] }),
    getContextBreakdown: vi.fn().mockResolvedValue({ breakdown: null }),
    getHostModels: vi.fn().mockResolvedValue({
      provider: 'claude',
      hostDefault: 'claude-opus-4-8',
      sessionModel: null,
      degraded: false,
      models: [{ name: 'claude-opus-4-8' }],
    }),
    setHostModel: vi.fn().mockResolvedValue({
      effective: 'next-task',
      provider: 'claude',
      model: 'claude-haiku-4-5',
    }),
    listArtifacts: vi.fn().mockResolvedValue({ artifacts: [] }),
    downloadArtifact: vi.fn().mockResolvedValue(Buffer.from('x')),
    approveToolCall: vi.fn().mockResolvedValue({ decision: 'approved' }),
    denyToolCall: vi.fn().mockResolvedValue({ decision: 'denied' }),
    getHostStatus: vi.fn().mockResolvedValue({ hostRef: 'chatllm', ready: true }),
    getHostActivity: vi.fn().mockResolvedValue({ events: [] }),
    openHostStatusStream: vi.fn().mockResolvedValue(undefined),
    openHostActivityStream: vi.fn().mockResolvedValue(undefined),
    openTaskProgressStream: vi.fn().mockResolvedValue(undefined),
  }
  return { service, issueRpcTokenForHostRefs }
}

function firstScope(issueRpcTokenForHostRefs: ReturnType<typeof vi.fn>): unknown {
  const calls = issueRpcTokenForHostRefs.mock.calls
  expect(calls.length).toBeGreaterThanOrEqual(1)
  const first = calls[0]
  if (!first) throw new Error('issueRpcTokenForHostRefs was not called')
  return first[0]
}

// ── POSITIVE: the nine finite operations that must request host:wake:write ──
//
// Plan §11.4 makes TWELVE routes wake-capable. NINE of them map to operations
// whose scope arrays THIS PR changes, and those nine are the cases below
// (session ×4, model ×1, artifact ×2, approval ×2). The remaining three —
// invokeHostMessage, getTaskResult, cancelTask — ride
// HOST_FINITE_OPERATION_SCOPES.message, which already carried the wake scope on
// origin/dev, so this PR adds no scope for them and there is nothing here to
// pin. 9 + 3 = 12: the two counts describe different nouns (operations changed
// vs routes wake-capable), not an inconsistency.
//
// The assertion is the FULL exact scope array, wake scope included — a widening
// that dropped or reordered a scope would fail loudly here.

describe('issue #791 — finite operations request host:wake:write in addition to their scope', () => {
  it('listSessions → host:session:read + host:wake:write', async () => {
    const { service, issueRpcTokenForHostRefs } = scopeHarness()
    await service.listSessions('chatllm', ['chatllm'], '11111111-1111-4111-8111-111111111111')
    expect(firstScope(issueRpcTokenForHostRefs)).toEqual(['host:session:read', WAKE])
  })

  it('loadSessionMessages → host:session:read + host:wake:write', async () => {
    const { service, issueRpcTokenForHostRefs } = scopeHarness()
    await service.loadSessionMessages(
      'chatllm',
      'agent-a',
      'chat-a',
      ['chatllm'],
      '22222222-2222-4222-8222-222222222222'
    )
    expect(firstScope(issueRpcTokenForHostRefs)).toEqual(['host:session:read', WAKE])
  })

  it('getContextBreakdown → host:session:read + host:wake:write', async () => {
    const { service, issueRpcTokenForHostRefs } = scopeHarness()
    await service.getContextBreakdown('chatllm', 'agent-a', 'chat-a', ['chatllm'])
    expect(firstScope(issueRpcTokenForHostRefs)).toEqual(['host:session:read', WAKE])
  })

  it('getHostModels → host:session:read + host:wake:write', async () => {
    const { service, issueRpcTokenForHostRefs } = scopeHarness()
    await service.getHostModels('chatllm', 'chat-1', ['chatllm'])
    expect(firstScope(issueRpcTokenForHostRefs)).toEqual(['host:session:read', WAKE])
  })

  it('setHostModel → host:model:write + host:wake:write', async () => {
    const { service, issueRpcTokenForHostRefs } = scopeHarness()
    await service.setHostModel('chatllm', 'chat-1', 'claude-haiku-4-5', ['chatllm'])
    expect(firstScope(issueRpcTokenForHostRefs)).toEqual(['host:model:write', WAKE])
  })

  it('listArtifacts → host:activity:read + host:task:read + host:wake:write', async () => {
    const { service, issueRpcTokenForHostRefs } = scopeHarness()
    await service.listArtifacts('chatllm', ['chatllm'])
    expect(firstScope(issueRpcTokenForHostRefs)).toEqual([
      'host:activity:read',
      'host:task:read',
      WAKE,
    ])
  })

  it('downloadArtifact → host:activity:read + host:task:read + host:wake:write', async () => {
    const { service, issueRpcTokenForHostRefs } = scopeHarness()
    await service.downloadArtifact('chatllm', 'report.pdf', ['chatllm'])
    expect(firstScope(issueRpcTokenForHostRefs)).toEqual([
      'host:activity:read',
      'host:task:read',
      WAKE,
    ])
  })

  it('approveToolCall → host:approval:write + host:wake:write', async () => {
    const { service, issueRpcTokenForHostRefs } = scopeHarness()
    await service.approveToolCall('chatllm', 'task-1', 'call-1', ['chatllm'])
    expect(firstScope(issueRpcTokenForHostRefs)).toEqual(['host:approval:write', WAKE])
  })

  it('denyToolCall → host:approval:write + host:wake:write', async () => {
    const { service, issueRpcTokenForHostRefs } = scopeHarness()
    await service.denyToolCall('chatllm', 'task-1', 'call-1', 'nope', ['chatllm'])
    expect(firstScope(issueRpcTokenForHostRefs)).toEqual(['host:approval:write', WAKE])
  })
})

// ── NEGATIVE: observability reads and every SSE stream must NEVER request wake ──
//
// A suspended stateless Host must stay suspended under polling and streaming, or
// observability would defeat scale-to-zero.
//
// SCOPE OF THIS ASSERTION — read carefully before strengthening it. The harness
// stubs issueRpcTokenForHostRefs and inspects mock.calls[n][0], so these tests
// prove that no stream/observability surface REQUESTS the wake scope. They do
// NOT — and cannot — prove anything about the token actually DELIVERED:
// RpcTokenManager reuses a cached token whose scopes are a superset of the
// request (pinned in test/rpcTokenManager.test.ts), so a stream may legitimately
// run on a token that already carries host:wake:write.
//
// That is safe because possessing the scope is not what wakes a Host: rpc-proxy
// triggers a wake only from its explicit per-route allowlist plus the positive
// isWakeCapable gate (wakeAndHold.ts). The no-wake-on-streams invariant is
// therefore enforced SERVER-SIDE and survives a maximally-scoped token; these
// client-side tests pin the request shape, which is the half the client owns.
// (The status-stream reconnect lifecycle is additionally guarded by
// appService.prewarm.test.ts.)

describe('issue #791 — streams and observability reads never request host:wake:write', () => {
  it('getHostStatus stays host:status:read only', async () => {
    const { service, issueRpcTokenForHostRefs } = scopeHarness()
    await service.getHostStatus('chatllm', ['chatllm'])
    for (const call of issueRpcTokenForHostRefs.mock.calls) {
      expect(call[0]).not.toContain(WAKE)
    }
    expect(firstScope(issueRpcTokenForHostRefs)).toEqual(['host:status:read'])
  })

  it('getHostActivity stays host:activity:read only', async () => {
    const { service, issueRpcTokenForHostRefs } = scopeHarness()
    await service.getHostActivity('chatllm', { hostRefs: ['chatllm'] })
    for (const call of issueRpcTokenForHostRefs.mock.calls) {
      expect(call[0]).not.toContain(WAKE)
    }
    expect(firstScope(issueRpcTokenForHostRefs)).toEqual(['host:activity:read'])
  })

  it('startHostStatusStream connect stays host:status:read only', async () => {
    const { service, issueRpcTokenForHostRefs } = scopeHarness()
    service.startHostStatusStream('s-status', 7, 'chatllm', ['chatllm'], () => {})
    await flushAsyncWork()
    for (const call of issueRpcTokenForHostRefs.mock.calls) {
      expect(call[0]).not.toContain(WAKE)
    }
    expect(firstScope(issueRpcTokenForHostRefs)).toEqual(['host:status:read'])
    service.stopHostStatusStream('s-status')
  })

  it('startHostActivityStream connect stays host:activity:read only', async () => {
    const { service, issueRpcTokenForHostRefs } = scopeHarness()
    service.startHostActivityStream('s-activity', 7, 'chatllm', ['chatllm'], () => {})
    await flushAsyncWork()
    for (const call of issueRpcTokenForHostRefs.mock.calls) {
      expect(call[0]).not.toContain(WAKE)
    }
    expect(firstScope(issueRpcTokenForHostRefs)).toEqual(['host:activity:read'])
    service.stopHostActivityStream('s-activity')
  })

  it('startTaskProgressStream connect stays host:activity:read only', async () => {
    const { service, issueRpcTokenForHostRefs } = scopeHarness()
    service.startTaskProgressStream('s-progress', 7, 'chatllm', 'task-1', ['chatllm'], () => {})
    await flushAsyncWork()
    for (const call of issueRpcTokenForHostRefs.mock.calls) {
      expect(call[0]).not.toContain(WAKE)
    }
    expect(firstScope(issueRpcTokenForHostRefs)).toEqual(['host:activity:read'])
    service.stopTaskProgressStream('s-progress')
  })
})
