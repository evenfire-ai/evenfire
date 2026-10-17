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
  rpc: RPCClient
  accepted: Array<{ content: string; messageId: string; eventId?: string }>
  messagePosts: Array<{ content: string; messageId: string; eventId?: string }>
  messagePostStatusesByEvent: Map<string, number[]>
  authorizations: Array<Message['providerIdentity']>
  messageTargets: unknown[]
  messageTraceRunIds: string[]
  messagePostSignals: Array<AbortSignal | undefined>
  now: { value: number }
  retryDelays: number[]
  acceptedBeforeRetry: number[]
  requestCounts: {
    authorizationByEvent: Map<string, number>
    authorizationStatusesByEvent: Map<string, number[]>
  }
  close(): Promise<void>
}

async function createFixture(options: {
  admissionUsesBeforeMessage: number
  authorize?: (call: number, identity: Message['providerIdentity']) => boolean
  responseFault?:
    | 'drop-after-acceptance'
    | 'noncanonical-429-after-acceptance'
    | 'malformed-canonical-429-after-acceptance'
  messageResponseDelayMs?: number
  asyncAcceptance?: boolean
  saturateAdmissionBeforeMessagePostAttempt?: number
}): Promise<RunningFixture> {
  vi.resetModules()
  const { RPCServer } = await import('../../mcp-host/src/server')
  const server = new RPCServer(0)
  const accepted: RunningFixture['accepted'] = []
  const messagePosts: RunningFixture['messagePosts'] = []
  const messagePostStatusesByEvent = new Map<string, number[]>()
  const authorizations: RunningFixture['authorizations'] = []
  const messageTargets: RunningFixture['messageTargets'] = []
  const messageTraceRunIds: string[] = []
  const messagePostSignals: RunningFixture['messagePostSignals'] = []
  const requestCounts = {
    authorizationByEvent: new Map<string, number>(),
    authorizationStatusesByEvent: new Map<string, number[]>(),
  }
  server.onMessage(async (message, requestOptions) => {
    accepted.push({
      content: message.content,
      messageId: message.messageId,
      eventId: message.providerIdentity?.providerEventId,
    })
    if (options.asyncAcceptance && requestOptions?.async) {
      return { success: true, status: 'pending', taskId: 'producer-accepted-task' }
    }
    if (options.messageResponseDelayMs) {
      await new Promise(resolve => setTimeout(resolve, options.messageResponseDelayMs))
    }
    return { success: true, status: 'completed', response: 'accepted' }
  })
  server.onProviderMessageAuthorization(async ({ providerIdentity }) => {
    authorizations.push(providerIdentity)
    return { authorized: options.authorize?.(authorizations.length, providerIdentity) ?? true }
  })
  server.onCronResults(() => [])
  server.onWorkflowApprovalNotificationClaim(() => ({ deliveries: [] }))
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
    adapters: new Map([['telegram', adapter]]),
    sleep: async milliseconds => {
      retryDelays.push(milliseconds)
      acceptedBeforeRetry.push(accepted.length)
      now.value += milliseconds
    },
  })

  const originalFetch = globalThis.fetch.bind(globalThis)
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = new URL(String(input))
    const isMessagePost = requestUrl.pathname === '/v1/runtime/messages' && init?.method === 'POST'
    let authorizationEventId = ''
    let authorizationAttempt = 0
    if (
      requestUrl.pathname === '/v1/runtime/provider-messages/authorize' &&
      typeof init?.body === 'string'
    ) {
      const requestBody = JSON.parse(init.body) as {
        providerIdentity?: { providerEventId?: string }
      }
      authorizationEventId = requestBody.providerIdentity?.providerEventId ?? ''
      authorizationAttempt = (requestCounts.authorizationByEvent.get(authorizationEventId) ?? 0) + 1
      requestCounts.authorizationByEvent.set(authorizationEventId, authorizationAttempt)
    }
    if (isMessagePost && typeof init?.body === 'string') {
      messagePostSignals.push(init.signal ?? undefined)
      const payload = JSON.parse(init.body) as {
        content: string
        messageId: string
        providerIdentity?: { providerEventId?: string; providerTarget?: unknown }
        traceContext?: { runId?: string }
      }
      messageTargets.push(payload.providerIdentity?.providerTarget)
      messageTraceRunIds.push(payload.traceContext?.runId ?? '')
      messagePosts.push({
        content: payload.content,
        messageId: payload.messageId,
        eventId: payload.providerIdentity?.providerEventId,
      })
      const postAttempt = messagePosts.filter(
        post => post.eventId === payload.providerIdentity?.providerEventId
      ).length
      if (options.saturateAdmissionBeforeMessagePostAttempt === postAttempt) {
        for (let index = 0; index < 600; index += 1) admission.admit(now.value)
      }
    }

    const response = await originalFetch(input, init)
    if (isMessagePost && typeof init?.body === 'string') {
      const payload = JSON.parse(init.body) as {
        providerIdentity?: { providerEventId?: string }
      }
      const eventId = payload.providerIdentity?.providerEventId ?? ''
      const statuses = messagePostStatusesByEvent.get(eventId) ?? []
      statuses.push(response.status)
      messagePostStatusesByEvent.set(eventId, statuses)
    }
    if (authorizationEventId) {
      const statuses = requestCounts.authorizationStatusesByEvent.get(authorizationEventId) ?? []
      statuses.push(response.status)
      requestCounts.authorizationStatusesByEvent.set(authorizationEventId, statuses)
    }
    if (isMessagePost && response.status === 200 && options.responseFault) {
      if (options.responseFault === 'drop-after-acceptance') {
        throw new TypeError('simulated response loss after Host acceptance')
      }
      if (options.responseFault === 'malformed-canonical-429-after-acceptance') {
        return new Response(
          JSON.stringify({ error: 'runtime_service_admission_limited', retryAfterSeconds: 1 }),
          {
            status: 429,
            headers: { 'content-type': 'application/json', 'retry-after': 'invalid' },
          }
        )
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
    rpc,
    accepted,
    messagePosts,
    messagePostStatusesByEvent,
    authorizations,
    messageTargets,
    messageTraceRunIds,
    messagePostSignals,
    now,
    retryDelays,
    acceptedBeforeRetry,
    requestCounts,
    async close() {
      vi.stubGlobal('fetch', originalFetch)
      await adapter.disconnect()
      await server.stop()
    },
  }
}

function emitTelegramMessage(messageId: number, text: string, chatId = CHAT_ID): void {
  const bot = telegram.instances.at(-1)
  const handler = bot?.handlers.get('message:text')
  if (!handler) throw new Error('TelegramAdapter did not register the real message producer')
  handler({
    from: { id: 123456, username: 'task106-test-user', is_bot: false },
    chat: { id: Number(chatId), type: 'private' },
    message: { message_id: messageId, date: 1_800_000_000, text },
  })
}

async function drainTelegram(adapter: TelegramAdapter, chatId = CHAT_ID): Promise<Message[]> {
  return adapter.fetchMessages(chatId, new Set(), {
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

    expect(fixture.retryDelays).toEqual([])
    expect(fixture.authorizations).toHaveLength(0)
    expect(fixture.requestCounts.authorizationByEvent.get('telegram:424242:9002')).toBe(1)
    expect(fixture.accepted).toEqual([])

    fixture.now.value += 59_999
    await fixture.reader.pollCycle()
    expect(fixture.requestCounts.authorizationByEvent.get('telegram:424242:9002')).toBe(1)
    expect(fixture.accepted).toEqual([])

    fixture.now.value += 1
    await fixture.reader.pollCycle()
    await vi.waitFor(() => expect(fixture.accepted).toHaveLength(1))

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

    expect(fixture.retryDelays).toEqual([])
    expect(fixture.authorizations).toHaveLength(1)
    expect(fixture.accepted).toEqual([])

    fixture.now.value += 59_999
    await fixture.reader.pollCycle()
    expect(fixture.authorizations).toHaveLength(1)
    expect(fixture.messagePosts).toHaveLength(1)

    fixture.now.value += 1
    await fixture.reader.pollCycle()
    await vi.waitFor(() => expect(fixture.accepted).toHaveLength(1))

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
    expect(fixture.messageTargets).toEqual([
      message?.providerIdentity?.providerTarget,
      message?.providerIdentity?.providerTarget,
    ])
    expect(fixture.messageTraceRunIds[1]).toBe(fixture.messageTraceRunIds[0])
  })

  it('keeps queued order and suppresses duplicate Telegram events during a natural retry', async () => {
    const fixture = await createFixture({ admissionUsesBeforeMessage: 599 })
    fixtures.push(fixture)
    emitTelegramMessage(9004, 'first')
    emitTelegramMessage(9005, 'second')
    emitTelegramMessage(9004, 'duplicate first')
    const messages = await drainTelegram(fixture.adapter)

    await fixture.reader.handleMessages(messages)

    expect(fixture.retryDelays).toEqual([])
    expect(fixture.accepted).toEqual([])

    fixture.now.value += 60_000
    await fixture.reader.pollCycle()
    await vi.waitFor(() => expect(fixture.accepted).toHaveLength(1))
    await fixture.reader.pollCycle()
    await vi.waitFor(() => expect(fixture.accepted).toHaveLength(2))

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

    expect(fixture.retryDelays).toEqual([])
    fixture.now.value += 60_000
    await fixture.reader.pollCycle()
    await vi.waitFor(() => expect(fixture.authorizations).toHaveLength(2))

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

  it('uses no more than one delayed retry when its authorization is rejected again', async () => {
    const fixture = await createFixture({ admissionUsesBeforeMessage: 600 })
    fixtures.push(fixture)
    emitTelegramMessage(9009, 'one delayed retry only')
    const [message] = await drainTelegram(fixture.adapter)

    await fixture.reader.handleMessages([message!])
    expect(fixture.requestCounts.authorizationByEvent.get('telegram:424242:9009')).toBe(1)
    expect(fixture.messagePosts).toHaveLength(0)

    fixture.now.value += 60_000
    for (let index = 0; index < 600; index += 1) {
      expect(fixture.admission.admit(fixture.now.value)).toEqual({ allowed: true })
    }
    await fixture.reader.pollCycle()
    await vi.waitFor(() => {
      expect(
        fixture.requestCounts.authorizationStatusesByEvent.get('telegram:424242:9009')
      ).toEqual([429, 429])
    })

    fixture.now.value += 60_000
    await fixture.reader.pollCycle()
    expect(fixture.requestCounts.authorizationByEvent.get('telegram:424242:9009')).toBe(2)
    expect(fixture.messagePosts).toHaveLength(0)
    expect(fixture.accepted).toEqual([])
  })

  it('discards after a second canonical message-POST 429 without a third attempt', async () => {
    const fixture = await createFixture({
      admissionUsesBeforeMessage: 599,
      saturateAdmissionBeforeMessagePostAttempt: 2,
    })
    fixtures.push(fixture)
    emitTelegramMessage(9015, 'second POST rejection')
    const [message] = await drainTelegram(fixture.adapter)

    await fixture.reader.handleMessages([message!])
    expect(fixture.messagePostStatusesByEvent.get('telegram:424242:9015')).toEqual([429])

    fixture.now.value += 60_000
    await fixture.reader.pollCycle()
    await vi.waitFor(() =>
      expect(fixture.messagePostStatusesByEvent.get('telegram:424242:9015')).toEqual([429, 429])
    )
    await vi.waitFor(() =>
      expect(
        (
          fixture.reader as unknown as {
            telegramAdmissionRetries: { snapshot: { events: number } }
          }
        ).telegramAdmissionRetries.snapshot.events
      ).toBe(0)
    )

    fixture.now.value += 60_000
    await fixture.reader.pollCycle()
    expect(fixture.messagePostStatusesByEvent.get('telegram:424242:9015')).toEqual([429, 429])
    expect(fixture.requestCounts.authorizationByEvent.get('telegram:424242:9015')).toBe(2)
    expect(fixture.accepted).toEqual([])
  })

  it('shares one delayed-retry budget across authorization and message POST stages', async () => {
    const fixture = await createFixture({
      admissionUsesBeforeMessage: 600,
      saturateAdmissionBeforeMessagePostAttempt: 1,
    })
    fixtures.push(fixture)
    emitTelegramMessage(9016, 'one retry across both stages')
    const [message] = await drainTelegram(fixture.adapter)

    await fixture.reader.handleMessages([message!])
    expect(fixture.requestCounts.authorizationStatusesByEvent.get('telegram:424242:9016')).toEqual([
      429,
    ])
    expect(fixture.messagePosts).toEqual([])

    fixture.now.value += 60_000
    await fixture.reader.pollCycle()
    await vi.waitFor(() =>
      expect(fixture.messagePostStatusesByEvent.get('telegram:424242:9016')).toEqual([429])
    )
    await vi.waitFor(() =>
      expect(
        (
          fixture.reader as unknown as {
            telegramAdmissionRetries: { snapshot: { events: number } }
          }
        ).telegramAdmissionRetries.snapshot.events
      ).toBe(0)
    )

    fixture.now.value += 60_000
    await fixture.reader.pollCycle()
    expect(fixture.requestCounts.authorizationByEvent.get('telegram:424242:9016')).toBe(2)
    expect(fixture.messagePostStatusesByEvent.get('telegram:424242:9016')).toEqual([429])
    expect(fixture.accepted).toEqual([])
  })

  it('dispatches independent retries while a slow Telegram status send retains bounded work', async () => {
    const fixture = await createFixture({
      admissionUsesBeforeMessage: 600,
      asyncAcceptance: true,
    })
    fixtures.push(fixture)
    await fixture.adapter.fetchMessages('424243', new Set(), {
      telegramChatType: 'private',
      allowUnlistedSender: true,
      providerTarget: PROVIDER_TARGET,
    })

    const statusCalls: string[] = []
    const releaseStatusSends: Array<() => void> = []
    vi.spyOn(fixture.adapter, 'sendMessage').mockImplementation(async (channelId, content) => {
      if (content === '⏳ Processing your request...') {
        statusCalls.push(channelId)
        await new Promise<void>(resolve => releaseStatusSends.push(resolve))
        return `status-${channelId}`
      }
      return `reply-${channelId}`
    })

    emitTelegramMessage(9110, 'accepted retry A', CHAT_ID)
    emitTelegramMessage(9111, 'independent retry B', '424243')
    const messages = [
      ...(await drainTelegram(fixture.adapter)),
      ...(await drainTelegram(fixture.adapter, '424243')),
    ]
    await fixture.reader.handleMessages(messages)
    expect(fixture.requestCounts.authorizationStatusesByEvent.get('telegram:424242:9110')).toEqual([
      429,
    ])
    expect(fixture.requestCounts.authorizationStatusesByEvent.get('telegram:424243:9111')).toEqual([
      429,
    ])

    fixture.now.value += 60_000
    await fixture.reader.pollCycle()
    await vi.waitFor(() => expect(statusCalls).toHaveLength(1))
    expect(fixture.accepted.map(item => item.eventId)).toEqual(['telegram:424242:9110'])

    // A's runtime message was accepted, but its retained entry remains charged while
    // its Telegram status API call is unresolved. The next stream still gets dispatched.
    await fixture.reader.pollCycle()
    await vi.waitFor(() => expect(statusCalls).toHaveLength(2))
    expect(fixture.accepted.map(item => item.eventId)).toEqual([
      'telegram:424242:9110',
      'telegram:424243:9111',
    ])
    expect(
      (
        fixture.reader as unknown as {
          telegramAdmissionRetries: { snapshot: { events: number; accountedBytes: number } }
        }
      ).telegramAdmissionRetries.snapshot
    ).toMatchObject({ events: 2 })
    expect(
      (
        fixture.reader as unknown as {
          telegramAdmissionRetries: { snapshot: { accountedBytes: number } }
        }
      ).telegramAdmissionRetries.snapshot.accountedBytes
    ).toBeLessThanOrEqual(1024 * 1024)

    releaseStatusSends.forEach(release => release())
    await vi.waitFor(() =>
      expect(
        (
          fixture.reader as unknown as {
            telegramAdmissionRetries: { snapshot: { events: number } }
          }
        ).telegramAdmissionRetries.snapshot.events
      ).toBe(0)
    )
    await fixture.reader.stop()
  })

  it('does not replay a malformed canonical-looking 429 after Host acceptance', async () => {
    const fixture = await createFixture({
      admissionUsesBeforeMessage: 0,
      responseFault: 'malformed-canonical-429-after-acceptance',
    })
    fixtures.push(fixture)
    emitTelegramMessage(9012, 'malformed response after acceptance')
    const [message] = await drainTelegram(fixture.adapter)

    await fixture.reader.handleMessages([message!])
    fixture.now.value += 60_000
    await fixture.reader.pollCycle()

    expect(fixture.accepted).toHaveLength(1)
    expect(fixture.messagePosts).toHaveLength(1)
    expect(fixture.retryDelays).toEqual([])
  })

  it('preserves the MCP Host asynchronous acceptance acknowledgement contract', async () => {
    const fixture = await createFixture({
      admissionUsesBeforeMessage: 0,
      asyncAcceptance: true,
    })
    fixtures.push(fixture)
    emitTelegramMessage(9013, 'asynchronous acceptance')
    const [message] = await drainTelegram(fixture.adapter)

    const response = await fixture.rpc.sendMessage(message!, { async: true })

    expect(response).toMatchObject({
      success: true,
      status: 'pending',
      taskId: 'producer-accepted-task',
    })
    expect(fixture.accepted).toHaveLength(1)
  })

  it('aborts a timed-out Telegram POST and treats its accepted outcome as ambiguous', async () => {
    const fixture = await createFixture({
      admissionUsesBeforeMessage: 0,
      messageResponseDelayMs: 100,
    })
    fixtures.push(fixture)
    emitTelegramMessage(9014, 'bounded ambiguous response')
    const [message] = await drainTelegram(fixture.adapter)
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal)
    const requestedDeadlines: number[] = []
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
      requestedDeadlines.push(milliseconds)
      return nativeTimeout(requestedDeadlines.length === 1 ? milliseconds : 5)
    })

    await fixture.reader.handleMessages([message!])
    await new Promise(resolve => setTimeout(resolve, 120))
    fixture.now.value += 60_000
    await fixture.reader.pollCycle()

    expect(requestedDeadlines).toEqual([15_000, 15_000])
    expect(fixture.messagePostSignals).toHaveLength(1)
    expect(fixture.messagePostSignals[0]?.aborted).toBe(true)
    expect(fixture.accepted).toHaveLength(1)
    expect(fixture.messagePosts).toHaveLength(1)
    expect(fixture.retryDelays).toEqual([])
  })

  it('discards new FIFO followers at the bounded retry-buffer limit without a user notice', async () => {
    const fixture = await createFixture({ admissionUsesBeforeMessage: 600 })
    fixtures.push(fixture)
    const priorLogLevel = process.env.LOG_LEVEL
    process.env.LOG_LEVEL = 'warn'
    const output: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      output.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
      return true
    }) as typeof process.stdout.write)

    for (let index = 0; index < 65; index += 1) {
      emitTelegramMessage(9100 + index, `capacity-overflow-message-${index}`)
    }
    const messages = await drainTelegram(fixture.adapter)
    await fixture.reader.handleMessages(messages)

    const dispositions = output
      .filter(line => line.includes('"event":"telegram_admission_retry_disposition"'))
      .map(line => JSON.parse(line) as Record<string, unknown>)
    expect(messages).toHaveLength(65)
    expect(dispositions).toHaveLength(1)
    expect(dispositions[0]).toMatchObject({
      disposition: 'retry_buffer_full',
      pendingEvents: 64,
    })
    expect(dispositions[0]?.pendingBytes).toBeLessThanOrEqual(1024 * 1024)
    expect(JSON.stringify(dispositions)).not.toContain('capacity-overflow-message')
    expect(fixture.accepted).toEqual([])
    expect(fixture.messagePosts).toEqual([])
    expect(telegram.instances.at(-1)?.api.sendMessage).not.toHaveBeenCalled()

    if (priorLogLevel === undefined) delete process.env.LOG_LEVEL
    else process.env.LOG_LEVEL = priorLogLevel
  })

  it('logs an oversized retry discard using content-free disposition fields', async () => {
    const fixture = await createFixture({ admissionUsesBeforeMessage: 600 })
    fixtures.push(fixture)
    const priorLogLevel = process.env.LOG_LEVEL
    process.env.LOG_LEVEL = 'warn'
    const output: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      output.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
      return true
    }) as typeof process.stdout.write)

    const marker = 'oversized-retry-content-marker'
    emitTelegramMessage(9300, `${marker}${'x'.repeat(1_100_000)}`)
    const [message] = await drainTelegram(fixture.adapter)
    await fixture.reader.handleMessages([message!])

    expect(
      (
        fixture.reader as unknown as {
          telegramAdmissionRetries: { snapshot: { events: number; accountedBytes: number } }
        }
      ).telegramAdmissionRetries.snapshot
    ).toEqual({ events: 0, accountedBytes: 0, streams: 0 })
    expect(fixture.messagePosts).toEqual([])
    expect(fixture.accepted).toEqual([])
    expect(telegram.instances.at(-1)?.api.sendMessage).not.toHaveBeenCalled()
    expect(output.join('')).toContain('"disposition":"retry_buffer_full"')
    expect(output.join('')).not.toContain(marker)

    if (priorLogLevel === undefined) delete process.env.LOG_LEVEL
    else process.env.LOG_LEVEL = priorLogLevel
  })

  it('clears bounded process-local retry state during shutdown', async () => {
    const fixture = await createFixture({ admissionUsesBeforeMessage: 600 })
    fixtures.push(fixture)
    emitTelegramMessage(9200, 'shutdown pending event')
    const [message] = await drainTelegram(fixture.adapter)

    await fixture.reader.handleMessages([message!])
    expect(fixture.requestCounts.authorizationByEvent.get('telegram:424242:9200')).toBe(1)

    await fixture.reader.stop()

    expect(
      (
        fixture.reader as unknown as {
          telegramAdmissionRetries: {
            snapshot: { events: number; accountedBytes: number; streams: number }
          }
        }
      ).telegramAdmissionRetries.snapshot
    ).toEqual({ events: 0, accountedBytes: 0, streams: 0 })
    expect(fixture.messagePosts).toEqual([])
    expect(fixture.accepted).toEqual([])
  })

  it('does not submit an eligible retry when shutdown wins during reauthorization', async () => {
    const fixture = await createFixture({ admissionUsesBeforeMessage: 600 })
    fixtures.push(fixture)
    emitTelegramMessage(9201, 'shutdown during retry authorization')
    const [message] = await drainTelegram(fixture.adapter)
    await fixture.reader.handleMessages([message!])
    expect(fixture.requestCounts.authorizationByEvent.get('telegram:424242:9201')).toBe(1)

    fixture.now.value += 60_000
    const originalFetch = globalThis.fetch.bind(globalThis)
    let releaseAuthorization!: () => void
    let onAuthorizationStarted!: () => void
    const authorizationStarted = new Promise<void>(resolve => {
      onAuthorizationStarted = resolve
    })
    const authorizationGate = new Promise<void>(resolve => {
      releaseAuthorization = resolve
    })
    let heldRetryAuthorization = false
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = new URL(String(input))
      if (
        !heldRetryAuthorization &&
        requestUrl.pathname === '/v1/runtime/provider-messages/authorize' &&
        typeof init?.body === 'string' &&
        (JSON.parse(init.body) as { providerIdentity?: { providerEventId?: string } })
          .providerIdentity?.providerEventId === 'telegram:424242:9201'
      ) {
        heldRetryAuthorization = true
        onAuthorizationStarted()
        await authorizationGate
      }
      return originalFetch(input, init)
    })

    await fixture.reader.pollCycle()
    await authorizationStarted
    await fixture.reader.stop()
    releaseAuthorization()
    await vi.waitFor(() =>
      expect(fixture.requestCounts.authorizationByEvent.get('telegram:424242:9201')).toBe(2)
    )

    expect(fixture.messagePosts).toEqual([])
    expect(fixture.accepted).toEqual([])
    expect(fixture.retryDelays).toEqual([])
  })
})
