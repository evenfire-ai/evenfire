import { beforeAll, vi } from 'vitest'
import type { CommunicationChannelCRD, Message } from '../src/types'

export let ChannelReader: typeof import('../src/main').ChannelReader

beforeAll(async () => {
  process.env.CLERUM_DEV_MODE = 'true'
  ;({ ChannelReader } = await import('../src/main'))
})

export function makeMessage(content: string): Message {
  return {
    channelType: 'telegram',
    channelId: 'telegram-chat-1',
    sender: '123456',
    content,
    timestamp: new Date('2026-05-04T00:00:00.000Z'),
    messageId: `msg-${content.replace(/\W+/g, '-')}`,
  }
}

export function makeChannel(): CommunicationChannelCRD {
  return {
    name: 'shared-telegram',
    namespace: 'channels',
    spec: {
      hostRef: 'chatllm',
      telegram: [{ channelId: 'telegram-chat-1', userIds: ['123456'] }],
    },
  }
}

export function makeRpcClient(overrides: Record<string, unknown> = {}) {
  return {
    healthCheck: vi.fn(async () => true),
    sendMessage: vi.fn(),
    getBaseUrl: vi.fn(() => 'http://shared-mcp-host.test'),
    getTaskResult: vi.fn(),
    sendApproval: vi.fn(),
    sendDenial: vi.fn(),
    sendWorkflowApprovalDecision: vi.fn(async () => ({ success: true, duplicate: false })),
    resolveWorkflowApproval: vi.fn(async () => null),
    getCronResults: vi.fn(async () => []),
    acknowledgeCronResult: vi.fn(),
    ...overrides,
  }
}
