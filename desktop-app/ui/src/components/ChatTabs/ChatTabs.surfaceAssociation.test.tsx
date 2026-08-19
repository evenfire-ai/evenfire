// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ChatTabs } from '.'

afterEach(cleanup)

describe('ChatTabs selected surface association', () => {
  it('associates the active tab control with its owned chat surface', () => {
    render(
      <ChatTabs
        activeTabId="one"
        onClose={vi.fn()}
        onSelect={vi.fn()}
        {...({ panelId: 'current-chat-surface' } as Record<string, string>)}
        tabs={[
          { id: 'one', agentRef: 'alpha', chatId: 'chat-1', title: 'First chat' },
          {
            id: 'two',
            agentRef: 'alpha',
            chatId: 'chat-2',
            title: 'A second conversation with a long title that must remain usable',
          },
        ]}
      />
    )

    expect(screen.getByRole('button', { name: 'First chat' }).getAttribute('aria-controls')).toBe(
      'current-chat-surface'
    )
    expect(
      screen
        .getByRole('button', {
          name: 'A second conversation with a long title that must remain usable',
        })
        .getAttribute('aria-controls')
    ).toBeNull()
  })
})
