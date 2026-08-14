// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { ChatViewWorkspace } from '.'

const tabs = [
  { id: 'one', agentRef: 'alpha', chatId: 'chat-1', title: 'First chat' },
  {
    id: 'two',
    agentRef: 'alpha',
    chatId: 'chat-2',
    title: 'A second conversation with a long title that must remain usable in narrow windows',
  },
]

beforeEach(() => {
  const style = document.createElement('style')
  style.dataset.testStyles = 'chat-workspace'
  style.textContent = `:root { --accent: #3b82f6; --surface-strong: #111827; }
${readFileSync(path.join(process.cwd(), 'ui', 'src', 'styles.css'), 'utf8')}`
  document.head.append(style)
})

afterEach(() => {
  cleanup()
  document.querySelector('[data-test-styles="chat-workspace"]')?.remove()
})

function renderWorkspace(contentLabel: string, localSearch: ReactNode = null) {
  return render(
    <ChatViewWorkspace
      activeTabId="one"
      localSearch={localSearch}
      onClose={vi.fn()}
      onSelect={vi.fn()}
      tabs={tabs}
    >
      <div data-testid="chat-state">{contentLabel}</div>
    </ChatViewWorkspace>
  )
}

describe('ChatViewWorkspace', () => {
  it('owns the active tab, local search, and current chat as one selected surface', () => {
    const { container } = renderWorkspace('active chat', <div role="search">Current chat find</div>)
    const surface = screen.getByRole('region', { name: 'Current chat' })
    const active = screen.getByRole('button', { name: 'First chat' })
    const list = container.querySelector('.chat-view-tabs__list') as HTMLElement

    expect(active.getAttribute('aria-controls')).toBe(surface.id)
    expect(surface.getAttribute('data-selected-surface')).toBe('chat')
    expect(surface.contains(screen.getByRole('search'))).toBe(true)
    expect(surface.contains(screen.getByTestId('chat-state'))).toBe(true)
    expect(getComputedStyle(list).overflowX).toBe('auto')
    expect(getComputedStyle(surface).borderTopStyle).toBe('solid')
    expect(container.querySelector('.chat-view-tab.is-active')).toBeTruthy()
  })

  it.each(['loading chat', 'blank chat', 'active chat'])(
    'keeps the %s state inside the selected surface',
    state => {
      renderWorkspace(state)
      const surface = screen.getByRole('region', { name: 'Current chat' })
      expect(surface.contains(screen.getByText(state))).toBe(true)
    }
  )

  it('keeps tab overflow separate from a full-width surface at narrow widths', () => {
    const { container } = renderWorkspace('narrow chat')
    const workspace = container.querySelector('.chat-view-workspace') as HTMLElement
    const list = container.querySelector('.chat-view-tabs__list') as HTMLElement
    const surface = screen.getByRole('region', { name: 'Current chat' })
    workspace.style.width = '320px'

    expect(getComputedStyle(workspace).display).toBe('flex')
    expect(getComputedStyle(list).overflowX).toBe('auto')
    expect(getComputedStyle(surface).width).toBe('100%')
    expect(screen.getByText(/A second conversation/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Close A second conversation/ })).toBeTruthy()
  })
})
