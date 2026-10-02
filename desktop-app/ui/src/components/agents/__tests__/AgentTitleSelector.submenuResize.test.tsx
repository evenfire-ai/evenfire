// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AgentTitleSelector } from '../AgentTitleSelector'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const OPTIONS = [
  { id: 'alpha', label: 'Alpha' },
  { id: 'beta', label: 'Beta' },
]

// jsdom performs no layout, so every getBoundingClientRect is 0. Give each node
// the geometry the hook reads, from a function so the same stub reflects the
// current `geom.dx` (the resize) and, for the dots anchor, the parent menu's
// COMMITTED style.left — which is exactly how the anchor moves in production.
function setRect(
  el: Element,
  fn: () => { left: number; top: number; width: number; height: number }
) {
  el.getBoundingClientRect = () => {
    const r = fn()
    return {
      left: r.left,
      top: r.top,
      right: r.left + r.width,
      bottom: r.top + r.height,
      width: r.width,
      height: r.height,
      x: r.left,
      y: r.top,
      toJSON: () => ({}),
    } as DOMRect
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('AgentTitleSelector — nested submenu follows a resized parent menu', () => {
  it('re-anchors the submenu when a window resize repositions the portaled parent menu', () => {
    // Real viewport + a right-docked drawer; a zero-width bounds rect would make
    // the hook fall back to the viewport and mask the bug under test.
    window.innerWidth = 1200
    window.innerHeight = 1000

    // A window resize shifts the drawer + its trigger right by Δ; the parent
    // menu ('below', anchored to the in-drawer trigger) tracks the trigger, and
    // the dots anchor (a menu child) tracks the parent menu's committed left.
    const geom = { dx: 0 }
    const DELTA = 40
    const MENU_ANCHOR_OFFSET = 20 // dots.left = parentMenu.style.left + this

    const drawer = document.createElement('div')
    drawer.className = 'chat-drawer'
    document.body.appendChild(drawer)
    // Drawer docked to the right; area = [808+dx, 1192+dx] after the 8px inset.
    setRect(drawer, () => ({ left: 800 + geom.dx, top: 0, width: 400, height: 800 }))

    const onSelectAgent = vi.fn()
    const onOpenRoute = vi.fn()
    render(
      <AgentTitleSelector
        ariaLabel="Switch chat agent"
        emptyLabel="No agents"
        options={OPTIONS}
        selectedId="alpha"
        selectedLabel="Alpha"
        onSelectAgent={onSelectAgent}
        onOpenRoute={onOpenRoute}
      />,
      { container: drawer }
    )

    // Trigger lives in the drawer; the menu 'below' left tracks trigger.left.
    const trigger = screen.getByRole('button', { name: 'Switch chat agent' })
    setRect(trigger, () => ({ left: 850 + geom.dx, top: 50, width: 100, height: 30 }))

    // Open the parent menu. With dx=0: menu 'below' left = clamp(850, …) = 850.
    fireEvent.click(trigger)
    const menuEl = document.querySelector('.agent-title-selector-menu') as HTMLElement
    expect(menuEl).not.toBeNull()
    setRect(menuEl, () => ({
      left: parseFloat(menuEl.style.left) || 0,
      top: parseFloat(menuEl.style.top) || 0,
      width: 200,
      height: 250,
    }))
    expect(menuEl.style.left).toBe('850px')

    // The dots anchor (a menu child) is portaled with the menu; its on-screen
    // left DERIVES from the parent menu's committed style.left, so it "moves
    // with the parent" — and during the resize batch it reads the parent's OLD
    // (uncommitted) left, exactly as in production.
    const dots = screen.getByRole('menuitem', { name: 'Open Alpha sections' })
    setRect(dots, () => ({
      left: (parseFloat(menuEl.style.left) || 0) + MENU_ANCHOR_OFFSET,
      top: 100,
      width: 10,
      height: 16,
    }))

    // Open the submenu. 'right-of' from dots.right (880): left = 880 + 6 = 886.
    fireEvent.click(dots)
    const submenu = document.querySelector('.agent-title-selector-submenu') as HTMLElement
    expect(submenu).not.toBeNull()
    const submenuLeft0 = parseFloat(submenu.style.left)
    expect(submenuLeft0).toBe(886)

    // Resize the window so the parent menu repositions by Δ. Batched updates:
    // the submenu measures the dots anchor before the parent's new left commits.
    act(() => {
      geom.dx = DELTA
      window.dispatchEvent(new Event('resize'))
    })

    // Observable result: the parent moved by Δ (850 → 890), so the dots anchor
    // moved by Δ, so the submenu must follow — left = 886 + Δ = 926. Without the
    // recompute after the parent commits, the submenu keeps its pre-resize 886.
    expect(menuEl.style.left).toBe(`${850 + DELTA}px`)
    expect(submenu.style.left).toBe(`${submenuLeft0 + DELTA}px`)
    expect(submenu.style.left).toBe('926px')
  })
})
