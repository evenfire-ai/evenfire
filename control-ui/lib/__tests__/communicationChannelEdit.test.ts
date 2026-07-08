import { describe, expect, it } from 'vitest'
import {
  buildCommunicationChannelSpec,
  communicationChannelInitialTab,
  createCommunicationChannelDraft,
} from '../communicationChannelEdit'
import type { CommunicationChannelItem } from '../communicationChannels'

function channel(overrides: CommunicationChannelItem): CommunicationChannelItem {
  return {
    metadata: { name: 'channel-a', namespace: 'channels' },
    spec: {
      hostRef: 'chatllm',
      access: { users: [], teams: [] },
    },
    ...overrides,
  }
}

describe('communication channel edit helpers', () => {
  it('selects Slack when only Slack has real config', () => {
    const item = channel({
      spec: {
        hostRef: 'chatllm',
        telegramSettings: { replyOnlyWhenMentioned: false },
        slackSettings: {
          botHandle: 'Eventfire Test App',
          replyOnlyWhenMentioned: false,
        },
      },
    })

    expect(communicationChannelInitialTab(item)).toBe('slack')
  })

  it('hydrates Telegram bot handle from the legacy annotation fallback', () => {
    const draft = createCommunicationChannelDraft(
      channel({
        metadata: {
          name: 'telegram-only',
          namespace: 'channels',
          annotations: { 'clerum.io/bot-username': 'legacy_bot' },
        },
        spec: {
          hostRef: 'chatllm',
          telegramSettings: { replyOnlyWhenMentioned: false },
        },
      })
    )

    expect(draft.telegramBotHandle).toBe('legacy_bot')
  })

  it('omits inactive provider settings from the saved spec', () => {
    const spec = buildCommunicationChannelSpec({
      accessTeamIds: [],
      accessUserIds: ['user-1'],
      hostRef: ' chatllm ',
      slack: [],
      slackBotHandle: 'Eventfire Test App',
      slackReplyOnlyWhenMentioned: false,
      slackReplyInThreads: false,
      slackWorkspaceId: '',
      telegram: [],
      telegramBotHandle: '',
      telegramReplyOnlyWhenMentioned: false,
    })

    expect(spec).toEqual({
      hostRef: 'chatllm',
      access: {
        users: ['user-1'],
        teams: [],
      },
      slack: [],
      slackSettings: {
        botHandle: 'Eventfire Test App',
        replyOnlyWhenMentioned: false,
        replyInThreads: false,
      },
    })
  })
})
