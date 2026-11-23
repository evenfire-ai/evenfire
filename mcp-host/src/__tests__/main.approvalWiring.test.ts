/**
 * Approval wiring in main.ts, driven through main's own handlers: the Host
 * watch handler, and the RPC server main wires, reached over HTTP. The
 * ConfigStore is a fake that serves whatever failover credential slots it was
 * opened with, so a Host can boot on a fallback whose primary key is missing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import { register } from 'prom-client'
import type { AgentStateMachine } from '../agent'
import type { TaskExecutor } from '../agent/taskExecutor'
import type { ConfigStoreOptions } from '../config/configStore'
import type { ApprovalModeInputs } from '../core/approval/gateCause'
import { type Conversation, FinishReason } from '../core/types'
import type { Task } from '../queue'
import type { RPCServer } from '../server'
import type { HostCRD } from '../types'
import { withRpcProxyEdgeTestAuthentication } from './rpcProxyEdgeTestHeaders'

const HOST = 'host-a'
const USER = 'user-1'
const CHAT = 'chat-1'

const fake = vi.hoisted(() => {
  // config.ts reads these when main.ts loads.
  process.env.CLERUM_SERVER_PORT = '0'
  process.env.CLERUM_ENABLE_AUTH = 'false'
  process.env.CLERUM_HOST_NAME = 'host-a'
  return {
    // When set, the store serves the Host primary's key under this data key.
    primaryKeySlot: null as string | null,
    // When set, the operator allowlist is available with these models.
    allowlist: null as Map<string, Array<{ model: string }>> | null,
  }
})

vi.mock('../config/configStore', async importOriginal => {
  const actual = await importOriginal<typeof import('../config/configStore')>()
  class FakeConfigStore {
    constructor(readonly opts: ConfigStoreOptions) {}
    async start(): Promise<void> {}
    stop(): void {}
    onChange(): () => void {
      return () => undefined
    }
    get(): string | undefined {
      return undefined
    }
    isLlmKeyConfigured(): boolean {
      return fake.primaryKeySlot !== null
    }
    // Without a primary key slot the Host primary cannot be built.
    llmCredentials(): { provider: string; credentials: Record<string, string> } | null {
      if (!fake.primaryKeySlot || !this.opts.provider) return null
      return {
        provider: this.opts.provider,
        credentials: { [fake.primaryKeySlot]: 'fixture-key' },
      }
    }
    fallbackSlotValue(dataKey: string): string | undefined {
      return this.opts.fallbackCredentialSlots?.includes(dataKey) ? 'fixture-key' : undefined
    }
    allowlistAvailable(): boolean {
      return fake.allowlist !== null
    }
    allowedModels(): Map<string, Array<{ model: string }>> {
      return fake.allowlist ?? new Map()
    }
    listSecretEntries(): [] {
      return []
    }
    codexPolicyBinding(): null {
      return null
    }
    grokPolicyBinding(): null {
      return null
    }
  }
  return { ...actual, ConfigStore: FakeConfigStore }
})

type Main = typeof import('../main')

interface Harness {
  main: Main
  agent: AgentStateMachine
  server: RPCServer
  baseUrl: string
}

let current: Harness | null = null

async function loadMain(): Promise<Pick<Harness, 'main' | 'agent'>> {
  // Each test loads a fresh main.ts so its module state starts empty. The
  // metrics it registers live in prom-client's process-wide registry.
  register.clear()
  vi.resetModules()
  const main = await import('../main')
  const { AgentStateMachine } = await import('../agent')
  const { MessageQueue } = await import('../queue')
  const { TaskLifecycle } = await import('../lifecycle/taskLifecycle')
  const agent = new AgentStateMachine(new MessageQueue(), new TaskLifecycle(), {
    autoStart: false,
  })
  main.mainRpcTestSeams.setAgent(agent)
  return { main, agent }
}

async function startServer(loaded: Pick<Harness, 'main' | 'agent'>): Promise<Harness> {
  const server = await loaded.main.mainRpcTestSeams.startRPCServer()
  const address = (server as unknown as { server: { address(): AddressInfo } }).server.address()
  current = { ...loaded, server, baseUrl: `http://127.0.0.1:${address.port}` }
  return current
}

// What rpc-proxy forwards: the clear edge headers plus the edge assertion
// control-api signs for them. The Host refuses caller rpc-proxy without it.
function edgeHeaders(options: { scopes?: readonly string[] } = {}): Record<string, string> {
  return withRpcProxyEdgeTestAuthentication(
    {
      'x-clerum-edge-caller': 'rpc-proxy',
      'x-clerum-edge-host-ref': HOST,
      'x-clerum-edge-user-id': USER,
      'content-type': 'application/json',
    },
    options
  )
}

async function rpcKey(): Promise<string> {
  const { serializeSessionKey } = await import('../session')
  return serializeSessionKey({ userId: USER, channelType: 'rpc', channelId: HOST, threadId: CHAT })
}

async function seedRpcSession(agent: AgentStateMachine): Promise<void> {
  await agent.getConversationManager().getOrCreate(await rpcKey(), {
    userId: USER,
    channelType: 'rpc',
    channelId: HOST,
    threadId: CHAT,
    source: 'rpc',
  })
}

async function listedSession(harness: Harness): Promise<Record<string, unknown>> {
  const res = await fetch(`${harness.baseUrl}/v1/runtime/sessions?agent=${HOST}`, {
    headers: edgeHeaders(),
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { items: Array<Record<string, unknown>> }
  const item = body.items.find(entry => entry.chatId === CHAT)
  expect(item).toBeDefined()
  return item!
}

function host(spec: Partial<HostCRD['spec']>): HostCRD {
  return {
    name: HOST,
    namespace: 'fixture-ns',
    spec: {
      host: HOST,
      contextRef: 'ctx-a',
      secretRef: 'llm-secret-a',
      model: { provider: 'claude', name: 'claude-sonnet-4-5' },
      approval: { defaultPolicy: 'channel_users', channels: {}, modeCeiling: 'auto' },
      ...spec,
    },
  }
}

beforeEach(() => {
  current = null
  fake.primaryKeySlot = null
  fake.allowlist = null
})

afterEach(async () => {
  await current?.server.stop()
  current?.main.mainRpcTestSeams.setAgent(null)
  current = null
})

describe('main session reads: classifier pair', () => {
  it('reports the dedicated shell classifier when the Host model provider is OpenAI', async () => {
    fake.primaryKeySlot = 'openai-api-key'
    fake.allowlist = new Map([['openai', [{ model: 'gpt-4.1' }, { model: 'gpt-5.4-mini' }]]])
    const loaded = await loadMain()
    await loaded.main.onHostChange(
      host({
        model: { provider: 'openai', name: 'gpt-4.1' },
        allowedModels: [{ provider: 'openai', model: 'gpt-4.1' }],
      })
    )
    const harness = await startServer(loaded)
    await seedRpcSession(loaded.agent)
    const { serializeSessionKey } = await import('../session')
    const conv = loaded.agent
      .getConversationManager()
      .getSessionByKey(
        serializeSessionKey({ userId: USER, channelType: 'rpc', channelId: HOST, threadId: CHAT })
      )
    // Saved before the subset narrowed. The task still runs gpt-5.4-mini.
    // The shell classifier is the dedicated default, not that chat model.
    conv!.modelSelections = { openai: 'gpt-5.4-mini' }

    const item = await listedSession(harness)

    expect(item.modeCeiling).toBe('auto')
    expect(item.shellClassifierAvailable).toBe(true)
  }, 20_000)

  it('reports the classifier unavailable when the Host pins a model it does not call', async () => {
    fake.primaryKeySlot = 'openai-api-key'
    const loaded = await loadMain()
    await loaded.main.onHostChange(
      host({
        // The classifier table accepts this chat model, so a fallback from the
        // pinned model to the chat model would read as available.
        model: { provider: 'openai', name: 'gpt-5.5' },
        approval: {
          defaultPolicy: 'channel_users',
          channels: {},
          modeCeiling: 'auto',
          shellClassifierModel: 'gpt-4.1-mini',
        },
      })
    )
    const harness = await startServer(loaded)
    await seedRpcSession(loaded.agent)

    const item = await listedSession(harness)

    expect(item.shellClassifierAvailable).toBe(false)
  }, 20_000)

  it('keeps the dedicated classifier while failover serves another provider', async () => {
    fake.primaryKeySlot = 'openai-api-key'
    const loaded = await loadMain()
    await loaded.main.onHostChange(
      host({
        model: { provider: 'openai', name: 'gpt-5.4-mini' },
        llmPolicy: { fallbacks: [{ provider: 'zai', model: 'glm-4.6' }] },
      })
    )
    const harness = await startServer(loaded)
    await seedRpcSession(loaded.agent)
    const engine = loaded.main.mainRpcTestSeams.failoverEngine()
    expect(engine).not.toBeNull()
    engine!.noteServedFallback({ provider: 'zai', model: 'glm-4.6' })

    expect((await listedSession(harness)).shellClassifierAvailable).toBe(true)
  }, 20_000)

  // Tasks resolve a saved selection against the global allowlist, not the
  // Host subset (taskModelPair), so the session read must too. Bedrock has no
  // OpenAI key to mask this with the dedicated classifier, and its table
  // depends on the model name.
  it('reports the saved model a task runs, even when the Host subset hides it from selection', async () => {
    fake.allowlist = new Map([
      [
        'bedrock',
        [{ model: 'meta.llama3-70b-instruct-v1:0' }, { model: 'anthropic.claude-sonnet-4-5-v1:0' }],
      ],
    ])
    const loaded = await loadMain()
    await loaded.main.onHostChange(
      host({
        model: { provider: 'bedrock', name: 'meta.llama3-70b-instruct-v1:0' },
        allowedModels: [{ provider: 'bedrock', model: 'meta.llama3-70b-instruct-v1:0' }],
      })
    )
    const harness = await startServer(loaded)
    await seedRpcSession(loaded.agent)
    // The Host default is not an anthropic.* model, which the table refuses.
    expect((await listedSession(harness)).shellClassifierAvailable).toBe(false)
    const conv = loaded.agent.getConversationManager().getSessionByKey(await rpcKey())
    // Saved before the subset narrowed. Globally allowed, hidden by the subset.
    conv!.modelSelections = { bedrock: 'anthropic.claude-sonnet-4-5-v1:0' }

    expect((await listedSession(harness)).shellClassifierAvailable).toBe(true)
  }, 20_000)

  it('reports the boot fallback pair, not the inconstructible Host primary', async () => {
    const loaded = await loadMain()
    // The Claude primary has no key; the zai fallback has one, so the Host
    // boots on zai. Tasks run on zai, which the classifier table refuses.
    await loaded.main.onHostChange(
      host({ llmPolicy: { fallbacks: [{ provider: 'zai', model: 'glm-4.6' }] } })
    )
    const harness = await startServer(loaded)
    await seedRpcSession(loaded.agent)

    const item = await listedSession(harness)

    expect(item.modeCeiling).toBe('auto')
    expect(item.shellClassifierAvailable).toBe(false)
  })

  it('reports the Host primary while it can be built, with the same fallback policy', async () => {
    fake.primaryKeySlot = 'claude-api-key'
    const loaded = await loadMain()
    await loaded.main.onHostChange(
      host({ llmPolicy: { fallbacks: [{ provider: 'zai', model: 'glm-4.6' }] } })
    )
    const harness = await startServer(loaded)
    await seedRpcSession(loaded.agent)

    const item = await listedSession(harness)

    expect(item.modeCeiling).toBe('auto')
    expect(item.shellClassifierAvailable).toBe(true)
  })
})

describe('main hands the dedicated classifier to admission', () => {
  it('admission judges shell with the dedicated gpt-5.5 classifier main builds, not the chat model', async () => {
    fake.primaryKeySlot = 'openai-api-key'
    const loaded = await loadMain()
    const { MessageQueue } = await import('../queue')
    const { TaskLifecycle } = await import('../lifecycle/taskLifecycle')
    const { OpenAIProvider } = await import('../llm/openai')
    // The agent initializeAgent builds, with the sources main hands it.
    const agent = loaded.main.mainRpcTestSeams.createAgent(new MessageQueue(), new TaskLifecycle())
    loaded.main.mainRpcTestSeams.setAgent(agent)
    const calledModels: string[] = []
    const completeSingleTurn = vi
      .spyOn(OpenAIProvider.prototype, 'completeSingleTurn')
      .mockImplementation(async function (this: InstanceType<typeof OpenAIProvider>) {
        calledModels.push((this as unknown as { defaultModel: string }).defaultModel)
        return {
          content: 'APPROVE',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          finish_reason: FinishReason.Stop,
        }
      })
    try {
      // gpt-4.1 serves the turn. The classifier table refuses it, so only the
      // dedicated pair can make shell judgeable.
      await loaded.main.onHostChange(host({ model: { provider: 'openai', name: 'gpt-4.1' } }))
      await seedRpcSession(agent)
      const conversation = agent.getConversationManager().getSessionByKey(await rpcKey())
      expect(conversation).toBeDefined()
      const task: Task = {
        id: 'task-classifier-wiring',
        source: 'channel',
        status: 'processing',
        priority: 'normal',
        createdAt: new Date(),
        sourceMessage: {
          sender: USER,
          content: 'run ls',
          channelType: 'rpc',
          channelId: HOST,
          threadId: CHAT,
          messageId: 'msg-classifier-wiring',
          timestamp: new Date().toISOString(),
          hostRef: HOST,
        },
        conversationHistory: [],
      }

      // The executor the state machine builds for a task, and the inputs its
      // admission reads.
      const executor = (
        agent as unknown as { createTaskExecutor(task: Task): TaskExecutor }
      ).createTaskExecutor(task)
      const inputs = (
        executor as unknown as { approvalModeInputs(c: Conversation): ApprovalModeInputs }
      ).approvalModeInputs(conversation!)

      expect(inputs.classifierAvailable({ command: 'ls' })).toBe(true)
      const verdict = await inputs.classify(
        { id: 'call-1', name: 'shell_exec', arguments: { command: 'ls' } },
        'Run a command'
      )
      expect(verdict).toBe('APPROVE')
      expect(calledModels).toEqual(['gpt-5.5'])
    } finally {
      completeSingleTurn.mockRestore()
      loaded.main.mainRpcTestSeams.setAgent(null)
    }
  }, 20_000)
})

describe('main session reads: failover and the published approval spec', () => {
  it('reports the failover fallback that is serving, not the Host primary', async () => {
    fake.primaryKeySlot = 'claude-api-key'
    const loaded = await loadMain()
    await loaded.main.onHostChange(
      host({ llmPolicy: { fallbacks: [{ provider: 'zai', model: 'glm-4.6' }] } })
    )
    const harness = await startServer(loaded)
    await seedRpcSession(loaded.agent)
    expect((await listedSession(harness)).shellClassifierAvailable).toBe(true)

    const engine = loaded.main.mainRpcTestSeams.failoverEngine()
    expect(engine).not.toBeNull()
    engine!.noteServedFallback({ provider: 'zai', model: 'glm-4.6' })

    expect((await listedSession(harness)).shellClassifierAvailable).toBe(false)
  })

  it('outside dev mode, takes the ceiling from spec.approval only, never from the env config', async () => {
    fake.primaryKeySlot = 'claude-api-key'
    const loaded = await loadMain()
    const { config } = await import('../config')
    config.devMode = false
    config.approvalConfig = {
      defaultPolicy: 'channel_users',
      channels: {},
      modeCeiling: 'allow_all',
    }
    await loaded.main.onHostChange(host({ approval: undefined }))
    const harness = await startServer(loaded)
    await seedRpcSession(loaded.agent)

    expect(loaded.agent.approvalSnapshot()).toEqual({
      effective: config.approvalConfig,
      hostSpec: undefined,
    })
    expect(await listedSession(harness)).toMatchObject({
      modeCeiling: 'manual',
      effectiveApprovalMode: 'manual',
    })
  })

  it('in dev mode, takes the ceiling from the env config', async () => {
    fake.primaryKeySlot = 'claude-api-key'
    const loaded = await loadMain()
    const { config } = await import('../config')
    config.devMode = true
    config.approvalConfig = {
      defaultPolicy: 'channel_users',
      channels: {},
      modeCeiling: 'allow_all',
    }
    await loaded.main.onHostChange(host({ approval: undefined }))
    const harness = await startServer(loaded)
    await seedRpcSession(loaded.agent)

    expect(await listedSession(harness)).toMatchObject({ modeCeiling: 'allow_all' })
  })
})

describe('main approval-mode writers and approvals over HTTP', () => {
  it('PATCH approval-mode stores the mode through main and answers the effective mode', async () => {
    fake.primaryKeySlot = 'claude-api-key'
    const loaded = await loadMain()
    await loaded.main.onHostChange(host({}))
    const harness = await startServer(loaded)
    await seedRpcSession(loaded.agent)

    const res = await fetch(
      `${harness.baseUrl}/v1/runtime/sessions/${HOST}/${CHAT}/approval-mode`,
      { method: 'PATCH', headers: edgeHeaders(), body: JSON.stringify({ mode: 'auto' }) }
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      approvalMode: 'auto',
      modeCeiling: 'auto',
      effectiveApprovalMode: 'auto',
    })
    const stored = loaded.agent.getConversationManager().getSessionByKey(await rpcKey())
    expect(stored?.approval_mode).toBe('auto')
  })

  it('PATCH approval-mode refuses an edge assertion without host:approval:write', async () => {
    fake.primaryKeySlot = 'claude-api-key'
    const loaded = await loadMain()
    await loaded.main.onHostChange(host({}))
    const harness = await startServer(loaded)
    await seedRpcSession(loaded.agent)
    const url = `${harness.baseUrl}/v1/runtime/sessions/${HOST}/${CHAT}/approval-mode`

    // The rename scope is not enough: the mode answers later cards in advance.
    const refused = await fetch(url, {
      method: 'PATCH',
      headers: edgeHeaders({ scopes: ['host:session:write'] }),
      body: JSON.stringify({ mode: 'auto' }),
    })
    expect(refused.status).toBe(401)
    expect(await refused.json()).toEqual({ error: 'Invalid runtime edge assertion' })
    const afterRefusal = loaded.agent.getConversationManager().getSessionByKey(await rpcKey())
    expect(afterRefusal).toBeDefined()
    expect(afterRefusal?.approval_mode).not.toBe('auto')

    // Witness: the same request with the approval scope reaches the writer.
    const accepted = await fetch(url, {
      method: 'PATCH',
      headers: edgeHeaders({ scopes: ['host:approval:write'] }),
      body: JSON.stringify({ mode: 'auto' }),
    })
    expect(accepted.status).toBe(200)
    const stored = loaded.agent.getConversationManager().getSessionByKey(await rpcKey())
    expect(stored?.approval_mode).toBe('auto')
  })

  it('a messaging approval-mode command stores the mode through main admission', async () => {
    fake.primaryKeySlot = 'claude-api-key'
    const loaded = await loadMain()
    const { MessageQueue } = await import('../queue')
    loaded.main.mainRpcTestSeams.setMessageQueue(new MessageQueue())
    await loaded.main.onHostChange(
      host({
        approval: {
          defaultPolicy: 'channel_users',
          channels: { slack: { enabled: true, allowModeChange: true } },
          modeCeiling: 'auto',
        },
      })
    )
    const harness = await startServer(loaded)

    const res = await fetch(`${harness.baseUrl}/v1/runtime/messages`, {
      method: 'POST',
      headers: {
        'x-clerum-edge-caller': 'channel-reader',
        'x-clerum-edge-host-ref': HOST,
        'x-clerum-edge-channel-type': 'slack',
        'x-clerum-edge-channel-id': 'C1',
        'x-clerum-edge-sender': 'slack-user',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        content: 'approval-mode auto',
        channelType: 'slack',
        channelId: 'C1',
        threadId: 'thread-1',
        sender: 'slack-user',
        messageId: 'msg-mode-1',
        timestamp: new Date().toISOString(),
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      success: true,
      status: 'completed',
      response: 'Approval mode is auto. Effective mode is auto.',
    })
    const { serializeSessionKey } = await import('../session')
    const stored = loaded.agent.getConversationManager().getSessionByKey(
      serializeSessionKey({
        userId: 'slack-user',
        channelType: 'slack',
        channelId: 'C1',
        threadId: 'thread-1',
      })
    )
    expect(stored?.approval_mode).toBe('auto')
  })

  it('passes the shell answer from an approval to the agent', async () => {
    fake.primaryKeySlot = 'claude-api-key'
    const loaded = await loadMain()
    await loaded.main.onHostChange(host({}))
    const harness = await startServer(loaded)
    const handleApproval = vi
      .spyOn(loaded.agent, 'handleApproval')
      .mockResolvedValue({ success: true })

    const res = await fetch(`${harness.baseUrl}/v1/runtime/approvals/approve`, {
      method: 'POST',
      headers: edgeHeaders(),
      body: JSON.stringify({ requestId: 'req-shell', shellAction: 'command' }),
    })

    expect(res.status).toBe(200)
    expect(handleApproval).toHaveBeenCalledTimes(1)
    expect(handleApproval).toHaveBeenCalledWith(USER, 'req-shell', false, 'rpc', HOST, 'command')
  })
})
