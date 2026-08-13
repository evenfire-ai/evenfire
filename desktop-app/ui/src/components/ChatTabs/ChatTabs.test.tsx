// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatTabs } from '.'

afterEach(cleanup)

describe('ChatTabs', () => {
  it('renders the in-memory tab order and exposes non-destructive view actions', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(
      <ChatTabs
        tabs={[
          { id: 'one', agentRef: 'alpha', chatId: 'chat-1', title: 'First chat' },
          { id: 'two', agentRef: 'alpha', chatId: null, title: 'New chat' },
        ]}
        activeTabId="one"
        onSelect={onSelect}
        onClose={onClose}
      />
    )

    expect(screen.getByRole('toolbar', { name: 'Chat tabs' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'First chat' }).getAttribute('aria-pressed')).toBe(
      'true'
    )
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close First chat' }))
    expect(onSelect).toHaveBeenCalledWith('two')
    expect(onClose).toHaveBeenCalledWith('one')
  })
})
