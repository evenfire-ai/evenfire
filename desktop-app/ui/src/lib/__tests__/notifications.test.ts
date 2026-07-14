import { describe, expect, it } from 'vitest'
import {
  notificationInboxDescription,
  notificationKindLabel,
  notificationPreviewText,
  sanitizeNotificationSettings,
  sanitizeNotificationVolume,
  shouldDeliverChatResponseNotification,
} from '../notifications'

describe('notification settings helpers', () => {
  it('sanitizes invalid persisted settings to defaults', () => {
    expect(sanitizeNotificationSettings({ inApp: 'bad', desktop: 'always' })).toEqual({
      inApp: 'when_app_focused_away_from_chat',
      desktop: 'always',
      soundVolume: 50,
    })
  })

  it('sanitizes notification sound volume to a 0-100 integer', () => {
    expect(sanitizeNotificationVolume(-10)).toBe(0)
    expect(sanitizeNotificationVolume('42.8')).toBe(43)
    expect(sanitizeNotificationVolume(200)).toBe(100)
    expect(sanitizeNotificationVolume('bad', 72)).toBe(72)
  })

  it('delivers focused-away notifications only when the app is focused and chat is hidden', () => {
    expect(
      shouldDeliverChatResponseNotification('when_app_focused_away_from_chat', {
        appFocused: true,
        activeChatVisible: false,
      })
    ).toBe(true)
    expect(
      shouldDeliverChatResponseNotification('when_app_focused_away_from_chat', {
        appFocused: true,
        activeChatVisible: true,
      })
    ).toBe(false)
    expect(
      shouldDeliverChatResponseNotification('when_app_focused_away_from_chat', {
        appFocused: false,
        activeChatVisible: false,
      })
    ).toBe(false)
  })

  it('delivers away-from-app notifications only when the app is not focused', () => {
    expect(
      shouldDeliverChatResponseNotification('when_app_unfocused', {
        appFocused: false,
        activeChatVisible: true,
      })
    ).toBe(true)
    expect(
      shouldDeliverChatResponseNotification('when_app_unfocused', {
        appFocused: true,
        activeChatVisible: false,
      })
    ).toBe(false)
  })

  it('keeps complete SDK notification bodies while truncating other previews', () => {
    const longBody = `Complete result: ${'x'.repeat(300)}`

    expect(notificationPreviewText('sdk_notification', longBody)).toBe(longBody)
    expect(notificationPreviewText('assistant_reply', longBody)).toHaveLength(250)
    expect(notificationPreviewText('assistant_reply', longBody)).toMatch(/\.\.\.$/)
  })

  it('uses reader-facing labels for every notification kind', () => {
    expect(notificationKindLabel('approval_required')).toBe('Approval needed')
    expect(notificationKindLabel('workflow_completed')).toBe('Workflow completed')
    expect(notificationKindLabel('sdk_notification')).toBe('Plugin notification')
    expect(notificationKindLabel('assistant_reply')).toBe('Agent reply')
  })

  it('describes the inbox content without exposing runtime jargon', () => {
    expect(notificationInboxDescription(true, true)).toBe(
      'Pending approvals and updates from agents, workflows, and plugins.'
    )
    expect(notificationInboxDescription(true, false)).toBe(
      'Workflow requests that are waiting on you.'
    )
    expect(notificationInboxDescription(false, true)).toBe(
      'Updates from agents, workflows, and plugins.'
    )
    expect(notificationInboxDescription(false, false)).toBe(
      'No notifications or pending approvals right now.'
    )
  })
})
