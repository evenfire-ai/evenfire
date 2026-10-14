import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import { TelegramAdapter } from '../src/channels/telegram'
import { ChannelReader } from '../src/main'
import { RPCClient } from '../src/rpcClient'
import type { Message } from '../src/types'

type TestBot = {
  handlers: Map<string, (ctx: unknown) => void>
  on: ReturnType<typeof vi.fn>
  catch: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  api: { sendMessage: ReturnType<typeof vi.fn>; sendDocument: ReturnType<typeof vi.fn> }
}

const telegram = vi.hoisted(() => ({
  instances: [] as TestBot[],
}))

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
      on: vi.fn((event: string, handler: (ctx: unknown) => void) => {
        handlers.set(event, handler)
      }),
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

const CHAT_ID = '424242'
const PROVIDER_TARGET = {
  hostRef: 'chatllm',
  communicationChannelNamespace: 'channels',
  communicationChannelName: 'task106-telegram',
}

type RunningFixture = {
  server: { start(): Promise<void>; stop(): Promise<void> }
  admission: {
    admit(nowMs?: number): { allowed: true } | { allowed: false; retryAfterSeconds: number }
  }
  adapter: TelegramAdapter
  reader: ChannelReader
  accepted: Array<{ content: string; messageId: string; eventId?: string }>
  messagePosts: Array<{ content: string; messageId: string; eventId?: string }>
  authorizations: Array<Message['providerIdentity']>
  now: { value: number }
  retryDelays: number[]
  acceptedBeforeRetry: number[]
  close(): Promise<void>
}

async function createFixture(options: {
  admissionUsesBeforeMessage: number
  authorize?: (call: number, identity: Message['providerIdentity']) => boolean
  responseFault?: 'drop-after-acceptance' | 'noncanonical-429-after-acceptance'
}): Promise<RunningFixture> {
  vi.resetModules()
  const { RPCServer } = await import('../../mcp-host/src/server')
  const server = new RPCServer(0)
  const accepted: RunningFixture['accepted'] = []
  const messagePosts: RunningFixture['messagePosts'] = []
  const authorizations: RunningFixture['authorizations'] = []
  server.onMessage(async message => {
    accepted.push({
      content: message.content,
      messageId: message.messageId,
      eventId: message.providerIdentity?.providerEventId,
    })
    return { success: true, status: 'completed', response: 'accepted' }
  })
  server.onProviderMessageAuthorization(async ({ providerIdentity }) => {
    authorizations.push(providerIdentity)
    return { authorized: options.authorize?.(authorizations.length, providerIdentity) ?? true }
  })
  await server.start()
  const address = (server as unknown as { server: { address(): AddressInfo } }).server.address()
  const admission = (
    server as unknown as {
      directServiceAdmission: RunningFixture['admission']
    }
  ).directServiceAdmission
  const now = { value: 120_001 }
  vi.spyOn(Date, 'now').mockImplementation(() => now.value)
  for (let index = 0; index < options.admissionUsesBeforeMessage; index += 1) {
    expect(admission.admit()).toEqual({ allowed: true })
  }

  const adapter = new TelegramAdapter()
  await adapter.connect({ telegramBotToken: 'test-token-not-a-credential' })
  await adapter.fetchMessages(CHAT_ID, new Set(), {
    telegramChatType: 'private',
    allowUnlistedSender: true,
    providerTarget: PROVIDER_TARGET,
  })
  const bot = telegram.instances.at(-1)
  if (!bot) throw new Error('Telegram adapter did not create its producer Bot')

  const retryDelays: number[] = []
  const acceptedBeforeRetry: number[] = []
  const rpc = new RPCClient(`http://127.0.0.1:${address.port}`)
  const reader = new ChannelReader({
    rpcClient: rpc,
    notificationDeliveryClient: null,
    adapters: new Map([['telegram', adapter]]),
    sleep: async milliseconds => {
      retryDelays.push(milliseconds)
      acceptedBeforeRetry.push(accepted.length)
      now.value += milliseconds
    },
  })

  const originalFetch = globalThis.fetch.bind(globalThis)
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const isMessagePost = String(input).includes('/v1/runtime/messages') && init?.method === 'POST'
    if (isMessagePost && typeof init?.body === 'string') {
      const payload = JSON.parse(init.body) as {
        content: string
        messageId: string
        providerIdentity?: { providerEventId?: string }
      }
      messagePosts.push({
        content: payload.content,
        messageId: payload.messageId,
        eventId: payload.providerIdentity?.providerEventId,
      })
    }

    const response = await originalFetch(input, init)
    if (isMessagePost && response.status === 200 && options.responseFault) {
      if (options.responseFault === 'drop-after-acceptance') {
        throw new TypeError('simulated response loss after Host acceptance')
      }
      return new Response(JSON.stringify({ error: 'upstream_rate_limited' }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '1' },
      })
    }
    return response
  })

  return {
    server,
    admission,
    adapter,
    reader,
    accepted,
    messagePosts,
    authorizations,
    now,
    retryDelays,
    acceptedBeforeRetry,
    async close() {
      vi.stubGlobal('fetch', originalFetch)
      await adapter.disconnect()
      await server.stop()
    },
  }
}

function emitTelegramMessage(messageId: number, text: string): void {
  const bot = telegram.instances.at(-1)
  const handler = bot?.handlers.get('message:text')
  if (!handler) throw new Error('TelegramAdapter did not register the real message producer')
  handler({
    from: { id: 123456, username: 'task106-test-user', is_bot: false },
    chat: { id: Number(CHAT_ID), type: 'private' },
    message: { message_id: messageId, date: 1_800_000_000, text },
  })
}

async function drainTelegram(adapter: TelegramAdapter): Promise<Message[]> {
  return adapter.fetchMessages(CHAT_ID, new Set(), {
    telegramChatType: 'private',
    allowUnlistedSender: true,
    providerTarget: PROVIDER_TARGET,
  })
}

const fixtures: RunningFixture[] = []

afterEach(async () => {
  while (fixtures.length) await fixtures.pop()!.close()
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

describe('R40-M1 explicit Telegram admission recovery', () => {
  it('delivers a real Telegram update through the mounted RPC producer', async () => {
    const fixture = await createFixture({ admissionUsesBeforeMessage: 0 })
    fixtures.push(fixture)
    emitTelegramMessage(9001, 'normal delivery')
    const [message] = await drainTelegram(fixture.adapter)

    expect(message?.providerIdentity?.providerEventId).toBe('telegram:424242:9001')
    await fixture.reader.handleMessages([message!])

    expect(fixture.accepted).toEqual([
      { content: 'normal delivery', messageId: '9001', eventId: 'telegram:424242:9001' },
    ])
    expect(fixture.messagePosts).toEqual(fixture.accepted)
    expect(fixture.retryDelays).toEqual([])
  })

  it('retains an update through authorization-stage 429 and retries naturally after Retry-After', async () => {
    const fixture = await createFixture({ admissionUsesBeforeMessage: 600 })
    fixtures.push(fixture)
    emitTelegramMessage(9002, 'authorization-stage limit')
    const [message] = await drainTelegram(fixture.adapter)

    await fixture.reader.handleMessages([message!])

    expect(fixture.retryDelays).toEqual([60_000])
    expect(fixture.acceptedBeforeRetry).toEqual([0])
    expect(fixture.authorizations).toHaveLength(1)
    expect(fixture.accepted).toEqual([
      {
        content: 'authorization-stage limit',
        messageId: '9002',
        eventId: 'telegram:424242:9002',
      },
    ])
  })

  it('retains a message through confirmed pre-acceptance POST 429 and reauthorizes before retry', async () => {
    const fixture = await createFixture({ admissionUsesBeforeMessage: 599 })
    fixtures.push(fixture)
    emitTelegramMessage(9003, 'message-stage limit')
    const [message] = await drainTelegram(fixture.adapter)

    await fixture.reader.handleMessages([message!])

    expect(fixture.retryDelays).toEqual([60_000])
    expect(fixture.acceptedBeforeRetry).toEqual([0])
    expect(fixture.authorizations).toHaveLength(2)
    expect(fixture.authorizations[0]).toEqual(message?.providerIdentity)
    expect(fixture.authorizations[1]).toEqual(message?.providerIdentity)
    expect(fixture.messagePosts).toEqual([
      {
        content: 'message-stage limit',
        messageId: '9003',
        eventId: 'telegram:424242:9003',
      },
      {
        content: 'message-stage limit',
        messageId: '9003',
        eventId: 'telegram:424242:9003',
      },
    ])
    expect(fixture.accepted).toEqual([
      {
        content: 'message-stage limit',
        messageId: '9003',
        eventId: 'telegram:424242:9003',
      },
    ])
  })

  it('keeps queued order and suppresses duplicate Telegram events during a natural retry', async () => {
    const fixture = await createFixture({ admissionUsesBeforeMessage: 599 })
    fixtures.push(fixture)
    emitTelegramMessage(9004, 'first')
    emitTelegramMessage(9005, 'second')
    emitTelegramMessage(9004, 'duplicate first')
    const messages = await drainTelegram(fixture.adapter)

    await fixture.reader.handleMessages(messages)

    expect(fixture.retryDelays).toEqual([60_000])
    expect(fixture.acceptedBeforeRetry).toEqual([0])
    expect(fixture.accepted.map(({ content }) => content)).toEqual(['first', 'second'])
    expect(fixture.authorizations).toHaveLength(3)
  })

  it('does not submit again when authorization changes before a POST retry', async () => {
    const fixture = await createFixture({
      admissionUsesBeforeMessage: 599,
      authorize: call => call === 1,
    })
    fixtures.push(fixture)
    emitTelegramMessage(9006, 'access revoked before retry')
    const [message] = await drainTelegram(fixture.adapter)

    await fixture.reader.handleMessages([message!])

    expect(fixture.retryDelays).toEqual([60_000])
    expect(fixture.acceptedBeforeRetry).toEqual([0])
    expect(fixture.authorizations).toHaveLength(2)
    expect(fixture.accepted).toEqual([])
  })

  it('does not retry when the mounted Host accepted the POST but its response is lost', async () => {
    const fixture = await createFixture({
      admissionUsesBeforeMessage: 0,
      responseFault: 'drop-after-acceptance',
    })
    fixtures.push(fixture)
    emitTelegramMessage(9007, 'ambiguous accepted POST')
    const [message] = await drainTelegram(fixture.adapter)

    await fixture.reader.handleMessages([message!])

    expect(fixture.accepted).toHaveLength(1)
    expect(fixture.accepted[0]?.content).toBe('ambiguous accepted POST')
    expect(fixture.retryDelays).toEqual([])
  })

  it('does not retry a misleading 429 received after the Host accepted the POST', async () => {
    const fixture = await createFixture({
      admissionUsesBeforeMessage: 0,
      responseFault: 'noncanonical-429-after-acceptance',
    })
    fixtures.push(fixture)
    emitTelegramMessage(9008, 'accepted before intermediary 429')
    const [message] = await drainTelegram(fixture.adapter)

    await fixture.reader.handleMessages([message!])

    expect(fixture.accepted).toHaveLength(1)
    expect(fixture.retryDelays).toEqual([])

    // A real Telegram redelivery has the same stable chat/message identity.
    fixture.now.value += 2_000
    emitTelegramMessage(9008, 'accepted before intermediary 429')
    const [redelivered] = await drainTelegram(fixture.adapter)
    await fixture.reader.handleMessages([redelivered!])

    expect(fixture.accepted).toHaveLength(1)
    expect(fixture.retryDelays).toEqual([])
  })
})
