import { afterEach, describe, expect, it, vi } from 'vitest'
import { handoffSlackMessageToChannelReader } from '../src/channelReaderClient'
import type { ReaderConfig } from '../src/config'
import type { ReaderMessageCommand } from '../src/decisionHandler'

const cfg = {
  channelReaderHandoffToken: 'handoff-token',
  channelReaderHandoffTimeoutMs: 1_000,
  channelReaderUrlTemplate: 'http://reader.test/{host}',
} as ReaderConfig

const target = {
  targetId: 'slack-target',
  hostRef: 'chatllm',
  communicationChannelRef: 'channels/pr-reviewer-slack',
  providerWorkspaceId: 'T123',
  replyInThreads: false,
  replyOnlyWhenMentioned: false,
}

describe('handoffSlackMessageToChannelReader', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends slackFiles on the handoff body', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const command: ReaderMessageCommand = {
      content: 'Review this patch',
      medium: 'slack',
      providerUserId: 'U123',
      providerWorkspaceId: 'T123',
      providerChannelId: 'D123',
      providerEventId: 'slack:T123:D123:1',
      providerMessageTs: '1',
      slackFiles: [
        {
          id: 'F123',
          name: 'fix.patch',
          mimetype: 'text/x-diff',
          size: 42,
          urlPrivateDownload: 'https://files.slack.com/files-pri/T123-F123/download/fix.patch',
        },
      ],
    }

    const result = await handoffSlackMessageToChannelReader(cfg, target, command)

    expect(result).toEqual({ ok: true })
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body.slackFiles).toEqual(command.slackFiles)
  })
})
