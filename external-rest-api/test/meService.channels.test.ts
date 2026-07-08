import { describe, expect, it } from 'vitest'
import { normalizeChannels } from '../src/services/meService.js'

describe('meService channel mappings', () => {
  it('normalizes all supported profile social channels', () => {
    expect(
      normalizeChannels({
        emails: [' user@example.com '],
        telegramHandles: [' @alfredo '],
        telegramIds: [' 123456789 '],
        slackUserNames: [' U123 '],
        discordUserNames: [' alfredo '],
        whatsappNumbers: [' +15551234567 '],
      })
    ).toEqual({
      emails: ['user@example.com'],
      telegramHandles: ['@alfredo'],
      telegramIds: ['123456789'],
      slackUserNames: ['U123'],
      discordUserNames: ['alfredo'],
      whatsappNumbers: ['+15551234567'],
    })
  })

  it('keeps existing records compatible when new keys are absent', () => {
    expect(normalizeChannels({ emails: ['user@example.com'], slackUserNames: ['slack'] })).toEqual({
      emails: ['user@example.com'],
      telegramHandles: [],
      telegramIds: [],
      slackUserNames: ['slack'],
      discordUserNames: [],
      whatsappNumbers: [],
    })
  })
})
