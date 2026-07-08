import { describe, expect, it } from 'vitest'
import { parseSlackDecision } from '../src/channels/slack.js'

describe('slack channel parser', () => {
  it('keeps workspace identity separate from user identity', () => {
    const parsed = parseSlackDecision({
      actions: [{ value: 'approve:99999999-8888-7777-6666-555555555555' }],
      user: { id: 'U1' },
      team: { id: 'T1' },
      channel: { id: 'D1' },
      trigger_id: 'event',
    })
    expect(parsed).toMatchObject({
      providerUserId: 'U1',
      providerWorkspaceId: 'T1',
      providerChannelId: 'D1',
      providerEventId: 'slack:T1:D1:event',
    })
  })
})
