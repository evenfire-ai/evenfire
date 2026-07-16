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

  it('selects Teams when Teams has real config and other providers only have defaults', () => {
    const item = channel({
      spec: {
        hostRef: 'chatllm',
        telegramSettings: { replyOnlyWhenMentioned: false },
        slackSettings: { replyOnlyWhenMentioned: false, replyInThreads: false },
        teamsSettings: {
          appName: 'evenfire',
          appId: '7e9cdb6c-87e8-4b1e-b291-76f7b8bdbe82',
          tenantId: '21e08d37-8d53-4144-87cb-557b8298aed3',
          replyOnlyWhenMentioned: true,
        },
      },
    })

    expect(communicationChannelInitialTab(item)).toBe('teams')
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
      teams: [],
      teamsAppName: '',
      teamsAppId: '',
      teamsTenantId: '',
      teamsReplyOnlyWhenMentioned: false,
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

  it('does not save providers that only have default boolean settings', () => {
    const spec = buildCommunicationChannelSpec({
      accessTeamIds: [],
      accessUserIds: ['user-1'],
      hostRef: 'chatllm',
      slack: [],
      slackBotHandle: '',
      slackReplyOnlyWhenMentioned: true,
      slackReplyInThreads: true,
      slackWorkspaceId: '',
      teams: [],
      teamsAppName: '',
      teamsAppId: '',
      teamsTenantId: '',
      teamsReplyOnlyWhenMentioned: true,
      telegram: [],
      telegramBotHandle: '',
      telegramReplyOnlyWhenMentioned: true,
    })

    expect(spec).toEqual({
      hostRef: 'chatllm',
      access: {
        users: ['user-1'],
        teams: [],
      },
    })
  })
})
