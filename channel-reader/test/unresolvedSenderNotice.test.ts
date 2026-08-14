import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChannelReader, type ChannelReaderOptions, UNRESOLVED_NOTICE_GLOBAL_CAP } from '../src/main'
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

  // The body is deliberately a WELL-FORMED unresolved payload. An unparseable
  // body would exercise the catch path instead, which returns the same shape, so
  // the assertion would hold with the `!response.ok` guard deleted. Only a
  // parseable `reason: 'unresolved'` on a non-2xx proves the status is what
  // suppresses the reason.
  it('returns no reason when the response is not ok, so callers stay silent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ authorized: false, reason: 'unresolved' }), { status: 503 })
      )
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
  medium?: 'slack' | 'telegram' | 'teams' | 'email'
  ephemeralThrows?: boolean
  sendMessageThrows?: boolean
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
  const sendMessageThrows = options.sendMessageThrows ?? false
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
  const sendMessage = vi.fn(async () => {
    if (sendMessageThrows) throw new Error('telegram_send_failed')
  })

  const adapter: ChannelAdapter = {
    channelType: medium,
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    fetchMessages: vi.fn(async () => []),
    sendMessage,
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
  /**
   * `providerChannelId` defaults to `channelId` because that is what Slack does
   * today; the tests that pin WHICH id scopes the limiter pass a different value.
   */
  const buildMessage = (
    channelId: string,
    userId: string,
    workspaceId = 'T1',
    providerChannelId = channelId
  ): Message => {
    eventSeq += 1
    return {
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
        providerChannelId,
        // Unique per delivery on purpose. A repeated providerEventId is dropped by
        // the provider-event dedupe *before* authorization runs, which would make
        // every "sent only once" assertion below pass with no rate limiter at all.
        providerEventId: `evt-${eventSeq}`,
      },
    }
  }

  // Deliberately NOT wrapped in `.catch()`: sendUnresolvedSenderNotice has to
  // contain a throwing adapter itself, so an escaped throw must surface here as a
  // rejected promise rather than being absorbed by the harness.
  const deliver = async (
    channelId = 'C1',
    userId = 'U1',
    workspaceId = 'T1',
    providerChannelId = channelId
  ): Promise<void> =>
    reader.handleMessages([buildMessage(channelId, userId, workspaceId, providerChannelId)])

  const deliverBatch = async (messages: Message[]): Promise<void> => reader.handleMessages(messages)

  const runSweep = (): void => {
    ;(reader as unknown as { cleanupStaleApprovals(): void }).cleanupStaleApprovals()
  }

  return {
    buildMessage,
    deliver,
    deliverBatch,
    runSweep,
    sendEphemeral,
    sendMessage,
    adapter,
    authorizeProviderMessage,
  }
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

  // The two ids are identical for Slack today, so these two tests hold the limiter
  // to the PROVIDER id from both directions: a differing transport channelId must
  // not split the key, and a differing providerChannelId must.
  it('scopes the limiter by the provider channel id, not the transport channel id', async () => {
    vi.useFakeTimers()
    const { deliver, sendEphemeral } = buildReader()
    await deliver('C-transport', 'U1', 'T1', 'C1')
    await deliver('C-transport', 'U1', 'T1', 'C2')
    expect(sendEphemeral).toHaveBeenCalledTimes(2)
  })

  it('does not re-notify when only the transport channel id changes', async () => {
    vi.useFakeTimers()
    const { deliver, sendEphemeral } = buildReader()
    await deliver('C-transport-a', 'U1', 'T1', 'C1')
    await deliver('C-transport-b', 'U1', 'T1', 'C1')
    expect(sendEphemeral).toHaveBeenCalledTimes(1)
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
    // Nothing catches for us: an uncontained throw rejects this and fails the test.
    await expect(deliver('C1', 'U1')).resolves.toBeUndefined()
    await deliver('C1', 'U1')
    expect(sendEphemeral).toHaveBeenCalledTimes(1)
  })

  // The notice is best-effort; the batch is not. SlackAdapter swallows its own
  // errors today, but ChannelAdapter.sendEphemeral does not promise that, and this
  // runs inside the per-message loop in handleMessages.
  it('keeps processing the rest of the batch when sendEphemeral throws', async () => {
    const { buildMessage, deliverBatch, sendEphemeral, authorizeProviderMessage } = buildReader({
      ephemeralThrows: true,
    })
    await expect(
      deliverBatch([buildMessage('C1', 'U1'), buildMessage('C2', 'U2')])
    ).resolves.toBeUndefined()
    // Both messages reached authorization, and both got their own notice attempt:
    // a throw escaping the first would have aborted the loop at one apiece.
    expect(authorizeProviderMessage).toHaveBeenCalledTimes(2)
    expect(sendEphemeral).toHaveBeenCalledTimes(2)
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

  it('never sends for email, the one medium the guard excludes', async () => {
    // Slack, Teams, and Telegram all send now (Telegram via sendMessage, asserted
    // below), so this can no longer be phrased as "non-Slack" -- email is the
    // only medium sendUnresolvedSenderNotice's top guard still drops.
    const { deliver, sendEphemeral, sendMessage } = buildReader({ medium: 'email' })
    await deliver('C1', 'U1')
    expect(sendEphemeral).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
  })
})

describe('unresolved sender notice on Teams', () => {
  it('sends a threaded notice to an unresolved Teams sender', async () => {
    const { deliver, sendMessage } = buildReader({
      medium: 'teams',
      profileUiUrl: 'https://profile.test',
    })

    await deliver()

    expect(sendMessage).toHaveBeenCalledTimes(1)
    const [channelId, content, replyToMessageId] = sendMessage.mock.calls[0]
    expect(channelId).toBe('C1')
    expect(content).toContain('https://profile.test')
    // Threading is the whole mitigation for Teams having no ephemeral concept:
    // a top-level post would announce the notice to the entire channel.
    expect(replyToMessageId).toBeTruthy()
  })

  it('sends the Teams notice at most once per user per conversation', async () => {
    const { deliver, sendMessage } = buildReader({ medium: 'teams' })

    await deliver()
    await deliver()

    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  it('delivers the Teams notice via sendMessage, never sendEphemeral', async () => {
    const { deliver, sendEphemeral, sendMessage } = buildReader({ medium: 'teams' })

    await deliver()

    // Pinned in both directions: if TeamsAdapter ever grows a sendEphemeral shim
    // and this code gets routed onto it, the notice becomes invisible to everyone
    // and the feature silently dies. sendMessage having been called is what makes
    // this assertion able to fail; sendEphemeral alone cannot, since it is also
    // uncalled when Teams is dropped at the provider guard entirely.
    expect(sendEphemeral).not.toHaveBeenCalled()
    expect(sendMessage).toHaveBeenCalled()
  })
})

describe('unresolved sender notice on Telegram', () => {
  it('sends a terse Telegram notice with no product or profile details', async () => {
    const { deliver, sendMessage } = buildReader({
      medium: 'telegram',
      profileUiUrl: 'https://profile.test',
    })

    await deliver()

    const content = sendMessage.mock.calls[0][1] as string
    expect(content).not.toMatch(/evenfire/i)
    expect(content).not.toMatch(/profile/i)
    expect(content).not.toMatch(/https?:\/\//)
  })

  it('delivers the Telegram notice with no reply id, unlike Teams', async () => {
    const { deliver, sendMessage } = buildReader({ medium: 'telegram' })

    await deliver()

    expect(sendMessage).toHaveBeenCalledTimes(1)
    // Teams threads under the triggering message via a third argument; Telegram
    // must not. Group and supergroup chats do have a channel-wide audience (see
    // telegramOperationalMessage.ts), so this is not a threading-is-pointless
    // argument; the copy itself is deliberately terse so a top-level post leaks
    // nothing meaningful, and threading here is a possible follow-up.
    expect(sendMessage.mock.calls[0]).toEqual(['C1', expect.any(String)])
  })

  // Real Telegram messages always carry providerWorkspaceId: null (Telegram has no
  // workspace/tenant concept), unlike Slack and Teams, which require one. A guard
  // that keeps requiring a workspace id for every provider would silently drop
  // this notice for every real Telegram sender while still passing a test harness
  // that defaults workspaceId to a non-empty string.
  it('sends the Telegram notice even though Telegram messages carry no workspace id', async () => {
    const { deliver, sendMessage } = buildReader({ medium: 'telegram' })

    await deliver('C1', 'U1', '')

    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  it('records the key even when sendMessage throws, so one failure is not retried forever', async () => {
    const { deliver, sendMessage } = buildReader({ medium: 'telegram', sendMessageThrows: true })
    // Nothing catches for us: an uncontained throw rejects this and fails the test.
    await expect(deliver('C1', 'U1')).resolves.toBeUndefined()
    await deliver('C1', 'U1')
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  // The notice is best-effort; the batch is not. TelegramAdapter.sendMessage
  // rethrows on failure (unlike SlackAdapter, which swallows its own errors), and
  // this runs inside the per-message loop in handleMessages.
  it('keeps processing the rest of the batch when sendMessage throws', async () => {
    const { buildMessage, deliverBatch, sendMessage, authorizeProviderMessage } = buildReader({
      medium: 'telegram',
      sendMessageThrows: true,
    })
    await expect(
      deliverBatch([buildMessage('C1', 'U1'), buildMessage('C2', 'U2')])
    ).resolves.toBeUndefined()
    // Both messages reached authorization, and both got their own notice attempt:
    // a throw escaping the first would have aborted the loop at one apiece.
    expect(authorizeProviderMessage).toHaveBeenCalledTimes(2)
    expect(sendMessage).toHaveBeenCalledTimes(2)
  })
})

describe('unresolved notice global cap', () => {
  it('stops sending notices once the global cap is reached', async () => {
    const { deliverBatch, sendMessage, buildMessage } = buildReader({ medium: 'teams' })

    // Distinct users so the per-conversation dedup never fires and only the
    // global cap can be what stops the sends.
    const messages = Array.from({ length: UNRESOLVED_NOTICE_GLOBAL_CAP + 5 }, (_, i) =>
      buildMessage('C1', `U${i}`, 'T1')
    )
    await deliverBatch(messages)

    expect(sendMessage).toHaveBeenCalledTimes(UNRESOLVED_NOTICE_GLOBAL_CAP)
  })

  it('warns exactly once for the transition into the capped state, not once per blocked send', async () => {
    // A prior ruling had this NOT deduplicate, on the theory that a repeated
    // line is the signal. That was wrong: at the cap, one warning per inbound
    // message from every unresolved sender across every provider is loudest in
    // exactly the misconfiguration the cap exists to contain.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { deliverBatch, buildMessage } = buildReader({ medium: 'teams' })

    const messages = Array.from({ length: UNRESOLVED_NOTICE_GLOBAL_CAP + 5 }, (_, i) =>
      buildMessage('C1', `U${i}`, 'T1')
    )
    await deliverBatch(messages)

    const capWarnings = warnSpy.mock.calls.filter(call =>
      String(call[0]).includes('Unresolved-sender notice cap')
    )
    expect(capWarnings).toHaveLength(1)
    expect(String(capWarnings[0][0])).toContain(String(UNRESOLVED_NOTICE_GLOBAL_CAP))

    warnSpy.mockRestore()
  })

  it('warns again on a later trip into the cap, once the TTL sweep drains records below it', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { deliverBatch, buildMessage, runSweep } = buildReader({ medium: 'teams' })

    const firstBatch = Array.from({ length: UNRESOLVED_NOTICE_GLOBAL_CAP + 5 }, (_, i) =>
      buildMessage('C1', `U${i}`, 'T1')
    )
    await deliverBatch(firstBatch)

    // Past UNRESOLVED_NOTICE_TTL_MS (24h): the sweep evicts every record from the
    // first batch, dropping the map back under the cap.
    await vi.advanceTimersByTimeAsync(25 * 60 * 60 * 1000)
    runSweep()

    const secondBatch = Array.from({ length: UNRESOLVED_NOTICE_GLOBAL_CAP + 5 }, (_, i) =>
      buildMessage('C1', `V${i}`, 'T1')
    )
    await deliverBatch(secondBatch)

    const capWarnings = warnSpy.mock.calls.filter(call =>
      String(call[0]).includes('Unresolved-sender notice cap')
    )
    // One for the first trip into the cap, one for the second: still not one
    // per blocked send within either batch.
    expect(capWarnings).toHaveLength(2)

    warnSpy.mockRestore()
    vi.useRealTimers()
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
