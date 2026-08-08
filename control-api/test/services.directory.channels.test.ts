import { beforeEach, describe, expect, it, vi } from 'vitest'
import { searchDirectory } from '../src/services/directory/index.js'
import { normalizeChannels } from '../src/services/directory/types.js'

const dbMocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  txQuery: vi.fn(),
}))

vi.mock('../src/db.js', () => ({
  pool: { query: dbMocks.poolQuery },
  withTransaction: async (work: (db: { query: typeof dbMocks.txQuery }) => Promise<unknown>) =>
    work({ query: dbMocks.txQuery }),
}))

describe('directory channel mappings', () => {
  beforeEach(() => {
    dbMocks.poolQuery.mockReset()
    dbMocks.txQuery.mockReset()
  })

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

  it('searches literal text and returns only supported directory fields', async () => {
    dbMocks.poolQuery.mockResolvedValue({
      rows: [
        {
          id: 'user-1',
          email: 'user@example.com',
          name: 'User',
          display_name: 'Display',
        },
      ],
      rowCount: 1,
    })

    await expect(searchDirectory('team-1', String.raw`100%_name\value`)).resolves.toEqual([
      {
        id: 'user-1',
        email: 'user@example.com',
        name: 'User',
        display_name: 'Display',
      },
    ])

    expect(dbMocks.poolQuery).toHaveBeenCalledWith(
      expect.stringMatching(/SELECT u\.id, u\.email, u\.name, p\.display_name\s+FROM/),
      ['team-1', String.raw`%100\%\_name\\value%`]
    )
    expect(dbMocks.poolQuery.mock.calls[0]?.[0]).toContain("ESCAPE '\\'")
    expect(dbMocks.poolQuery.mock.calls[0]?.[0]).not.toContain('p.channels')
  })
})
