// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { ChatDrawer } from '@components/ChatDrawer'
import { TitlebarActionsPortal, WindowTitleBar } from '@components/WindowTitleBar'

// The titlebar actions are rendered through a React portal. Exercise that DOM
// topology instead of recreating the pre-portal content-panel header.

const tokensCss = readFileSync(
  path.join(process.cwd(), 'ui', 'src', 'styles', 'tokens.css'),
  'utf8'
)
const stylesCss = readFileSync(path.join(process.cwd(), 'ui', 'src', 'styles.css'), 'utf8')

function layer(name: string): number {
  const match = new RegExp(`--${name}:\\s*(\\d+)`).exec(tokensCss)
  if (!match) throw new Error(`token --${name} not found`)
  return Number(match[1])
}

// The `.toast-stack` sits on a raw z-index literal (not a token) in styles.css.
// Read it from the real rule so a change there is reflected here instead of the
// assertion passing against a phantom constant (T4).
function toastStackZIndex(): number {
  const match = /\.toast-stack\s*\{[^}]*z-index:\s*(\d+)/.exec(stylesCss)
  if (!match) throw new Error('.toast-stack z-index not found')
  return Number(match[1])
}

function toastStackTop(): string {
  const match = /\.toast-stack\s*\{[^}]*top:\s*([^;]+);/.exec(stylesCss)
  if (!match) throw new Error('.toast-stack top offset not found')
  return match[1].trim()
}

beforeEach(() => {
  const style = document.createElement('style')
  style.dataset.testStyles = 'header-stacking'
  style.textContent = `${tokensCss}\n${stylesCss}`
  document.head.append(style)
})

afterEach(() => {
  cleanup()
  document.querySelector('[data-test-styles="header-stacking"]')?.remove()
  document.body.innerHTML = ''
})

function PortalStackingHarness({ chatDrawerOpen }: { chatDrawerOpen: boolean }) {
  const [actionsRoot, setActionsRoot] = React.useState<HTMLDivElement | null>(null)
  const drawerRef = React.useRef<HTMLDivElement>(null)

  return (
    <div className="app-frame">
      <WindowTitleBar actionsRef={setActionsRoot} />
      <div className="app-root">
        <section
          className={
            chatDrawerOpen ? 'content-panel content-panel--chat-drawer-open' : 'content-panel'
          }
        >
          {chatDrawerOpen ? (
            <ChatDrawer
              containerRef={drawerRef}
              header={<span>Chat</span>}
              onClose={() => undefined}
              onNewChat={() => undefined}
              onResizeHandleKeyDown={() => undefined}
              onResizeHandleMouseDown={() => undefined}
              ready
              resizing={false}
              width={340}
            >
              <span>Chat content</span>
            </ChatDrawer>
          ) : null}
        </section>
      </div>
      <TitlebarActionsPortal container={actionsRoot}>
        <header className="top-bar">
          <div className="global-search-results" data-testid="titlebar-search-results" />
        </header>
      </TitlebarActionsPortal>
    </div>
  )
}

describe('chat drawer header stacking', () => {
  it('lifts the real titlebar portal above the chat drawer while it is open', async () => {
    render(<PortalStackingHarness chatDrawerOpen />)

    const searchResults = await screen.findByTestId('titlebar-search-results')
    const titlebar = searchResults.closest('.window-titlebar') as HTMLElement
    const drawer = screen.getByRole('complementary', { name: 'Chat' })

    expect(titlebar).toBeTruthy()
    expect(searchResults.closest('.content-panel')).toBeNull()
    expect(getComputedStyle(titlebar).zIndex).toBe('var(--layer-dropdown)')
    expect(getComputedStyle(drawer).zIndex).toBe('var(--layer-chat-overlay)')
    expect(layer('layer-dropdown')).toBeGreaterThan(layer('layer-chat-overlay'))
    expect(toastStackZIndex()).toBeGreaterThan(layer('layer-dropdown'))
  })

  it('keeps the titlebar at its normal layer when no chat drawer exists', async () => {
    render(<PortalStackingHarness chatDrawerOpen={false} />)

    const searchResults = await screen.findByTestId('titlebar-search-results')
    const titlebar = searchResults.closest('.window-titlebar') as HTMLElement

    expect(getComputedStyle(titlebar).zIndex).toBe('var(--layer-header)')
  })

  it('anchors alerts below the custom titlebar with the shared spacing token', () => {
    expect(toastStackTop()).toBe('calc(var(--window-titlebar-height) + var(--space-2))')
  })

  it('shares the titlebar divider border with its interactive controls', () => {
    expect(stylesCss).toMatch(
      /\.window-titlebar\s*\{[^}]*border-bottom:\s*1px solid var\(--titlebar-divider-border\)/
    )
    expect(tokensCss).toMatch(/--titlebar-control-border:\s*var\(--titlebar-divider-border\)/)
  })

  it('reserves exactly the notification drawer rail for a mounted app', () => {
    expect(stylesCss).toMatch(
      /--app-header-utilities-width:\s*calc\(var\(--app-notification-drawer-width\) \+ var\(--space-4\)\)/
    )
    expect(stylesCss).toMatch(/\.notification-menu--app-drawer\s*\{[^}]*right:\s*var\(--space-4\)/)
  })
})
