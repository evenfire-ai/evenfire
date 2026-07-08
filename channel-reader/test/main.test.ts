import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChannelAdapter, CommunicationChannelCRD } from '../src/types'

/**
 * Tests for the channel validation and config parsing utilities in main.ts.
 *
 * The ChannelReader class itself (polling loop, K8s watcher) is integration-territory:
 * it spawns long-lived timers and requires a real or heavily mocked K8s environment.
 * Here we test the pure logic that can be extracted or verified independently.
 */

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

vi.mock('../src/config', () => ({
  get config() {
    return {
      devMode: true,
      hostRef: 'test-host',
      mcpHostUrl: 'http://localhost:9999',
      pollIntervalSeconds: 1,
      namespace: '',
      devChannelConfig: undefined,
    }
  },
}))

// k8sClient is only used in production mode — safe to stub in unit tests
vi.mock('../src/k8sClient', () => ({
  CommunicationChannelWatcher: vi.fn().mockImplementation(function () {
    return {
      onChange: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    }
  }),
}))

vi.mock('../src/channels', () => ({
  TelegramAdapter: vi.fn().mockImplementation(function () {
    return {
      channelType: 'telegram',
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      fetchMessages: vi.fn().mockResolvedValue([]),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    }
  }),
  EmailAdapter: vi.fn().mockImplementation(function () {
    return {
      channelType: 'email',
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      fetchMessages: vi.fn().mockResolvedValue([]),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    }
  }),
  SlackAdapter: vi.fn().mockImplementation(function () {
    return {
      channelType: 'slack',
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      fetchMessages: vi.fn().mockResolvedValue([]),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    }
  }),
}))

vi.mock('../src/rpcClient', () => ({
  RPCClient: vi.fn().mockImplementation(function () {
    return {
      sendMessage: vi.fn().mockResolvedValue({ success: true }),
      sendApproval: vi.fn().mockResolvedValue({ success: true }),
      sendDenial: vi.fn().mockResolvedValue({ success: true }),
      sendWorkflowApprovalDecision: vi.fn().mockResolvedValue({ success: true }),
      healthCheck: vi.fn().mockResolvedValue(true),
    }
  }),
}))

// ── CRD shape helpers ─────────────────────────────────────────────────────────

function makeCRD(overrides?: object) {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'CommunicationChannel',
    metadata: { name: 'ch1' },
    spec: {
      hostRef: 'test-host',
      channels: {
        telegram: [{ channelId: '111222', userIds: ['123456'] }],
      },
    },
    ...overrides,
  }
}

// ── Inline type replica (mirrors CommunicationChannelCRD from types.ts) ───────

type ChanCRD = {
  spec: {
    hostRef: string
    channels?: {
      telegram?: Array<{ channelId: string; userIds: string[] }>
      email?: Array<{ channelId: string; userIds: string[] }>
      slack?: Array<{ channelId: string; userIds: string[] }>
    }
  }
}

// ── Utility helpers extracted from the behavior of main.ts ───────────────────

/**
 * Replicates the channel extraction logic from ChannelReader.
 * Converts the CRD spec into a flat list of (channelType, channelId, allowedSenders).
 */
function extractChannels(crd: ChanCRD): Array<{
  type: string
  channelId: string
  allowedSenders: Set<string>
}> {
  const result: Array<{ type: string; channelId: string; allowedSenders: Set<string> }> = []
  const ch = crd.spec.channels
  if (!ch) return result
  for (const entry of ch.telegram || []) {
    result.push({
      type: 'telegram',
      channelId: entry.channelId,
      allowedSenders: new Set(entry.userIds),
    })
  }
  for (const entry of ch.email || []) {
    result.push({
      type: 'email',
      channelId: entry.channelId,
      allowedSenders: new Set(entry.userIds),
    })
  }
  for (const entry of ch.slack || []) {
    result.push({
      type: 'slack',
      channelId: entry.channelId,
      allowedSenders: new Set(entry.userIds),
    })
  }
  return result
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Channel CRD — extractChannels()', () => {
  it('extracts telegram channels from CRD spec', () => {
    const crd = makeCRD()
    const channels = extractChannels(crd as ChanCRD)

    expect(channels).toHaveLength(1)
    expect(channels[0]!.type).toBe('telegram')
    expect(channels[0]!.channelId).toBe('111222')
    expect(channels[0]!.allowedSenders.has('123456')).toBe(true)
  })

  it('extracts multi-channel CRD (telegram + email + slack)', () => {
    const crd = makeCRD({
      spec: {
        hostRef: 'test-host',
        channels: {
          telegram: [{ channelId: 't1', userIds: ['u1'] }],
          email: [{ channelId: 'INBOX', userIds: ['alice@example.com'] }],
          slack: [{ channelId: 'general', userIds: ['bob'] }],
        },
      },
    })

    const channels = extractChannels(crd as ChanCRD)
    expect(channels).toHaveLength(3)
    expect(channels.map(c => c.type)).toEqual(['telegram', 'email', 'slack'])
  })

  it('returns empty array when channels is absent', () => {
    const crd = { spec: { hostRef: 'test-host' } }
    const channels = extractChannels(crd as ChanCRD)
    expect(channels).toEqual([])
  })

  it('collects multiple entries per channel type', () => {
    const crd = makeCRD({
      spec: {
        hostRef: 'test-host',
        channels: {
          telegram: [
            { channelId: 'ch1', userIds: ['u1'] },
            { channelId: 'ch2', userIds: ['u2', 'u3'] },
          ],
        },
      },
    })

    const channels = extractChannels(crd as ChanCRD)
    expect(channels).toHaveLength(2)
    expect(channels[1]!.allowedSenders.size).toBe(2)
  })
})

describe('Channel CRD — allowedSenders Set', () => {
  it('allowedSenders Set correctly filters authorized vs unauthorized', () => {
    const crd = makeCRD({
      spec: {
        hostRef: 'test-host',
        channels: {
          telegram: [{ channelId: '111222', userIds: ['111', '222'] }],
        },
      },
    })

    const [ch] = extractChannels(crd as ChanCRD)
    expect(ch!.allowedSenders.has('111')).toBe(true)
    expect(ch!.allowedSenders.has('999')).toBe(false)
  })
})

describe('ChannelReader.validateChannelConfig Slack identity shape', () => {
  it('requires stable Slack channel and workspace ids for stable user ID allowlists', async () => {
    const { ChannelReader } = await import('../src/main')
    const reader = new ChannelReader({
      rpcClient: { healthCheck: vi.fn().mockResolvedValue(true) } as never,
    })

    expect(() =>
      reader.validateChannelConfig({
        name: 'slack-by-name',
        namespace: 'channels',
        spec: {
          hostRef: 'h',
          slack: [{ channelId: '#general', workspaceId: 'T123', userIds: ['U123'] }],
        },
      })
    ).toThrow(/stable Slack channel ID/)

    expect(() =>
      reader.validateChannelConfig({
        name: 'slack-missing-workspace',
        namespace: 'channels',
        spec: {
          hostRef: 'h',
          slack: [{ channelId: 'C123', userIds: ['U123'] }],
        },
      })
    ).toThrow(/workspaceId/)
  })

  it('keeps legacy Slack username allowlists schema-compatible for non-workflow chat', async () => {
    const { ChannelReader } = await import('../src/main')
    const reader = new ChannelReader({
      rpcClient: { healthCheck: vi.fn().mockResolvedValue(true) } as never,
    })

    expect(() =>
      reader.validateChannelConfig({
        name: 'slack-legacy-by-name',
        namespace: 'channels',
        spec: {
          hostRef: 'h',
          slack: [{ channelId: '#general', userNames: ['alice'] }],
        },
      })
    ).not.toThrow()
  })
})

describe('ChannelReader.initializeAdapters per-CC credentials', () => {
  it('connects one Telegram adapter per distinct CommunicationChannel token', async () => {
    const appleConnect = vi.fn().mockResolvedValue(undefined)
    const zebraConnect = vi.fn().mockResolvedValue(undefined)
    const adapters = new Map<string, ChannelAdapter>([
      [
        'telegram:channels/cc-apple',
        {
          channelType: 'telegram' as const,
          connect: appleConnect,
          disconnect: vi.fn().mockResolvedValue(undefined),
          fetchMessages: vi.fn().mockResolvedValue([]),
          sendMessage: vi.fn().mockResolvedValue(undefined),
          editMessage: vi.fn().mockResolvedValue(undefined),
        },
      ],
      [
        'telegram:channels/cc-zebra',
        {
          channelType: 'telegram' as const,
          connect: zebraConnect,
          disconnect: vi.fn().mockResolvedValue(undefined),
          fetchMessages: vi.fn().mockResolvedValue([]),
          sendMessage: vi.fn().mockResolvedValue(undefined),
          editMessage: vi.fn().mockResolvedValue(undefined),
        },
      ],
    ])

    const ccZ: CommunicationChannelCRD = {
      name: 'cc-zebra',
      namespace: 'channels',
      spec: {
        hostRef: 'h',
        credentialsSecretRef: { name: 'sec-z' },
        telegram: [{ channelId: '0', userIds: ['0'] }],
      },
    }
    const ccA: CommunicationChannelCRD = {
      name: 'cc-apple',
      namespace: 'channels',
      spec: {
        hostRef: 'h',
        credentialsSecretRef: { name: 'sec-a' },
        telegram: [{ channelId: '1', userIds: ['1'] }],
      },
    }

    const resolver = {
      resolve: vi.fn().mockImplementation(async (cc: CommunicationChannelCRD) => {
        if (cc.name === 'cc-zebra') return { telegramBotToken: 'z-token' }
        if (cc.name === 'cc-apple') return { telegramBotToken: 'a-token' }
        return {}
      }),
    }
    const { ChannelReader } = await import('../src/main')
    const reader = new ChannelReader({
      adapters,
      channels: [ccZ, ccA],
      credentialsResolver: resolver as never,
      rpcClient: {
        healthCheck: vi.fn().mockResolvedValue(true),
      } as never,
    })

    await reader.initializeAdapters()

    expect(appleConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        telegramBotToken: 'a-token',
        providerTarget: expect.objectContaining({
          hostRef: 'h',
          communicationChannelNamespace: 'channels',
          communicationChannelName: 'cc-apple',
        }),
        providerTargets: [
          expect.objectContaining({
            communicationChannelName: 'cc-apple',
          }),
        ],
      })
    )
    expect(zebraConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        telegramBotToken: 'z-token',
        providerTarget: expect.objectContaining({
          hostRef: 'h',
          communicationChannelNamespace: 'channels',
          communicationChannelName: 'cc-zebra',
        }),
        providerTargets: [
          expect.objectContaining({
            communicationChannelName: 'cc-zebra',
          }),
        ],
      })
    )
  })

  it('polls each Telegram CommunicationChannel through its own token adapter', async () => {
    const appleFetch = vi.fn().mockResolvedValue([])
    const zebraFetch = vi.fn().mockResolvedValue([])
    const adapters = new Map<string, ChannelAdapter>([
      [
        'telegram:channels/cc-apple',
        {
          channelType: 'telegram' as const,
          connect: vi.fn().mockResolvedValue(undefined),
          disconnect: vi.fn().mockResolvedValue(undefined),
          fetchMessages: appleFetch,
          sendMessage: vi.fn().mockResolvedValue(undefined),
          editMessage: vi.fn().mockResolvedValue(undefined),
        },
      ],
      [
        'telegram:channels/cc-zebra',
        {
          channelType: 'telegram' as const,
          connect: vi.fn().mockResolvedValue(undefined),
          disconnect: vi.fn().mockResolvedValue(undefined),
          fetchMessages: zebraFetch,
          sendMessage: vi.fn().mockResolvedValue(undefined),
          editMessage: vi.fn().mockResolvedValue(undefined),
        },
      ],
    ])
    const channels: CommunicationChannelCRD[] = [
      {
        name: 'cc-apple',
        namespace: 'channels',
        spec: {
          hostRef: 'h',
          credentialsSecretRef: { name: 'sec-a' },
          telegram: [{ channelId: 'apple-chat', chatType: 'private' }],
        },
      },
      {
        name: 'cc-zebra',
        namespace: 'channels',
        spec: {
          hostRef: 'h',
          credentialsSecretRef: { name: 'sec-z' },
          telegram: [{ channelId: 'zebra-chat', chatType: 'private' }],
        },
      },
    ]
    const resolver = {
      resolve: vi.fn().mockImplementation(async (cc: CommunicationChannelCRD) => {
        if (cc.name === 'cc-apple') return { telegramBotToken: 'a-token' }
        if (cc.name === 'cc-zebra') return { telegramBotToken: 'z-token' }
        return {}
      }),
    }

    const { ChannelReader } = await import('../src/main')
    const reader = new ChannelReader({
      adapters,
      channels,
      credentialsResolver: resolver as never,
      notificationDeliveryClient: null,
      rpcClient: {
        healthCheck: vi.fn().mockResolvedValue(true),
        getCronResults: vi.fn().mockResolvedValue([]),
      } as never,
    })

    await reader.initializeAdapters()
    await reader.pollCycle()

    expect(appleFetch).toHaveBeenCalledWith(
      'apple-chat',
      expect.any(Set),
      expect.objectContaining({
        providerTarget: expect.objectContaining({ communicationChannelName: 'cc-apple' }),
      })
    )
    expect(zebraFetch).toHaveBeenCalledWith(
      'zebra-chat',
      expect.any(Set),
      expect.objectContaining({
        providerTarget: expect.objectContaining({ communicationChannelName: 'cc-zebra' }),
      })
    )
    expect(appleFetch).not.toHaveBeenCalledWith('zebra-chat', expect.anything(), expect.anything())
    expect(zebraFetch).not.toHaveBeenCalledWith('apple-chat', expect.anything(), expect.anything())
  })

  it('delivers cron results through the adapter for the origin CommunicationChannel', async () => {
    const appleSend = vi.fn().mockResolvedValue(undefined)
    const zebraSend = vi.fn().mockResolvedValue(undefined)
    const adapters = new Map<string, ChannelAdapter>([
      [
        'telegram:channels/cc-apple',
        {
          channelType: 'telegram' as const,
          connect: vi.fn().mockResolvedValue(undefined),
          disconnect: vi.fn().mockResolvedValue(undefined),
          fetchMessages: vi.fn().mockResolvedValue([]),
          sendMessage: appleSend,
          editMessage: vi.fn().mockResolvedValue(undefined),
        },
      ],
      [
        'telegram:channels/cc-zebra',
        {
          channelType: 'telegram' as const,
          connect: vi.fn().mockResolvedValue(undefined),
          disconnect: vi.fn().mockResolvedValue(undefined),
          fetchMessages: vi.fn().mockResolvedValue([]),
          sendMessage: zebraSend,
          editMessage: vi.fn().mockResolvedValue(undefined),
        },
      ],
    ])
    const channels: CommunicationChannelCRD[] = [
      {
        name: 'cc-apple',
        namespace: 'channels',
        spec: {
          hostRef: 'h',
          credentialsSecretRef: { name: 'sec-a' },
          telegram: [{ channelId: 'apple-chat', chatType: 'private' }],
        },
      },
      {
        name: 'cc-zebra',
        namespace: 'channels',
        spec: {
          hostRef: 'h',
          credentialsSecretRef: { name: 'sec-z' },
          telegram: [{ channelId: 'zebra-chat', chatType: 'private' }],
        },
      },
    ]
    const resolver = {
      resolve: vi.fn().mockImplementation(async (cc: CommunicationChannelCRD) => {
        if (cc.name === 'cc-apple') return { telegramBotToken: 'a-token' }
        if (cc.name === 'cc-zebra') return { telegramBotToken: 'z-token' }
        return {}
      }),
    }
    const acknowledgeCronResult = vi.fn().mockResolvedValue(undefined)

    const { ChannelReader } = await import('../src/main')
    const reader = new ChannelReader({
      adapters,
      channels,
      credentialsResolver: resolver as never,
      notificationDeliveryClient: null,
      rpcClient: {
        healthCheck: vi.fn().mockResolvedValue(true),
        getCronResults: vi.fn().mockResolvedValue([
          {
            id: 'cron-result-1',
            origin: { channelType: 'telegram', channelId: 'zebra-chat', sender: 'cron' },
            response: 'cron complete',
            cronJobId: 'cron-job-1',
            cronJobName: 'Nightly job',
            timestamp: '2026-06-24T00:00:00.000Z',
            status: 'completed',
          },
        ]),
        acknowledgeCronResult,
      } as never,
    })

    await reader.initializeAdapters()
    await reader.pollCycle()

    expect(zebraSend).toHaveBeenCalledWith('zebra-chat', 'cron complete', undefined, undefined)
    expect(appleSend).not.toHaveBeenCalled()
    expect(acknowledgeCronResult).toHaveBeenCalledWith('cron-result-1', {
      channelType: 'telegram',
      channelId: 'zebra-chat',
      sender: 'cron',
    })
  })

  it('omits the adapter when no CC has credentials for that channel-type', async () => {
    const telegramConnect = vi.fn().mockResolvedValue(undefined)
    const adapters = new Map<string, ChannelAdapter>([
      [
        'telegram:channels/cc-x',
        {
          channelType: 'telegram' as const,
          connect: telegramConnect,
          disconnect: vi.fn().mockResolvedValue(undefined),
          fetchMessages: vi.fn().mockResolvedValue([]),
          sendMessage: vi.fn().mockResolvedValue(undefined),
        },
      ],
    ])

    const ccNoCreds: CommunicationChannelCRD = {
      name: 'cc-x',
      namespace: 'channels',
      spec: {
        hostRef: 'h',
        telegram: [{ channelId: '0', userIds: ['0'] }],
      },
    }

    const resolver = { resolve: vi.fn().mockResolvedValue({}) }

    const { ChannelReader } = await import('../src/main')
    const reader = new ChannelReader({
      adapters,
      channels: [ccNoCreds],
      credentialsResolver: resolver as never,
      rpcClient: { healthCheck: vi.fn().mockResolvedValue(true) } as never,
    })

    await reader.initializeAdapters()
    expect(telegramConnect).not.toHaveBeenCalled()
  })

  it('does NOT warn when multiple CCs reference the same Secret (same token)', async () => {
    const telegramConnect = vi.fn().mockResolvedValue(undefined)
    const adapters = new Map<string, ChannelAdapter>([
      [
        'telegram:channels/cc-apple',
        {
          channelType: 'telegram' as const,
          connect: telegramConnect,
          disconnect: vi.fn().mockResolvedValue(undefined),
          fetchMessages: vi.fn().mockResolvedValue([]),
          sendMessage: vi.fn().mockResolvedValue(undefined),
        },
      ],
    ])

    const ccA: CommunicationChannelCRD = {
      name: 'cc-apple',
      namespace: 'channels',
      spec: {
        hostRef: 'h',
        credentialsSecretRef: { name: 'shared-secret' },
        telegram: [{ channelId: '0', userIds: ['0'] }],
      },
    }
    const ccB: CommunicationChannelCRD = {
      name: 'cc-banana',
      namespace: 'channels',
      spec: {
        hostRef: 'h',
        credentialsSecretRef: { name: 'shared-secret' },
        telegram: [{ channelId: '1', userIds: ['1'] }],
      },
    }

    // Both CCs resolve to the SAME token (because shared Secret).
    const resolver = {
      resolve: vi.fn().mockResolvedValue({ telegramBotToken: 'shared-token' }),
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { ChannelReader } = await import('../src/main')
    const reader = new ChannelReader({
      adapters,
      channels: [ccA, ccB],
      credentialsResolver: resolver as never,
      rpcClient: { healthCheck: vi.fn().mockResolvedValue(true) } as never,
    })

    await reader.initializeAdapters()

    expect(telegramConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        telegramBotToken: 'shared-token',
        providerTarget: expect.objectContaining({
          hostRef: 'h',
          communicationChannelNamespace: 'channels',
          communicationChannelName: 'cc-apple',
        }),
        providerTargets: [
          expect.objectContaining({ communicationChannelName: 'cc-apple' }),
          expect.objectContaining({ communicationChannelName: 'cc-banana' }),
        ],
      })
    )
    const conflictWarnings = warn.mock.calls.filter(
      c =>
        typeof c[0] === 'string' &&
        c[0].includes('multiple CCs with different credentialsSecretRef')
    )
    expect(conflictWarnings).toHaveLength(0)
    warn.mockRestore()
  })
})

describe('resolveCredentialsNamespace', () => {
  it('falls back to "channels" when CLERUM_NAMESPACE is empty (single-tenant Clerum)', async () => {
    const { resolveCredentialsNamespace } = await import('../src/main')
    await expect(resolveCredentialsNamespace('')).resolves.toBe('channels')
  })

  it('uses the slug-scoped namespace when CLERUM_NAMESPACE is set (multi-tenant MCC)', async () => {
    const { resolveCredentialsNamespace } = await import('../src/main')
    await expect(resolveCredentialsNamespace('channels-mytenant')).resolves.toBe(
      'channels-mytenant'
    )
  })

  describe('SA file-based self-derivation', () => {
    afterEach(() => {
      vi.doUnmock('fs/promises')
      vi.resetModules()
    })

    it('self-derives namespace from SA file when env is empty and file is present', async () => {
      // Simulate the SA namespace file containing a tenant namespace
      vi.doMock('fs/promises', () => ({
        readFile: vi.fn().mockResolvedValue('channels-fromfile\n'),
      }))
      vi.resetModules()
      const { resolveCredentialsNamespace } = await import('../src/main')
      await expect(resolveCredentialsNamespace('')).resolves.toBe('channels-fromfile')
    })

    it('falls back to "channels" when env is empty and SA file is absent (ENOENT)', async () => {
      // Simulate missing SA file (e.g. dev/test environment)
      vi.doMock('fs/promises', () => ({
        readFile: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
      }))
      vi.resetModules()
      const { resolveCredentialsNamespace } = await import('../src/main')
      await expect(resolveCredentialsNamespace('')).resolves.toBe('channels')
    })

    it('falls back to "channels" when env is empty and SA file contains only whitespace', async () => {
      // Covers the `ns.trim() || 'channels'` branch
      vi.doMock('fs/promises', () => ({
        readFile: vi.fn().mockResolvedValue('\n'),
      }))
      vi.resetModules()
      const { resolveCredentialsNamespace } = await import('../src/main')
      await expect(resolveCredentialsNamespace('')).resolves.toBe('channels')
    })
  })
})
