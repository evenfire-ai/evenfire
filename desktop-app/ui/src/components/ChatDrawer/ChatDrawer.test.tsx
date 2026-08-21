// @vitest-environment jsdom
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { ChatDrawer } from '.'

const stylesheet = readFileSync(path.join(process.cwd(), 'ui', 'src', 'styles.css'), 'utf8')

beforeEach(() => {
  const style = document.createElement('style')
  style.dataset.testStyles = 'chat-drawer'
  style.textContent = `${readFileSync(
    path.join(process.cwd(), 'ui', 'src', 'styles', 'tokens.css'),
    'utf8'
  )}
${readFileSync(path.join(process.cwd(), 'ui', 'src', 'styles.css'), 'utf8')}`
  document.head.append(style)
})

afterEach(() => {
  cleanup()
  document.querySelector('[data-test-styles="chat-drawer"]')?.remove()
})

function renderDrawer(props: Partial<React.ComponentProps<typeof ChatDrawer>> = {}) {
  const onNewChat = props.onNewChat ?? vi.fn()
  const onClose = props.onClose ?? vi.fn()
  const onResizeHandleMouseDown = props.onResizeHandleMouseDown ?? vi.fn()
  const onResizeHandleKeyDown = props.onResizeHandleKeyDown ?? vi.fn()
  const containerRef = props.containerRef ?? createRef<HTMLElement>()
  const utils = render(
    <ChatDrawer
      header={props.header ?? <span className="chat-drawer__title">Drawer chat</span>}
      onNewChat={onNewChat}
      onClose={onClose}
      containerRef={containerRef}
      ready={props.ready ?? true}
      onResizeHandleMouseDown={onResizeHandleMouseDown}
      onResizeHandleKeyDown={onResizeHandleKeyDown}
      width={props.width ?? 420}
      resizing={props.resizing ?? false}
    >
      <div data-testid="drawer-chat-page">chat page</div>
    </ChatDrawer>
  )
  return { ...utils, onNewChat, onClose, onResizeHandleMouseDown, onResizeHandleKeyDown }
}

describe('ChatDrawer', () => {
  it('renders the header slot, the embedded chat page, and its actions', () => {
    renderDrawer()
    expect(screen.getByText('Drawer chat')).toBeTruthy()
    expect(screen.getByTestId('drawer-chat-page')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'New chat' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Close chat drawer' })).toBeTruthy()
  })

  it('wires the new-chat and close actions', () => {
    const { onNewChat, onClose } = renderDrawer()
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close chat drawer' }))
    expect(onNewChat).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('sizes the header CTA icons to the app standard (16px), not the raw viewBox', () => {
    const { container } = renderDrawer()
    const svgs = container.querySelectorAll('.chat-drawer__header-actions .ui-icon-button svg')
    expect(svgs.length).toBe(2)
    svgs.forEach(svg => {
      expect(getComputedStyle(svg as Element).width).toBe('16px')
      expect(getComputedStyle(svg as Element).height).toBe('16px')
    })
  })

  it('stays hidden and inert until the embed acknowledges its shrunk bounds', () => {
    const { container } = renderDrawer({ ready: false })
    const drawer = container.querySelector('.chat-drawer') as HTMLElement
    expect(drawer.getAttribute('data-ready')).toBe('false')
    expect(drawer.classList.contains('is-ready')).toBe(false)
    expect(getComputedStyle(drawer).opacity).toBe('0')
    expect(getComputedStyle(drawer).pointerEvents).toBe('none')
  })

  it('confines the composer reference submenu to the drawer interior, off the embed rect', () => {
    // Right-docked drawer: the embed is to its LEFT, so the composer submenu must
    // stay anchored rightward (left: 100%+, right: auto) to render over drawer DOM
    // instead of being occluded by the native view. A left flip would cross the
    // embed rect — the confinement guards against that.
    const rule = stylesheet.match(/\.chat-drawer \.composer-reference-submenu\s*\{([^}]*)\}/)?.[1]
    expect(rule).toBeTruthy()
    expect(rule).toMatch(/left:\s*calc\(100% \+ var\(--space-1\)\)/)
    expect(rule).toMatch(/right:\s*auto/)
  })

  it('exposes a left-edge resize handle that fires the drag callback on mousedown', () => {
    const { container, onResizeHandleMouseDown } = renderDrawer()
    const handle = container.querySelector('.chat-drawer__resize-handle') as HTMLElement
    expect(handle).toBeTruthy()
    expect(handle.getAttribute('aria-orientation')).toBe('vertical')
    expect(getComputedStyle(handle).cursor).toBe('col-resize')
    fireEvent.mouseDown(handle)
    expect(onResizeHandleMouseDown).toHaveBeenCalledTimes(1)
  })

  it('makes the resize handle keyboard-operable per the ARIA separator pattern', () => {
    const { container, onResizeHandleKeyDown } = renderDrawer({ width: 512 })
    const handle = container.querySelector('.chat-drawer__resize-handle') as HTMLElement
    // Focusable, with the value semantics the separator role requires.
    expect(handle.getAttribute('tabindex')).toBe('0')
    expect(handle.getAttribute('aria-valuemin')).toBe('340')
    expect(handle.getAttribute('aria-valuemax')).toBe('820')
    expect(handle.getAttribute('aria-valuenow')).toBe('512')
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(onResizeHandleKeyDown).toHaveBeenCalledTimes(1)
  })

  it('reveals once ready', () => {
    const { container } = renderDrawer({ ready: true })
    const drawer = container.querySelector('.chat-drawer') as HTMLElement
    expect(drawer.getAttribute('data-ready')).toBe('true')
    expect(drawer.classList.contains('is-ready')).toBe(true)
    expect(getComputedStyle(drawer).opacity).toBe('1')
    expect(getComputedStyle(drawer).pointerEvents).toBe('auto')
  })
})
