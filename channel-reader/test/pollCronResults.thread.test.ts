import { describe, expect, it, vi } from 'vitest'
import { SlackAdapter } from '../src/channels/slack'
import { sendTelegramMessage } from '../src/channels/telegramDelivery'
import { ChannelReader } from '../src/main'
import type { Attachment, ChannelAdapter, SendMessageOptions } from '../src/types'

vi.hoisted(() => {
  process.env.CLERUM_HOST_REF = process.env.CLERUM_HOST_REF ?? 'test-host'
})

const response = 'cron output'

type CronOrigin = {
  channelType: 'slack' | 'telegram' | 'teams' | 'email' | 'rpc'
  channelId: string
  sender: string
  threadId?: string
}

function cronResult(origin: CronOrigin, attachments?: Attachment[]) {
  return {
    id: `cron-result-${origin.channelType}`,
    origin,
    response,
    attachments,
    cronJobId: 'job-1',
    cronJobName: 'thread job',
    timestamp: '2026-11-26T00:00:00.000Z',
    status: 'completed' as const,
  }
}

async function deliver(adapter: ChannelAdapter, result: ReturnType<typeof cronResult>) {
  const acknowledgeCronResult = vi.fn(async () => undefined)
  const reader = new ChannelReader({
    rpcClient: {
      getCronResults: vi.fn(async () => [result]),
      acknowledgeCronResult,
    } as never,
    notificationDeliveryClient: null,
    adapters: new Map([[result.origin.channelType, adapter]]),
  })
  await (reader as unknown as { pollCronResults: () => Promise<void> }).pollCronResults()
  return acknowledgeCronResult
}

function recordingAdapter(channelType: ChannelAdapter['channelType']) {
  const sendMessage = vi.fn(async () => undefined)
  const adapter: ChannelAdapter = {
    channelType,
    connect: async () => undefined,
    disconnect: async () => undefined,
    fetchMessages: async () => [],
    sendMessage,
  }
  return { adapter, sendMessage }
}

function connectedSlackAdapter() {
  const postMessage = vi.fn(async () => ({ ok: true, ts: '1700000000.000100' }))
  const uploadV2 = vi.fn(async () => ({ ok: true }))
  const adapter = new SlackAdapter()
  ;(adapter as unknown as { client: unknown }).client = {
    chat: { postMessage },
    files: { uploadV2 },
  }
  return { adapter, postMessage, uploadV2 }
}

function telegramApi() {
  return {
    sendMessage: vi.fn(async () => ({ message_id: 11 })),
    sendPhoto: vi.fn(async () => ({ message_id: 12 })),
    sendDocument: vi.fn(async () => ({ message_id: 13 })),
  }
}

type TelegramApi = ReturnType<typeof telegramApi>

function telegramAdapter(api: TelegramApi) {
  const calls: unknown[][] = []
  const adapter: ChannelAdapter = {
    channelType: 'telegram',
    connect: async () => undefined,
    disconnect: async () => undefined,
    fetchMessages: async () => [],
    sendMessage: async (channelId, content, replyToMessageId, attachments, options) => {
      calls.push([channelId, content, replyToMessageId, attachments, options])
      return sendTelegramMessage(
        { api } as never,
        channelId,
        content,
        replyToMessageId,
        attachments,
        options
      )
    },
  }
  return { adapter, calls }
}

function expectThreadOnEveryMethod(api: TelegramApi, threadId: number) {
  const bodies = [
    ...api.sendMessage.mock.calls.map(call => call[2]),
    ...api.sendPhoto.mock.calls.map(call => call[2]),
    ...api.sendDocument.mock.calls.map(call => call[2]),
  ]
  expect(bodies.length).toBeGreaterThan(0)
  for (const body of bodies) {
    expect(body).toMatchObject({ message_thread_id: threadId })
    expect(typeof body.message_thread_id).toBe('number')
    expect(body).not.toHaveProperty('reply_to_message_id')
  }
}

describe('pollCronResults creating thread', () => {
  it('posts a slack cron result into the creating thread', async () => {
    const { adapter, postMessage } = connectedSlackAdapter()
    const sendMessage = vi.spyOn(adapter, 'sendMessage')
    const attachments = undefined
    const acknowledge = await deliver(
      adapter,
      cronResult(
        { channelType: 'slack', channelId: 'C1', sender: 'U1', threadId: '1234.56' },
        attachments
      )
    )

    expect(sendMessage).toHaveBeenCalledWith('C1', response, '1234.56', attachments)
    expect(postMessage).toHaveBeenCalledTimes(1)
    const body = postMessage.mock.calls[0]?.[0] as { thread_ts?: string; text?: string }
    expect(body.text).toBe(response)
    expect(body.thread_ts).toBe('1234.56')
    expect(acknowledge).toHaveBeenCalledTimes(1)
  })

  it('omits slack thread_ts when the creating thread is absent', async () => {
    const { adapter, postMessage } = connectedSlackAdapter()
    await deliver(
      adapter,
      cronResult({ channelType: 'slack', channelId: 'C1', sender: 'U1', threadId: undefined })
    )

    expect(postMessage).toHaveBeenCalledTimes(1)
    const body = postMessage.mock.calls[0]?.[0] as Record<string, unknown>
    expect(body.channel).toBe('C1')
    expect(body.text).toBe(response)
    expect(Object.prototype.hasOwnProperty.call(body, 'thread_ts')).toBe(false)
  })

  it('posts a telegram cron result into the forum topic and not as a reply', async () => {
    const api = telegramApi()
    const { adapter, calls } = telegramAdapter(api)
    await deliver(
      adapter,
      cronResult({ channelType: 'telegram', channelId: '424242', sender: '123456', threadId: '77' })
    )

    expect(calls).toEqual([
      ['424242', response, undefined, undefined, { telegramMessageThreadId: '77' }],
    ])
    expectThreadOnEveryMethod(api, 77)
  })

  it('does not pass a teams thread id as the reply or the conversation id', async () => {
    const { adapter, sendMessage } = recordingAdapter('teams')
    await deliver(
      adapter,
      cronResult({
        channelType: 'teams',
        channelId: '19:conversation',
        sender: 'user-1',
        threadId: 'activity-1',
      })
    )

    expect(sendMessage.mock.calls).toEqual([['19:conversation', response]])
  })

  it('does not pass an email or rpc thread id as the reply argument', async () => {
    for (const channelType of ['email', 'rpc'] as const) {
      const { adapter, sendMessage } = recordingAdapter(channelType === 'rpc' ? 'email' : 'email')
      const delivered =
        channelType === 'rpc' ? ({ ...adapter, channelType: 'rpc' } as ChannelAdapter) : adapter
      await deliver(
        delivered,
        cronResult({
          channelType,
          channelId: channelType === 'email' ? 'inbox-1' : 'agent-1',
          sender: 'user-1',
          threadId: 'not-a-reply',
        })
      )
      expect(sendMessage.mock.calls).toEqual([
        [channelType === 'email' ? 'inbox-1' : 'agent-1', response],
      ])
    }
  })

  it('keeps teams file attachments without using the thread id as replyToId', async () => {
    const { adapter, sendMessage } = recordingAdapter('teams')
    const attachments: Attachment[] = [
      {
        id: 'file-1',
        kind: 'file',
        mimeType: 'text/plain',
        encoding: 'base64',
        dataBase64: Buffer.from('hello').toString('base64'),
      },
    ]
    await deliver(
      adapter,
      cronResult(
        {
          channelType: 'teams',
          channelId: '19:conversation',
          sender: 'user-1',
          threadId: 'activity-1',
        },
        attachments
      )
    )

    expect(sendMessage).toHaveBeenCalledTimes(1)
    const call = sendMessage.mock.calls[0]
    expect(call?.[0]).toBe('19:conversation')
    expect(call?.[1]).toBe(response)
    expect(call?.[2]).toBeUndefined()
    expect(call?.[3]).toEqual(attachments)
    expect(call).not.toContain('activity-1')
  })
})

describe('sendTelegramMessage forum topic', () => {
  it('sends message_thread_id on every Bot API method and never as reply_to_message_id', async () => {
    const api = telegramApi()
    const options: SendMessageOptions = { telegramMessageThreadId: '77' }
    const jpeg = {
      id: 'img',
      kind: 'image' as const,
      mimeType: 'image/jpeg',
      encoding: 'base64' as const,
      dataBase64: Buffer.from('jpeg-bytes').toString('base64'),
    }

    await sendTelegramMessage({ api } as never, '424242', response, undefined, undefined, options)
    expectThreadOnEveryMethod(api, 77)

    api.sendMessage.mockClear()
    api.sendPhoto.mockClear()
    await sendTelegramMessage(
      { api } as never,
      '424242',
      response,
      undefined,
      [
        { ...jpeg, id: 'img-1' },
        { ...jpeg, id: 'img-2' },
      ],
      options
    )
    expect(api.sendPhoto).toHaveBeenCalledTimes(2)
    expectThreadOnEveryMethod(api, 77)

    api.sendMessage.mockClear()
    api.sendPhoto.mockClear()
    api.sendDocument.mockClear()
    await sendTelegramMessage(
      { api } as never,
      '424242',
      response,
      undefined,
      [
        {
          id: 'doc-1',
          kind: 'file',
          mimeType: 'application/json',
          encoding: 'base64',
          dataBase64: Buffer.from('{"ok":true}').toString('base64'),
          filename: 'result.json',
          sourceTool: 'workflow_result',
        },
      ],
      options
    )
    expect(api.sendDocument).toHaveBeenCalledTimes(1)
    expect(api.sendMessage).toHaveBeenCalled()
    expectThreadOnEveryMethod(api, 77)
  })

  it('omits message_thread_id when the forum topic is not a base-10 integer', async () => {
    for (const threadId of ['77abc', '7.7', '1e2', '-3']) {
      const api = telegramApi()
      await sendTelegramMessage({ api } as never, '424242', response, undefined, undefined, {
        telegramMessageThreadId: threadId,
      })
      const body = api.sendMessage.mock.calls[0]?.[2] as Record<string, unknown>
      expect(Object.prototype.hasOwnProperty.call(body, 'message_thread_id'), threadId).toBe(false)
      expect(Object.prototype.hasOwnProperty.call(body, 'reply_to_message_id'), threadId).toBe(
        false
      )
    }
  })

  it('omits message_thread_id when the forum topic is absent', async () => {
    const api = telegramApi()
    await sendTelegramMessage({ api } as never, '424242', response)
    expect(api.sendMessage).toHaveBeenCalledTimes(1)
    const body = api.sendMessage.mock.calls[0]?.[2] as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(body, 'message_thread_id')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(body, 'reply_to_message_id')).toBe(false)
  })
})
