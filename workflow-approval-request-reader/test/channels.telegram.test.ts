import { describe, expect, it } from 'vitest'
import { parseTelegramDecision } from '../src/channels/telegram.js'

describe('telegram channel parser', () => {
  it('preserves provider event id for dedupe', () => {
    const parsed = parseTelegramDecision({
      callback_query: {
        id: 'dedupe-id',
        data: 'approve:99999999-8888-7777-6666-555555555555',
        from: { id: 1 },
        message: { chat: { id: 2 } },
      },
    })
    expect(parsed?.providerEventId).toBe('telegram:2:dedupe-id')
  })
})
