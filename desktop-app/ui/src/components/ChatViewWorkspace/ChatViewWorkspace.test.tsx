// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { ChatViewWorkspace } from '.'

// The workspace tab strip is now global (`WorkspaceTabStrip`, tested in its own
// suite); `ChatViewWorkspace` owns only the selected chat surface — the
// local-search slot and the active conversation.

beforeEach(() => {
  const style = document.createElement('style')
  style.dataset.testStyles = 'chat-workspace'
  style.textContent = `${readFileSync(
    path.join(process.cwd(), 'ui', 'src', 'styles', 'tokens.css'),
    'utf8'
  )}
${readFileSync(path.join(process.cwd(), 'ui', 'src', 'styles.css'), 'utf8')}`
  document.head.append(style)
})

afterEach(() => {
  cleanup()
  document.querySelector('[data-test-styles="chat-workspace"]')?.remove()
})

function renderWorkspace(contentLabel: string, localSearch: ReactNode = null) {
  return render(
    <ChatViewWorkspace localSearch={localSearch} surfaceId="chat-view-panel">
      <div data-testid="chat-state">{contentLabel}</div>
    </ChatViewWorkspace>
  )
}

describe('ChatViewWorkspace', () => {
  it('owns local search and the current chat as one selected surface', () => {
    renderWorkspace('active chat', <div role="search">Current chat find</div>)
    const surface = screen.getByRole('region', { name: 'Current chat' })

    expect(surface.id).toBe('chat-view-panel')
    expect(surface.getAttribute('data-selected-surface')).toBe('chat')
    expect(surface.contains(screen.getByRole('search'))).toBe(true)
    expect(surface.contains(screen.getByTestId('chat-state'))).toBe(true)
    expect(getComputedStyle(surface).borderTopStyle).toBe('solid')
    expect(getComputedStyle(surface).borderTopWidth).toBe('0px')
    expect(getComputedStyle(surface).borderLeftStyle).toBe('solid')
    expect(getComputedStyle(surface).borderRightStyle).toBe('solid')
    expect(getComputedStyle(surface).borderBottomStyle).toBe('solid')
    expect(getComputedStyle(surface).paddingLeft).toBe('var(--space-3)')
  })

  it.each(['loading chat', 'blank chat', 'active chat'])(
    'keeps the %s state inside the selected surface',
    state => {
      renderWorkspace(state)
      const surface = screen.getByRole('region', { name: 'Current chat' })
      expect(surface.contains(screen.getByText(state))).toBe(true)
    }
  )

  it('keeps a full-width surface at narrow widths', () => {
    const { container } = renderWorkspace('narrow chat')
    const workspace = container.querySelector('.chat-view-workspace') as HTMLElement
    const surface = screen.getByRole('region', { name: 'Current chat' })
    workspace.style.width = '320px'

    expect(getComputedStyle(workspace).display).toBe('flex')
    expect(getComputedStyle(surface).width).toBe('100%')
    expect(screen.getByText('narrow chat')).toBeTruthy()
  })
})
