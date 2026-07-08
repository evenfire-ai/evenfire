import { describe, expect, it } from 'vitest'
import type { PluginWorkloadSdkNotificationDelivery } from '../notificationDeliveryClient'
import { formatNotificationDelivery } from '../workflowApprovalNotificationFormatter'

const delivery = (
  payload: Partial<PluginWorkloadSdkNotificationDelivery['payload']> = {}
): PluginWorkloadSdkNotificationDelivery => ({
  id: 'nd-1',
  eventType: 'plugin_workload_sdk.notification',
  attempts: 1,
  medium: 'telegram',
  providerUserId: '12345',
  providerWorkspaceId: null,
  providerChannelId: '67890',
  payload: {
    notificationId: 'not-1',
    origin: 'plugin_workload_sdk',
    recipeNamespace: 'sandbox-recipes',
    recipeName: 'sdk-recipe',
    callerRef: 'api',
    eventType: 'lead.followup.due',
    title: 'Follow up',
    body: 'Lead is due today',
    ...payload,
  },
})

describe('formatNotificationDelivery — plugin_workload_sdk.notification (plan §4.3)', () => {
  it('renders the authorized title and body verbatim', () => {
    const formatted = formatNotificationDelivery(delivery())
    expect(formatted.content).toBe('Follow up\nLead is due today')
  })

  it('renders title-only notifications without a trailing newline', () => {
    const formatted = formatNotificationDelivery(delivery({ body: '' }))
    expect(formatted.content).toBe('Follow up')
  })

  it('falls back to a generic title when empty', () => {
    const formatted = formatNotificationDelivery(delivery({ title: '  ', body: 'b' }))
    expect(formatted.content).toBe('Workflow notification\nb')
  })

  it('still rejects unknown event types', () => {
    const unknown = { ...delivery(), eventType: 'mystery.event' } as never
    expect(() => formatNotificationDelivery(unknown)).toThrow(
      'unsupported_notification_delivery_event'
    )
  })
})
