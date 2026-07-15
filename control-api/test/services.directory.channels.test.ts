import { describe, expect, it } from 'vitest'
import { normalizeChannels } from '../src/services/directory/types.js'

describe('directory channel mappings', () => {
  it('normalizes all supported profile social channels', () => {
    expect(
      normalizeChannels({
        emails: [' user@example.com ', ''],
        telegramHandles: [' @testuser '],
        telegramIds: [' 123456789 '],
        slackUserNames: [' U123 '],
        discordUserNames: [' testuser '],
        whatsappNumbers: [' +15551234567 '],
      })
    ).toEqual({
      emails: ['user@example.com'],
      telegramHandles: ['@testuser'],
      telegramIds: ['123456789'],
      slackUserNames: ['U123'],
      discordUserNames: ['testuser'],
      whatsappNumbers: ['+15551234567'],
    })
  })

  it('fills missing new keys for existing profile records', () => {
    expect(normalizeChannels({ emails: ['user@example.com'], telegramIds: ['123'] })).toEqual({
      emails: ['user@example.com'],
      telegramHandles: [],
      telegramIds: ['123'],
      slackUserNames: [],
      discordUserNames: [],
      whatsappNumbers: [],
    })
  })
})
