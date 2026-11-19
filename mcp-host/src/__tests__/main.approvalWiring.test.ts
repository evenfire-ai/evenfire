/**
 * Approval wiring in main.ts, driven through main's own handlers: the Host
 * watch handler, and the RPC server main wires. The ConfigStore is a fake that
 * serves whatever failover credential slots it was opened with, so a Host can
 * boot on a fallback whose primary key is missing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import { register } from 'prom-client'
import type { AgentStateMachine } from '../agent'
import type { ConfigStoreOptions } from '../config/configStore'
import type { RPCServer } from '../server'
import type { HostCRD } from '../types'

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

function edgeHeaders(): Record<string, string> {
  return {
    'x-clerum-edge-caller': 'rpc-proxy',
    'x-clerum-edge-host-ref': HOST,
    'x-clerum-edge-user-id': USER,
    'content-type': 'application/json',
  }
}

async function seedRpcSession(agent: AgentStateMachine): Promise<void> {
  const { serializeSessionKey } = await import('../session')
  await agent
    .getConversationManager()
    .getOrCreate(
      serializeSessionKey({ userId: USER, channelType: 'rpc', channelId: HOST, threadId: CHAT }),
      { userId: USER, channelType: 'rpc', channelId: HOST, threadId: CHAT, source: 'rpc' }
    )
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
  it('reports the saved model a task runs, even when the Host subset hides it from selection', async () => {
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
    // Saved before the subset narrowed. Tasks resolve against the global
    // allowlist, so they still run gpt-5.4-mini, which the classifier refuses.
    conv!.modelSelections = { openai: 'gpt-5.4-mini' }

    const item = await listedSession(harness)

    expect(item.modeCeiling).toBe('auto')
    expect(item.shellClassifierAvailable).toBe(false)
  })

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
