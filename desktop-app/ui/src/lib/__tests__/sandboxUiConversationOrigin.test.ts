import { describe, expect, it } from 'vitest'
import { DESKTOP_ROUTES } from '@constants/navigation'
import {
  getConversationOriginForAppLaunch,
  getConversationOriginForNavigation,
} from '@lib/sandboxUiConversationOrigin'

const conversationOrigin = {
  agentName: 'task-board-agent',
  chatId: 'chat-123',
  title: 'Plan the launch',
}

describe('sandbox UI conversation origin', () => {
  it('preserves an active conversation while navigating to the Apps picker', () => {
    expect(getConversationOriginForNavigation(DESKTOP_ROUTES.apps, conversationOrigin)).toEqual(
      conversationOrigin
    )
  })

  it('clears the preserved conversation when navigating elsewhere', () => {
    expect(getConversationOriginForNavigation(DESKTOP_ROUTES.settings, conversationOrigin)).toBe(
      null
    )
  })

  it('uses the preserved conversation when launching from the Apps picker', () => {
    expect(
      getConversationOriginForAppLaunch(DESKTOP_ROUTES.apps, null, conversationOrigin)
    ).toEqual(conversationOrigin)
  })

  it('does not reuse a preserved conversation when launching from another route', () => {
    expect(
      getConversationOriginForAppLaunch(DESKTOP_ROUTES.settings, null, conversationOrigin)
    ).toBe(null)
  })
})
