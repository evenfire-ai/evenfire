import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAdminResourcesRouter } from '../src/routes/admin/resources.js'
import { MockGateway } from './mockGateway.js'

function makeApp(gateway: MockGateway) {
  const app = express()
  app.use(express.json())
  app.use(createAdminResourcesRouter(gateway as never))
  return app
}

const channelBody = {
  metadata: { name: 'agent-a-telegram' },
  spec: {
    hostRef: 'agent-a',
    telegram: [{ channelId: '-1001', chatType: 'group', userIds: ['123', '456'] }],
  },
}

// POST body with credentials envelope (required since B4 for provider CCs)
const channelBodyWithCredentials = {
  ...channelBody,
  credentials: { 'telegram-bot-token': 'test-token' },
}

describe('routes/resources CommunicationChannel Telegram transport userIds', () => {
  it('allows create with Telegram userIds without requiring Profile UI verification first', async () => {
    const gateway = new MockGateway('channels')
    const createSpy = vi.spyOn(gateway, 'createResource')

    // B4: provider CCs now require a credentials envelope (or credentialsSecretRef in spec).
    // userIds still need no profile-UI verification — that constraint is unchanged.
    const res = await request(makeApp(gateway))
      .post('/admin/communication-channels')
      .send(channelBodyWithCredentials)
      .expect(201)

    expect(res.body.spec.telegram).toEqual([
      { channelId: '-1001', chatType: 'group', userIds: ['123', '456'] },
    ])
    expect(createSpy).toHaveBeenCalledWith(
      'communicationchannels',
      expect.objectContaining({
        spec: expect.objectContaining({
          telegram: [{ channelId: '-1001', chatType: 'group', userIds: ['123', '456'] }],
        }),
      }),
      'channels'
    )
  })

  it('allows update with Telegram userIds as a transport pre-filter only', async () => {
    const gateway = new MockGateway('channels')
    await gateway.createResource(
      'communicationchannels',
      { metadata: { name: 'agent-a-telegram' }, spec: { hostRef: 'agent-a' } },
      'channels'
    )
    const updateSpy = vi.spyOn(gateway, 'updateResource')

    const res = await request(makeApp(gateway))
      .put('/admin/communication-channels/agent-a-telegram')
      .send({ spec: channelBody.spec })
      .expect(200)

    expect(res.body.spec.telegram).toEqual([
      { channelId: '-1001', chatType: 'group', userIds: ['123', '456'] },
    ])
    expect(updateSpy).toHaveBeenCalledWith(
      'communicationchannels',
      'agent-a-telegram',
      expect.objectContaining({
        spec: expect.objectContaining({
          telegram: [{ channelId: '-1001', chatType: 'group', userIds: ['123', '456'] }],
        }),
      }),
      'channels'
    )
  })
})
