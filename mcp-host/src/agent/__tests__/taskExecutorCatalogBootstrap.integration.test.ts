/**
 * Per-turn catalog bootstrap, at the task level (spec §7.3, invariant 1 + 7). A
 * task whose sender holds a grant for a remote oauth-user server must see that
 * server's tools in the FIRST turn's catalog — before any tool call — because
 * `TaskExecutor.createToolRegistry` now bootstraps the caller's partitions before
 * building the registry the loop reads. This is the observable, task-level repro
 * of the per-user deadlock: at the parent commit the executor never bootstraps,
 * so the tool is absent from the tools handed to the LLM and the assertion fails.
 *
 * Fixtures come from the shared broker helper (T1): `brokerWiring` serves the
 * `/grants/exists` probe AND the `/user-token` mint from ONE grant store, and
 * `remoteUpstream({strict:true})` is the real McpClient over a mocked SDK. The
 * assertion is observable (T4): the tool definitions the provider receives, which
 * are exactly `toolRegistry.listDefinitions()` for the turn.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { config as appConfig } from '../../config'
import { ConversationManager } from '../../core/conversation/conversation'
import { SimpleEventEmitter } from '../../core/orchestration/eventEmitter'
import { FinishReason } from '../../core/types'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import type { SingleTurnProvider } from '../../llm/types'
import { type RemoteUpstreamState, brokerWiring } from '../../mcp/__tests__/helpers/brokerWiring'
import { checkGrantExistence } from '../../mcp/grantExistenceClient'
import type { GrantExistenceChecker, McpCatalogBootstrapConfig } from '../../mcp/grantProbe'
import { McpManager } from '../../mcp/manager'
import type { Task } from '../../queue/types'
import type { McpServerInfo } from '../../types'
import { TaskExecutor, type TaskExecutorDeps } from '../taskExecutor'

// Strict (spec-compliant) remote upstream: 401s at `initialize` when a token-less
// request reaches an https target, so a tool only appears once the per-user grant
// mints a Bearer. Shared hoisted state; each vi.mock factory dynamically imports
// the builder (it runs before the file's static imports resolve).
const sdk = vi.hoisted<RemoteUpstreamState>(() => ({
  transports: [],
  probeAuth: [],
  callToolImpl: null,
  toolCall401Count: 0,
}))
vi.mock('@modelcontextprotocol/sdk/client/index.js', async () => {
  const { remoteUpstream } = await import('../../mcp/__tests__/helpers/brokerWiring')
  return remoteUpstream({ strict: true }, sdk).clientModule
})
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', async () => {
  const { remoteUpstream } = await import('../../mcp/__tests__/helpers/brokerWiring')
  return remoteUpstream({ strict: true }, sdk).transportModule
})
vi.mock('@modelcontextprotocol/sdk/client/sse.js', async () => {
  const { remoteUpstream } = await import('../../mcp/__tests__/helpers/brokerWiring')
  return remoteUpstream({ strict: true }, sdk).sseModule
})
// The SDK is mocked, so no real transport fetch runs; keep the SSRF guard off DNS.
vi.mock('../../core/net/ssrf', () => ({
  SsrfBlockedError: class SsrfBlockedError extends Error {},
  resolvePinnedPublicIp: vi.fn(async () => '203.0.113.10'),
}))

function remoteOauthUserServer(name = 'calendar'): McpServerInfo {
  return {
    name,
    contextRef: 'ctx-1',
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

function taskFor(sender: string): Task {
  return {
    id: `bootstrap-${sender}-${Math.random().toString(36).slice(2, 6)}`,
    source: 'channel',
    status: 'pending',
    priority: 'normal',
    createdAt: new Date(),
    sourceMessage: {
      sender,
      content: 'Do the thing',
      channelType: 'rpc',
      channelId: 'isolated-channel',
      messageId: `msg-${sender}`,
      timestamp: new Date().toISOString(),
      hostRef: 'fixture-host',
    },
    conversationHistory: [{ role: 'user', content: 'Do the thing', timestamp: new Date() }],
    responseCallback: vi.fn(async () => {}),
  }
}

/**
 * A provider that records the tool names it is handed each turn and finishes
 * immediately (no tool call, no approval). The recorded names ARE the turn's
 * `toolRegistry.listDefinitions()`, so asserting on them is the observable proof
 * the bootstrap populated the catalog before the loop read it.
 */
function recordingProvider(seenTools: string[][]): SingleTurnProvider {
  return {
    getProviderType: () => 'openai',
    classifyError: () => {
      throw new Error('unexpected classifyError')
    },
    completeSingleTurn: async () => {
      throw new Error('unexpected non-tool completion')
    },
    completeSingleTurnWithTools: async (_messages: unknown, tools: Array<{ name: string }>) => {
      seenTools.push(tools.map(t => t.name))
      return {
        content: 'done',
        tool_calls: null,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        finish_reason: FinishReason.Stop,
      }
    },
  } as unknown as SingleTurnProvider
}

function depsFor(
  manager: McpManager,
  provider: SingleTurnProvider,
  lifecycle: TaskLifecycle
): TaskExecutorDeps {
  return {
    conversationManager: new ConversationManager(),
    llmProvider: provider,
    mcpManager: manager,
    workspaceService: undefined,
    modelName: 'test-model',
    approvalConfig: undefined,
    config: {
      maxTaskDuration: 300000,
      maxToolCallsPerTask: 10,
      autoStart: true,
      taskDelay: 0,
      approvalTimeout: 300000,
    },
    coreEvents: new SimpleEventEmitter(),
    cronScheduler: null,
    taskLifecycle: lifecycle,
    onApprovalNeeded: vi.fn(),
    onComplete: vi.fn(),
    onFail: vi.fn(),
    dynamicEnvProvider: () => ({}),
  } as unknown as TaskExecutorDeps
}

async function runTurn(
  manager: McpManager,
  sender: string,
  seenTools: string[][]
): Promise<{ deps: TaskExecutorDeps; executor: TaskExecutor }> {
  const task = taskFor(sender)
  const lifecycle = new TaskLifecycle()
  lifecycle.register(task)
  const deps = depsFor(manager, recordingProvider(seenTools), lifecycle)
  const executor = new TaskExecutor(task, deps)
  await executor.run()
  return { deps, executor }
}

afterEach(() => {
  sdk.transports = []
  sdk.probeAuth = []
  sdk.callToolImpl = null
  sdk.toolCall401Count = 0
})

describe('per-turn catalog bootstrap at the task level (spec §7.3)', () => {
  // ── invariant 1 (T3): first turn exposes the grant-backed tool ──
  it("exposes alice's granted oauth-user tool in the first turn's catalog", async () => {
    const grantStore = new Set(['calendar:alice']) // alice has a grant; nobody else
    const { deps, factory } = brokerWiring(grantStore)
    const grantExistence: GrantExistenceChecker = (queries, { timeoutMs }) =>
      checkGrantExistence({ ...deps, timeoutMs }, queries)
    const manager = new McpManager(undefined, undefined, factory, {
      grantExistence,
      catalogBootstrap: bootstrapConfig(),
    })
    // Discovery registers the server: oauth-user takes NO token-less SHARED, so it
    // is absent from the catalog until a per-user partition opens.
    await manager.addServer(remoteOauthUserServer())
    expect(manager.getAllTools()).toEqual([])

    const seenTools: string[][] = []
    const { deps: runDeps } = await runTurn(manager, 'alice', seenTools)

    expect(runDeps.onFail).not.toHaveBeenCalled()
    // The tool is in the FIRST (only) turn's definitions — bootstrap admitted the
    // per-user partition before the registry was read. Parent commit: absent.
    expect(seenTools).toHaveLength(1)
    expect(seenTools[0]).toContain('calendar__do')
  })

  // ── invariant 7: a broken probe never fails the turn, and stays backed off ──
  it('a throwing grant probe leaves the turn intact and does not re-probe within backoff', async () => {
    let clock = 1_000
    const grantStore = new Set(['calendar:alice'])
    const { deps, factory, existsCalls, failExistsWith } = brokerWiring(grantStore)
    failExistsWith(500) // every /grants/exists 500s → checkGrantExistence throws
    const grantExistence: GrantExistenceChecker = (queries, { timeoutMs }) =>
      checkGrantExistence({ ...deps, timeoutMs }, queries)
    const manager = new McpManager(undefined, undefined, factory, {
      grantExistence,
      catalogBootstrap: bootstrapConfig(),
      now: () => clock,
    })
    await manager.addServer(remoteOauthUserServer())

    const seenTools: string[][] = []
    // Turn 1: the probe throws → backoff → the turn proceeds on lazy admission.
    const { deps: t1 } = await runTurn(manager, 'alice', seenTools)
    expect(t1.onFail).not.toHaveBeenCalled()
    expect(seenTools[0]).not.toContain('calendar__do') // no partition opened
    expect(existsCalls).toHaveLength(1) // one probe was attempted (it threw)

    // Turn 2, still inside backoffMs: the plan is paused, so NO new probe POSTs.
    clock += 5_000
    const { deps: t2 } = await runTurn(manager, 'alice', seenTools)
    expect(t2.onFail).not.toHaveBeenCalled()
    expect(existsCalls).toHaveLength(1) // still one — the backoff suppressed turn 2
  })
})
