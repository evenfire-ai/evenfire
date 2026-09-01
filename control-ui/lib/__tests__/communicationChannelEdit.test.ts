import { describe, expect, it } from 'vitest'
import {
  buildCommunicationChannelSpec,
  communicationChannelInitialTab,
  createCommunicationChannelDraft,
  hasSlackConfigForRequestUrl,
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

  it('keeps the Slack label annotation out of the Request URL gate and nowhere else', () => {
    // Only the Request URL and the app manifest ignore an annotation-only bot
    // handle. The field it fills, the tab the page opens on, and the saved spec
    // all still honour it, so this pins the split rather than the exclusion alone.
    const item = channel({
      metadata: {
        name: 'label-only',
        namespace: 'channels',
        annotations: { 'clerum.io/slack-bot-label': 'Evenfire' },
      },
      spec: { hostRef: 'chatllm', access: { users: [], teams: [] } },
    })
    const draft = createCommunicationChannelDraft(item)

    expect(draft.slackBotHandle).toBe('Evenfire')
    expect(draft.slackBotHandleFromAnnotation).toBe(true)
    expect(hasSlackConfigForRequestUrl(draft)).toBe(false)
    expect(communicationChannelInitialTab(item)).toBe('slack')
    expect(buildCommunicationChannelSpec(draft)).toEqual({
      hostRef: 'chatllm',
      access: { users: [], teams: [] },
      slack: [],
      slackSettings: {
        botHandle: 'Evenfire',
        replyOnlyWhenMentioned: false,
        replyInThreads: false,
      },
    })
  })

  it('counts a Slack bot handle that came from the spec, not the annotation', () => {
    const draft = createCommunicationChannelDraft(
      channel({
        metadata: {
          name: 'slack-channel',
          namespace: 'channels',
          annotations: { 'clerum.io/slack-bot-label': 'Stale Label' },
        },
        spec: { hostRef: 'chatllm', slackSettings: { botHandle: 'Evenfire' } },
      })
    )

    expect(draft.slackBotHandle).toBe('Evenfire')
    expect(draft.slackBotHandleFromAnnotation).toBe(false)
    expect(hasSlackConfigForRequestUrl(draft)).toBe(true)
  })

  it('omits inactive provider settings from the saved spec', () => {
    const spec = buildCommunicationChannelSpec({
      accessTeamIds: [],
      email: [],
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
      email: [],
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

describe('spec fields the edit page does not model', () => {
  // The edit page has no email controls, but the save is a full-spec PUT and
  // control-api preserves only credentialsSecretRef. So anything the draft drops
  // is deleted from the CR. Opening an email-backed channel and saving an
  // unrelated change used to delete spec.email and stop the inbox being polled,
  // with no error and nothing in the diff the operator looked at. See #386.
  const emailGroups = [{ channelId: 'INBOX', emails: ['someone@example.com'] }]

  it('round-trips spec.email through the draft untouched', () => {
    const item: CommunicationChannelItem = channel({
      spec: {
        hostRef: 'agent-a',
        access: { users: [], teams: [] },
        email: emailGroups,
        telegram: [{ channelId: '424242', chatType: 'private' }],
        telegramSettings: { botHandle: '@bot', replyOnlyWhenMentioned: true },
      },
    })

    const spec = buildCommunicationChannelSpec(createCommunicationChannelDraft(item))

    expect(spec.email).toEqual(emailGroups)
  })

  it('does not invent an empty email array on a channel that never had one', () => {
    // An empty array is not the same as absent: channel-reader guards on
    // `spec.email?.length`, and writing `email: []` onto every channel is what
    // put the provider arrays in that state in the first place.
    const item: CommunicationChannelItem = channel({
      spec: {
        hostRef: 'agent-a',
        access: { users: [], teams: [] },
        telegram: [{ channelId: '424242', chatType: 'private' }],
        telegramSettings: { botHandle: '@bot', replyOnlyWhenMentioned: true },
      },
    })

    const spec = buildCommunicationChannelSpec(createCommunicationChannelDraft(item))

    expect('email' in spec).toBe(false)
  })

  it('keeps email when the modelled providers are edited around it', () => {
    const item: CommunicationChannelItem = channel({
      spec: {
        hostRef: 'agent-a',
        access: { users: [], teams: [] },
        email: emailGroups,
        telegram: [{ channelId: '424242', chatType: 'private' }],
        telegramSettings: { botHandle: '@old', replyOnlyWhenMentioned: true },
      },
    })

    const draft = createCommunicationChannelDraft(item)
    const spec = buildCommunicationChannelSpec({ ...draft, telegramBotHandle: '@new' })

    expect(spec.telegramSettings?.botHandle).toBe('@new')
    expect(spec.email).toEqual(emailGroups)
  })
})
