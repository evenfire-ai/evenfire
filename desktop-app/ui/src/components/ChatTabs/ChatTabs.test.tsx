// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
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

  it('keeps long tab labels left-aligned, truncatable, and separate from close controls', () => {
    const longTitle = 'A very long conversation title that must not overlap its close control'
    const { container } = render(
      <ChatTabs
        tabs={[{ id: 'one', agentRef: 'alpha', chatId: 'chat-1', title: longTitle }]}
        activeTabId="one"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    )

    const select = screen.getByRole('button', { name: longTitle })
    const label = container.querySelector('.chat-view-tab__label')
    const close = screen.getByRole('button', { name: `Close ${longTitle}` })
    expect(select.classList.contains('ui-button--align-start')).toBe(true)
    expect(label?.textContent).toBe(longTitle)
    expect(select.nextElementSibling).toBe(close)

    const styles = readFileSync(path.join(process.cwd(), 'ui', 'src', 'styles.css'), 'utf8')
    expect(styles).toMatch(/\.chat-view-tabs\s*\{[^}]*padding:\s*var\(--space-2\) 0 0;/s)
    expect(styles).toMatch(/\.chat-view-tabs__list\s*\{[^}]*width:\s*100%;/s)
    expect(styles).toMatch(/\.chat-view-tab__select\s*\{[^}]*flex:\s*1 1 auto;/s)
    expect(styles).toMatch(/\.chat-view-tab__label\s*\{[^}]*text-overflow:\s*ellipsis;/s)
  })
})
