// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { SessionStateLite } from '../../../hooks/domain/useAgentChatController'
import { ChatStateBadge } from '../ChatStateBadge'

afterEach(cleanup)

function renderBadge(sessionState: SessionStateLite | undefined, unreadTerminal = false) {
  return render(<ChatStateBadge sessionState={sessionState} unreadTerminal={unreadTerminal} />)
}

describe('ChatStateBadge (D.5)', () => {
  it('renders a running badge when the session is processing', () => {
    renderBadge({ state: 'processing', syncing: false })
    expect(screen.getByLabelText('Running')).toBeTruthy()
  })

  it('renders an awaiting_approval badge', () => {
    renderBadge({ state: 'awaiting_approval', syncing: false })
    expect(screen.getByLabelText('Awaiting approval')).toBeTruthy()
  })

  it('renders completed_unread when idle but the chat has an unread terminal', () => {
    renderBadge({ state: 'idle', syncing: false }, true)
    expect(screen.getByLabelText('Completed, unread')).toBeTruthy()
  })

  it('renders completed_unread when there is no session state but the chat is unread', () => {
    renderBadge(undefined, true)
    expect(screen.getByLabelText('Completed, unread')).toBeTruthy()
  })

  it('renders no badge when idle and read', () => {
    const { container } = renderBadge({ state: 'idle', syncing: false }, false)
    expect(container.firstChild).toBeNull()
  })

  it('processing takes precedence over an unread flag (single badge)', () => {
    renderBadge({ state: 'processing', syncing: false }, true)
    expect(screen.getByLabelText('Running')).toBeTruthy()
    expect(screen.queryByLabelText('Completed, unread')).toBeNull()
  })
})
