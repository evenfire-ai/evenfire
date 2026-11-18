import { afterEach, describe, expect, it, vi } from 'vitest'
import { handoffSlackMessageToChannelReader } from '../src/channelReaderClient.js'
import type { ReaderConfig } from '../src/config.js'
import { normalizeProviderMessage } from '../src/decisionHandler.js'

const cfg: ReaderConfig = {
  port: 0,
  mcpHostBaseUrl: '',
  mcpHostRef: '',
  mcpHostTargets: [],
  enabledMedia: new Set(['slack']),
  mcpHostTimeoutMs: 5000,
  mcpHostMessageTimeoutMs: 120_000,
  rateLimitWindowMs: 60_000,
  rateLimitMaxRequests: 120,
  controlApiBaseUrl: '',
  controlApiToken: '',
  controlApiTimeoutMs: 4000,
  channelReaderUrlTemplate: 'http://channel-reader-{host}:8099',
  channelReaderHandoffToken: 'handoff-token',
  channelReaderHandoffTimeoutMs: 5000,
}

const slackTarget = {
  targetId: 'target-1',
  hostRef: 'chatllm',
  communicationChannelRef: 'channels/slack-main',
  providerWorkspaceId: 'T123',
  replyInThreads: false,
  replyOnlyWhenMentioned: false,
}

function slackEvent(event: Record<string, unknown>) {
  return {
    type: 'event_callback',
    team_id: 'T123',
    event_id: 'Ev-1',
    event: { user: 'U123', text: 'read my mail', ts: '1710000000.000001', ...event },
  }
}

async function handoffBodyFor(payload: unknown): Promise<Record<string, unknown>> {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) })
  vi.stubGlobal('fetch', fetchMock)
  const command = normalizeProviderMessage('slack', payload)
  expect(command).not.toBeNull()
  await expect(handoffSlackMessageToChannelReader(cfg, slackTarget, command!)).resolves.toEqual({
    ok: true,
  })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
  expect(url).toBe('http://channel-reader-chatllm:8099/internal/slack/handoff')
  return JSON.parse(String(init.body)) as Record<string, unknown>
}

describe('Slack message handoff to channel-reader', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('carries the signed event channel_type of a direct message', async () => {
    const body = await handoffBodyFor(
      slackEvent({ type: 'message', channel: 'D123', channel_type: 'im' })
    )
    expect(body).toMatchObject({
      kind: 'slack.message',
      providerChannelId: 'D123',
      providerChannelType: 'im',
    })
  })

  it('sends no conversation type for an app_mention, which carries none', async () => {
    const body = await handoffBodyFor(
      slackEvent({ type: 'app_mention', channel: 'C123', text: '<@UAPP> read my mail' })
    )
    expect(body).toMatchObject({ kind: 'slack.message', providerChannelId: 'C123' })
    expect(body).not.toHaveProperty('providerChannelType')
  })
})
