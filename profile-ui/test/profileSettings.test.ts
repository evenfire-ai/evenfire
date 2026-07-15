import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appendDraftValue,
  channelsToDraft,
  draftToChannels,
  normalizeProfileChannels,
  uniqueTrimmed,
  verifiedTelegramProfileValues,
} from '../lib/profileSettings'

test('normalizeProfileChannels fills missing social network keys', () => {
  assert.deepEqual(
    normalizeProfileChannels({
      emails: [' user@example.com '],
      telegramIds: [' 123456789 '],
    }),
    {
      emails: ['user@example.com'],
      telegramHandles: [],
      slackUserNames: [],
      telegramIds: ['123456789'],
      discordUserNames: [],
      whatsappNumbers: [],
    }
  )
})

test('uniqueTrimmed removes blanks and exact duplicates while preserving order', () => {
  assert.deepEqual(uniqueTrimmed([' @testuser ', '', '@testuser', '@other']), ['@testuser', '@other'])
})

test('normalizeProfileChannels stores Telegram handles with @ prefix', () => {
  assert.deepEqual(
    normalizeProfileChannels({
      telegramHandles: [' testuser ', '@other'],
    }).telegramHandles,
    ['@testuser', '@other']
  )
})

test('profile channel draft serializes only non-empty values', () => {
  let nextId = 0
  const draft = channelsToDraft(
    {
      emails: ['a@example.com'],
      telegramHandles: ['@testuser'],
      slackUserNames: [],
      telegramIds: [],
      discordUserNames: [],
      whatsappNumbers: [],
    },
    () => `row-${++nextId}`
  )

  draft.telegramIds.push({ id: 'telegram-empty', value: ' ' })
  draft.telegramIds.push({ id: 'telegram-chat-id', value: ' 123456789 ' })

  assert.deepEqual(draftToChannels(draft), {
    emails: ['a@example.com'],
    telegramHandles: ['@testuser'],
    slackUserNames: [],
    telegramIds: ['123456789'],
    discordUserNames: [],
    whatsappNumbers: [],
  })
})

test('appendDraftValue normalizes Telegram handles and adds verified chat IDs without duplicates', () => {
  let nextId = 0
  const draft = channelsToDraft(
    {
      emails: [],
      telegramHandles: ['@testuser'],
      slackUserNames: [],
      telegramIds: [],
      discordUserNames: [],
      whatsappNumbers: [],
    },
    () => `row-${++nextId}`
  )

  const duplicate = appendDraftValue(draft, 'telegramHandles', ' testuser ', () => 'duplicate')
  assert.equal(duplicate, draft)

  const appended = appendDraftValue(draft, 'telegramIds', ' 721954225 ', () => 'verified-chat')
  assert.deepEqual(appended.telegramIds, [{ id: 'verified-chat', value: '721954225' }])
})

test('verifiedTelegramProfileValues exposes verified user and private chat ids', () => {
  assert.deepEqual(
    verifiedTelegramProfileValues([
      {
        medium: 'telegram',
        providerUserId: ' 721954225 ',
        providerChannelId: '721954225',
      },
      {
        medium: 'telegram',
        providerUserId: '721954225',
        providerChannelId: ' ',
      },
      {
        medium: 'telegram',
        providerUserId: 'disabled-user',
        providerChannelId: 'disabled-chat',
        disabledAt: '2026-06-05T18:00:00.000Z',
      },
      {
        medium: 'slack',
        providerUserId: 'U123',
        providerChannelId: 'C123',
      },
    ]),
    {
      userIds: ['721954225'],
      chatIds: ['721954225'],
    }
  )
})
