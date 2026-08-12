import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChannelReader, type ChannelReaderOptions } from '../src/main'
import { RPCClient } from '../src/rpcClient'
import type { ChannelAdapter, Message } from '../src/types'

const mockCfg = vi.hoisted(() => ({
  devMode: true,
  hostRef: 'test-host',
  mcpHostUrl: 'http://mcp-host.test',
  namespace: '',
  pollIntervalSeconds: 1,
  devChannelConfig: undefined,
  profileUiUrl: undefined as string | undefined,
}))

vi.mock('../src/config', () => ({
  get config() {
    return mockCfg
  },
}))

describe('authorizeProviderMessage response shape', () => {
  const identity = {
    medium: 'slack' as const,
    providerUserId: 'U1',
    providerWorkspaceId: 'T1',
    providerChannelId: 'C1',
  }

  it('returns the reason from the body when unauthorized', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ authorized: false, reason: 'unresolved' })))
    )
    const client = new RPCClient('http://mcp-host.test')
    expect(await client.authorizeProviderMessage(identity as never)).toEqual({
      authorized: false,
      reason: 'unresolved',
    })
  })

  it('returns no reason when the response is not ok, so callers stay silent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 503 }))
    )
    const client = new RPCClient('http://mcp-host.test')
    expect(await client.authorizeProviderMessage(identity as never)).toEqual({ authorized: false })
  })

  it('returns no reason when the request throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      })
    )
    const client = new RPCClient('http://mcp-host.test')
    expect(await client.authorizeProviderMessage(identity as never)).toEqual({ authorized: false })
  })

  it('omits the reason when an older mcp-host returns only authorized', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ authorized: false })))
    )
    const client = new RPCClient('http://mcp-host.test')
    expect(await client.authorizeProviderMessage(identity as never)).toEqual({ authorized: false })
  })

  it('drops an unrecognized reason value instead of passing it through', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ authorized: false, reason: 'banana' })))
    )
    const client = new RPCClient('http://mcp-host.test')
    const result = await client.authorizeProviderMessage(identity as never)
    expect(result).toEqual({ authorized: false })
    // toEqual alone would not catch a `reason: undefined` key surviving the
    // whitelist check, since it treats an undefined-valued key as absent.
    // Assert the key itself is gone.
    expect('reason' in result).toBe(false)
  })
})

interface BuildReaderOptions {
  /** Omit the key entirely for the default; pass `undefined` for "no reason at all". */
  reason?: 'unresolved' | 'error'
  medium?: 'slack' | 'telegram'
  ephemeralThrows?: boolean
  profileUiUrl?: string
}

/**
 * Build a ChannelReader wired to a single stub adapter and a stub rpcClient that
 * always refuses authorization, plus the seams the notice tests need:
 * `deliver` pushes one message through `handleMessages`, and `runSweep` invokes
 * the periodic cleanup that `pollCycle` runs.
 */
function buildReader(options: BuildReaderOptions = {}) {
  const medium = options.medium ?? 'slack'
  const ephemeralThrows = options.ephemeralThrows ?? false
  // `{ reason: undefined }` has to survive as "no reason", so the default is
  // applied only when the caller omits the key. A `?? 'unresolved'` default
  // would silently turn the absent-reason case into the unresolved case.
  const reason: 'unresolved' | 'error' | undefined =
    'reason' in options ? options.reason : 'unresolved'
  // Reset on every call (not just when passed) so state never leaks between
  // tests that share this hoisted mock config.
  mockCfg.profileUiUrl = options.profileUiUrl

  const sendEphemeral = vi.fn(async (_channelId: string, _userId: string, _content: string) => {
    if (ephemeralThrows) throw new Error('user_not_in_channel')
  })

  const adapter: ChannelAdapter = {
    channelType: medium,
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    fetchMessages: vi.fn(async () => []),
    sendMessage: vi.fn(async () => undefined),
    editMessage: vi.fn(async () => undefined),
    sendEphemeral,
  }

  const authorizeProviderMessage = vi.fn(async () =>
    reason === undefined ? { authorized: false } : { authorized: false, reason }
  )

  const rpcClient = {
    healthCheck: vi.fn(async () => true),
    sendMessage: vi.fn(async () => ({
      success: true,
      status: 'pending' as const,
      taskId: 'task-1',
    })),
    getBaseUrl: vi.fn(() => 'http://mcp-host.test'),
    getTaskResult: vi.fn(),
    sendApproval: vi.fn(),
    sendDenial: vi.fn(),
    sendWorkflowApprovalDecision: vi.fn(),
    getCronResults: vi.fn(async () => []),
    acknowledgeCronResult: vi.fn(),
    authorizeProviderMessage,
  }

  const reader = new ChannelReader({
    rpcClient: rpcClient as unknown as NonNullable<ChannelReaderOptions['rpcClient']>,
    adapters: new Map([[medium, adapter]]),
    sleep: async () => undefined,
  })

  let eventSeq = 0
  const deliver = async (channelId: string, userId: string, workspaceId = 'T1'): Promise<void> => {
    eventSeq += 1
    const message: Message = {
      channelType: medium,
      channelId,
      sender: userId,
      content: 'hello',
      timestamp: new Date(),
      messageId: `msg-${eventSeq}`,
      providerIdentity: {
        medium,
        providerUserId: userId,
        providerWorkspaceId: workspaceId,
        providerChannelId: channelId,
        // Unique per delivery on purpose. A repeated providerEventId is dropped by
        // the provider-event dedupe *before* authorization runs, which would make
        // every "sent only once" assertion below pass with no rate limiter at all.
        providerEventId: `evt-${eventSeq}`,
      },
    }
    // The real Slack adapter never throws (channels/slack.ts swallows Slack
    // errors); the ephemeralThrows stub throws only to prove the limiter key is
    // recorded before the send, so a rejection here is expected in that one case.
    await reader.handleMessages([message]).catch(() => undefined)
  }

  const runSweep = (): void => {
    ;(reader as unknown as { cleanupStaleApprovals(): void }).cleanupStaleApprovals()
  }

  return { deliver, runSweep, sendEphemeral, adapter, authorizeProviderMessage }
}

describe('unresolved sender notice', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends once, and not again for the same user and channel within 24h', async () => {
    vi.useFakeTimers()
    const { deliver, sendEphemeral } = buildReader()
    await deliver('C1', 'U1')
    await deliver('C1', 'U1')
    expect(sendEphemeral).toHaveBeenCalledTimes(1)
  })

  it('posts into the conversation the message came from, addressed to its sender', async () => {
    const { deliver, sendEphemeral } = buildReader()
    await deliver('C1', 'U1')
    // Argument order is load-bearing: sendEphemeral(channelId, userId, content).
    // Swapped, Slack rejects the post, SlackAdapter swallows the error, and the
    // limiter key is already recorded — the sender gets 24h of silence, which is
    // the exact failure this feature exists to remove.
    expect(sendEphemeral).toHaveBeenCalledWith('C1', 'U1', expect.any(String))
  })

  it('sends again after the TTL expires and the sweep runs', async () => {
    vi.useFakeTimers()
    const { deliver, sendEphemeral, runSweep } = buildReader()
    await deliver('C1', 'U1')
    await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1000)
    runSweep()
    await deliver('C1', 'U1')
    expect(sendEphemeral).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000)
    runSweep()
    await deliver('C1', 'U1')
    expect(sendEphemeral).toHaveBeenCalledTimes(2)
  })

  it('treats a second channel as its own conversation', async () => {
    vi.useFakeTimers()
    const { deliver, sendEphemeral } = buildReader()
    await deliver('C1', 'U1')
    await deliver('C2', 'U1')
    expect(sendEphemeral).toHaveBeenCalledTimes(2)
  })

  it('treats a second user in the same channel as its own recipient', async () => {
    vi.useFakeTimers()
    const { deliver, sendEphemeral } = buildReader()
    await deliver('C1', 'U1')
    await deliver('C1', 'U2')
    expect(sendEphemeral).toHaveBeenCalledTimes(2)
  })

  it('treats the same user and channel in a second workspace as its own conversation', async () => {
    vi.useFakeTimers()
    const { deliver, sendEphemeral } = buildReader()
    await deliver('C1', 'U1')
    await deliver('C1', 'U1', 'T2')
    expect(sendEphemeral).toHaveBeenCalledTimes(2)
  })

  it('records the key even when sendEphemeral throws, so one failure is not retried forever', async () => {
    vi.useFakeTimers()
    const { deliver, sendEphemeral } = buildReader({ ephemeralThrows: true })
    await deliver('C1', 'U1')
    await deliver('C1', 'U1')
    expect(sendEphemeral).toHaveBeenCalledTimes(1)
  })

  it('never sends on reason error', async () => {
    const { deliver, sendEphemeral } = buildReader({ reason: 'error' })
    await deliver('C1', 'U1')
    expect(sendEphemeral).not.toHaveBeenCalled()
  })

  it('never sends when the reason is absent', async () => {
    const { deliver, sendEphemeral } = buildReader({ reason: undefined })
    await deliver('C1', 'U1')
    expect(sendEphemeral).not.toHaveBeenCalled()
  })

  it('never sends for a non-Slack medium', async () => {
    const { deliver, sendEphemeral } = buildReader({ medium: 'telegram' })
    await deliver('C1', 'U1')
    expect(sendEphemeral).not.toHaveBeenCalled()
  })
})

describe('unresolved notice link', () => {
  it('appends the profile URL when configured', async () => {
    const { deliver, sendEphemeral } = buildReader({ profileUiUrl: 'https://profile.example.com' })
    await deliver('C1', 'U1')
    expect(sendEphemeral.mock.calls[0][2]).toContain('https://profile.example.com')
  })

  it('sends the copy unchanged when no profile URL is configured', async () => {
    const { deliver, sendEphemeral } = buildReader({ profileUiUrl: undefined })
    await deliver('C1', 'U1')
    const text = sendEphemeral.mock.calls[0][2]
    expect(text).toBe(
      "I can't accept messages from this Slack account. If you haven't linked it yet, " +
        'do that in your evenfire profile. If you think you should already have access, contact your admin.'
    )
    expect(text).not.toContain('undefined')
  })
})
