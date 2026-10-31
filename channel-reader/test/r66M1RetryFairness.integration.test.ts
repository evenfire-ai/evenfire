import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import { TelegramAdapter } from '../src/channels/telegram'
import { ChannelReader } from '../src/main'
import { RPCClient } from '../src/rpcClient'
import type { CommunicationChannelCRD, Message } from '../src/types'

type TestBot = {
  handlers: Map<string, (ctx: unknown) => void>
  on: ReturnType<typeof vi.fn>
  catch: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  api: { sendMessage: ReturnType<typeof vi.fn>; sendDocument: ReturnType<typeof vi.fn> }
}

const telegram = vi.hoisted(() => ({ instances: [] as TestBot[] }))
const originalEnvironment = vi.hoisted(() => {
  const keys = [
    'CLERUM_ENABLE_AUTH',
    'CLERUM_HOST_NAME',
    'CLERUM_DEV_MODE',
    'CLERUM_HOST_REF',
    'CLERUM_MCP_HOST_URL',
    'CLERUM_TELEGRAM_STARTUP_STABILITY_MS',
    'CLERUM_TELEGRAM_SHUTDOWN_GRACE_MS',
    'LOG_LEVEL',
    'MCP_HOST_RPC_PROXY_EDGE_TOKEN',
    'RPC_PROXY_MCP_HOST_EDGE_TOKEN',
  ] as const
  const before = new Map(keys.map(key => [key, process.env[key]]))
  process.env.CLERUM_ENABLE_AUTH = 'false'
  process.env.CLERUM_HOST_NAME = 'chatllm'
  process.env.CLERUM_DEV_MODE = 'true'
  process.env.CLERUM_HOST_REF = 'chatllm'
  process.env.CLERUM_TELEGRAM_STARTUP_STABILITY_MS = '0'
  process.env.CLERUM_TELEGRAM_SHUTDOWN_GRACE_MS = '0'
  process.env.LOG_LEVEL = 'silent'
  process.env.MCP_HOST_RPC_PROXY_EDGE_TOKEN = 'test-rpc-proxy-edge-token'
  process.env.RPC_PROXY_MCP_HOST_EDGE_TOKEN = 'test-rpc-proxy-edge-token'
  return before
})

vi.mock('grammy', () => ({
  Bot: vi.fn().mockImplementation(function (this: unknown) {
    const handlers = new Map<string, (ctx: unknown) => void>()
    const bot: TestBot = {
      handlers,
      on: vi.fn((event: string, handler: (ctx: unknown) => void) => handlers.set(event, handler)),
      catch: vi.fn(),
      start: vi.fn((options?: { onStart?: (bot: { id: number; username: string }) => void }) => {
        options?.onStart?.({ id: 4242, username: 'task106_test_bot' })
        return Promise.resolve()
      }),
      stop: vi.fn().mockResolvedValue(undefined),
      api: {
        sendMessage: vi.fn().mockResolvedValue({ message_id: 5001 }),
        sendDocument: vi.fn().mockResolvedValue({ message_id: 5002 }),
      },
    }
    telegram.instances.push(bot)
    return bot
  }),
  InputFile: vi.fn(),
}))

const CHAT_A = '424242'
const CHAT_B = '424243'
const EVENT_A = `telegram:${CHAT_A}:9010`
const EVENT_B = `telegram:${CHAT_B}:9011`
const TARGET = {
  hostRef: 'chatllm',
  communicationChannelNamespace: 'channels',
  communicationChannelName: 'task106-telegram',
}
const RED_STOP = 'R66_TEST_SUSTAINED_429_STOP'
const cleanups: Array<() => Promise<void>> = []

function emitTelegramMessage(messageId: number, text: string, chatId: string): void {
  const handler = telegram.instances.at(-1)?.handlers.get('message:text')
  if (!handler) throw new Error('TelegramAdapter did not register the actual message producer')
  handler({
    from: { id: 123456, username: 'task106_test_user', is_bot: false },
    chat: { id: Number(chatId), type: 'private' },
    message: { message_id: messageId, date: 1_800_000_000, text },
  })
}

describe('R66-M1 Telegram retry fairness', () => {
  it('lets independent event B and maintenance requests progress while A remains retry-pending', async () => {
    vi.resetModules()
    const { RPCServer } = await import('../../mcp-host/src/server')
    const server = new RPCServer(0)
    const accepted: Array<{ content: string; eventId?: string }> = []
    const authorizationAttempts = new Map<string, number>()
    const maintenanceRequests = { cron: 0, workflowClaims: 0 }
    server.onMessage(async (message: Message) => {
      accepted.push({
        content: message.content,
        eventId: message.providerIdentity?.providerEventId,
      })
      return { success: true, status: 'completed', response: 'accepted' }
    })
    server.onProviderMessageAuthorization(async () => ({ authorized: true }))
    server.onCronResults(() => [])
    server.onWorkflowApprovalNotificationClaim(() => ({ deliveries: [] }))
    await server.start()
    cleanups.push(async () => server.stop())
    const address = (server as unknown as { server: { address(): AddressInfo } }).server.address()
    const admission = (
      server as unknown as {
        directServiceAdmission: { admit(nowMs?: number): unknown }
      }
    ).directServiceAdmission
    const now = { value: 120_001 }
    vi.spyOn(Date, 'now').mockImplementation(() => now.value)
    for (let index = 0; index < 600; index += 1) admission.admit(now.value)

    const channel: CommunicationChannelCRD = {
      name: 'task106-telegram',
      namespace: 'channels',
      spec: {
        hostRef: 'chatllm',
        telegram: [
          { channelId: CHAT_A, chatType: 'private', userIds: [] },
          { channelId: CHAT_B, chatType: 'private', userIds: [] },
        ],
      },
    }
    const adapter = new TelegramAdapter()
    await adapter.connect({ telegramBotToken: 'test-token-not-a-credential' })
    cleanups.push(async () => adapter.disconnect())
    for (const chatId of [CHAT_A, CHAT_B]) {
      await adapter.fetchMessages(chatId, new Set(), {
        telegramChatType: 'private',
        allowUnlistedSender: true,
        providerTarget: TARGET,
      })
    }

    const retryDelays: number[] = []
    const rpc = new RPCClient(`http://127.0.0.1:${address.port}`)
    const reader = new ChannelReader({
      rpcClient: rpc,
      adapters: new Map([['telegram', adapter]]),
      channels: [channel],
      sleep: async milliseconds => {
        retryDelays.push(milliseconds)
        now.value += milliseconds
        for (let index = 0; index < 600; index += 1) admission.admit(now.value)
        if (retryDelays.length === 3) throw new Error(RED_STOP)
      },
    })

    const originalFetch = globalThis.fetch.bind(globalThis)
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = new URL(String(input))
      if (requestUrl.pathname === '/v1/runtime/cron/results') maintenanceRequests.cron += 1
      if (requestUrl.pathname === '/v1/runtime/workflow-approval-notifications/claim') {
        maintenanceRequests.workflowClaims += 1
      }
      if (
        requestUrl.pathname === '/v1/runtime/provider-messages/authorize' &&
        typeof init?.body === 'string'
      ) {
        const identity = (
          JSON.parse(init.body) as { providerIdentity?: { providerEventId?: string } }
        ).providerIdentity
        const eventId = identity?.providerEventId ?? ''
        const attempt = (authorizationAttempts.get(eventId) ?? 0) + 1
        authorizationAttempts.set(eventId, attempt)
        if (eventId === EVENT_A && attempt === 1) now.value = 120_001
        if (eventId === EVENT_B && attempt === 1) now.value = 180_000
      }
      return originalFetch(input, init)
    })

    emitTelegramMessage(9010, 'event A remains delayed', CHAT_A)
    emitTelegramMessage(9011, 'event B progresses', CHAT_B)

    let cycleCompleted = false
    try {
      await reader.pollCycle()
      cycleCompleted = true
    } catch (error) {
      if (!(error instanceof Error) || error.message !== RED_STOP) throw error
    }

    // This assertion is intentionally the first failure on the buggy head: its inline loop
    // sleeps/retries A before even issuing B's provider-authorization request.
    expect(authorizationAttempts.get(EVENT_B)).toBe(1)
    expect(maintenanceRequests.cron).toBeGreaterThan(0)
    expect(maintenanceRequests.workflowClaims).toBeGreaterThan(0)
    expect(accepted).toEqual([{ content: 'event B progresses', eventId: EVENT_B }])
    expect(cycleCompleted).toBe(true)
    expect(retryDelays).toEqual([])
  })
})

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  telegram.instances.length = 0
})

afterAll(() => {
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})
