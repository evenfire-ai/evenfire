import { describe, expect, it, vi } from 'vitest'
import type { PluginWorkloadSdkControlApiClient } from '../promptBridge/controlApiClient'
import { ClientNotificationsHandler } from './handler'

const validBody = {
  eventType: 'lead.followup.due',
  target: { targetRef: 'team.sales' },
  idempotencyKey: 'key-1',
  notification: { title: 'Follow up', body: 'Lead is due' },
}

function makeHandler(submit = vi.fn()) {
  submit.mockResolvedValue({
    notificationId: 'not-1',
    replay: false,
    status: 'accepted',
    eventType: 'lead.followup.due',
    target: { targetRef: 'team.sales' },
  })
  const handler = new ClientNotificationsHandler({
    controlApiClient: {
      submitClientNotification: submit,
    } as unknown as PluginWorkloadSdkControlApiClient,
    recipeNamespace: 'sandbox-recipes',
    recipeName: 'r1',
  })
  return { handler, submit }
}

describe('ClientNotificationsHandler', () => {
  it('rejects when both target and userRef are present', async () => {
    const { handler, submit } = makeHandler()
    await expect(handler.handle({ ...validBody, userRef: 'user-1' }, 'api')).rejects.toMatchObject({
      code: 'invalid_request',
    })
    expect(submit).not.toHaveBeenCalled()
  })

  it('rejects when neither target nor userRef is present', async () => {
    const { handler } = makeHandler()
    await expect(handler.handle({ ...validBody, target: undefined }, 'api')).rejects.toMatchObject({
      code: 'invalid_request',
    })
  })

  it('rejects an email-like targetRef (raw channel address)', async () => {
    const { handler } = makeHandler()
    await expect(
      handler.handle({ ...validBody, target: { targetRef: 'a@b.com' } }, 'api')
    ).rejects.toMatchObject({ code: 'invalid_request' })
  })

  it('rejects a phone-like userRef (raw channel address)', async () => {
    const { handler } = makeHandler()
    await expect(
      handler.handle({ ...validBody, target: undefined, userRef: '+1 555 123 4567' }, 'api')
    ).rejects.toMatchObject({ code: 'invalid_request' })
  })

  it('rejects an oversized title with payload_too_large', async () => {
    const { handler } = makeHandler()
    await expect(
      handler.handle({ ...validBody, notification: { title: 'x'.repeat(257), body: 'b' } }, 'api')
    ).rejects.toMatchObject({ code: 'payload_too_large' })
  })

  it('rejects an oversized body with payload_too_large', async () => {
    const { handler } = makeHandler()
    await expect(
      handler.handle({ ...validBody, notification: { title: 't', body: 'x'.repeat(4097) } }, 'api')
    ).rejects.toMatchObject({ code: 'payload_too_large' })
  })

  it('submits a valid intent and returns the spec §14 result shape', async () => {
    const { handler, submit } = makeHandler()
    const result = await handler.handle(validBody, 'api')
    expect(result).toMatchObject({
      notificationId: 'not-1',
      status: 'accepted',
      eventType: 'lead.followup.due',
      title: 'Follow up',
      body: 'Lead is due',
      target: { targetRef: 'team.sales' },
    })
    expect(result.createdAt).toBeTruthy()
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'r1',
        callerRef: 'api',
        eventType: 'lead.followup.due',
      })
    )
  })

  it('listRecipients delegates to control-api with the recipe binding and returns recipients', async () => {
    const list = vi
      .fn()
      .mockResolvedValue({ recipients: [{ userRef: 'u-1', displayName: 'Ada Lovelace' }] })
    const handler = new ClientNotificationsHandler({
      controlApiClient: {
        listClientNotificationRecipients: list,
      } as unknown as PluginWorkloadSdkControlApiClient,
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'r1',
    })
    const recipients = await handler.listRecipients('api')
    expect(recipients).toEqual([{ userRef: 'u-1', displayName: 'Ada Lovelace' }])
    expect(list).toHaveBeenCalledWith({
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'r1',
      callerRef: 'api',
    })
  })
})
