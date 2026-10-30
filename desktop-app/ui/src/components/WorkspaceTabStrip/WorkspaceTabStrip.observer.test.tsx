// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  closeWorkspaceTab,
  createEmptyWorkspaceTabsState,
  openAppTab,
  reorderWorkspaceTab,
} from '@lib/workspaceTabs'
import { WorkspaceTabStrip } from '.'
import { installTabStripLayout } from './__fixtures__/tabStripLayout'

const observers: ElementResizeObserver[] = []
class ElementResizeObserver {
  readonly targets = new Set<Element>()
  disconnected = false
  constructor(private readonly callback: ResizeObserverCallback) {
    observers.push(this)
  }
  observe(target: Element) {
    this.targets.add(target)
  }
  unobserve(target: Element) {
    this.targets.delete(target)
  }
  disconnect() {
    this.disconnected = true
    this.targets.clear()
  }
  notify(target: Element) {
    if (!this.targets.has(target)) return
    const entry = { target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry
    act(() => this.callback([entry], this as unknown as ResizeObserver))
  }
}

const makeTabs = (count: number) => {
  let state = createEmptyWorkspaceTabsState()
  for (let index = 0; index < count; index += 1) {
    state = openAppTab(state, { id: `observer-${index}`, appRef: 'example/app', title: `${index}` })
  }
  return state
}
const unavailable = (button: HTMLElement) =>
  button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true'

beforeEach(() => {
  observers.length = 0
  vi.stubGlobal('ResizeObserver', ElementResizeObserver)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('WorkspaceTabStrip element measurement', () => {
  it('observes the scroller and list and responds to element widths without window resize', () => {
    const onSelect = vi.fn()
    const view = render(
      <WorkspaceTabStrip
        tabs={makeTabs(3).tabs}
        activeTabId={null}
        onSelect={onSelect}
        onClose={vi.fn()}
        onReorder={vi.fn()}
      />
    )
    const scroller = view.container.querySelector('.chat-view-tabs__scroller') as HTMLElement
    const list = scroller.firstElementChild!
    const layout = installTabStripLayout(view.container, [96, 140, 120], 248)
    const observer = observers.at(-1)!
    expect([...observer.targets]).toEqual([scroller, list])
    const resizeListener = vi.fn()
    window.addEventListener('resize', resizeListener)
    try {
      observer.notify(scroller)
      observer.notify(scroller)
      const left = screen.getByRole('button', { name: 'Scroll tabs left' })
      const right = screen.getByRole('button', { name: 'Scroll tabs right' })
      expect(unavailable(left)).toBe(true)
      expect(unavailable(right)).toBe(false)
      layout.setScrollLeft(60)
      fireEvent.scroll(scroller)
      layout.setStripWidth(210)
      observer.notify(scroller)
      expect(layout.scrollLeft()).toBe(60)
      expect(unavailable(left)).toBe(false)
      layout.setStripWidth(600)
      observer.notify(scroller)
      observer.notify(scroller)
      expect(screen.queryByRole('button', { name: 'Scroll tabs right' })).toBeNull()
      layout.setStripWidth(248)
      observer.notify(list)
      observer.notify(scroller)
      expect(screen.getByRole('button', { name: 'Scroll tabs right' })).toBeTruthy()
      expect(resizeListener).not.toHaveBeenCalled()
      expect(onSelect).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('resize', resizeListener)
    }
  })

  it('refreshes measured boundaries after store-produced insertion, reorder and removal', () => {
    let state = makeTabs(2)
    const props = { activeTabId: null, onSelect: vi.fn(), onClose: vi.fn(), onReorder: vi.fn() }
    const view = render(<WorkspaceTabStrip {...props} tabs={state.tabs} />)
    const scroller = view.container.querySelector('.chat-view-tabs__scroller') as HTMLElement
    const layout = installTabStripLayout(view.container, [96, 140], 248)
    const restoreRects = layout.trackFutureTabRects()
    try {
      observers.at(-1)!.notify(scroller)
      observers.at(-1)!.notify(scroller)
      const original = observers.at(-1)!
      state = openAppTab(state, { id: 'inserted', appRef: 'example/app', title: 'Inserted' })
      layout.setWidths([96, 140, 120])
      view.rerender(<WorkspaceTabStrip {...props} tabs={state.tabs} />)
      layout.syncTabRects()
      expect(original.disconnected).toBe(true)
      expect([...observers.at(-1)!.targets]).toEqual([scroller, scroller.firstElementChild])
      observers.at(-1)!.notify(scroller.firstElementChild!)
      fireEvent.click(screen.getByRole('button', { name: 'Scroll tabs right' }))
      expect(layout.scrollLeft()).toBe(44)
      state = reorderWorkspaceTab(state, 'inserted', 0)
      layout.setWidths([120, 96, 140])
      view.rerender(<WorkspaceTabStrip {...props} tabs={state.tabs} />)
      layout.syncTabRects()
      expect(
        Array.from(scroller.firstElementChild!.children).map(
          tab => (tab as HTMLElement).dataset.workspaceTabId
        )
      ).toEqual(['inserted', 'observer-0', 'observer-1'])
      layout.setScrollLeft(0)
      observers.at(-1)!.notify(scroller.firstElementChild!)
      fireEvent.click(screen.getByRole('button', { name: 'Scroll tabs right' }))
      expect(layout.scrollLeft()).toBe(24)
      state = closeWorkspaceTab(closeWorkspaceTab(state, 'observer-0'), 'observer-1')
      layout.setWidths([120])
      view.rerender(<WorkspaceTabStrip {...props} tabs={state.tabs} />)
      observers.at(-1)!.notify(scroller.firstElementChild!)
      expect(screen.queryByRole('button', { name: 'Scroll tabs right' })).toBeNull()
      expect(props.onSelect).not.toHaveBeenCalled()
    } finally {
      restoreRects()
    }
  })

  it('disconnects each observer and removes its exact listeners across rerender and unmount', () => {
    const addWindow = vi.spyOn(window, 'addEventListener')
    const removeWindow = vi.spyOn(window, 'removeEventListener')
    const addElement = vi.spyOn(HTMLElement.prototype, 'addEventListener')
    const removeElement = vi.spyOn(HTMLElement.prototype, 'removeEventListener')
    let state = makeTabs(2)
    const props = { activeTabId: null, onSelect: vi.fn(), onClose: vi.fn(), onReorder: vi.fn() }
    const view = render(<WorkspaceTabStrip {...props} tabs={state.tabs} />)
    const scroller = view.container.querySelector('.chat-view-tabs__scroller') as HTMLElement
    state = openAppTab(state, { id: 'later', appRef: 'example/app', title: 'Later' })
    view.rerender(<WorkspaceTabStrip {...props} tabs={state.tabs} />)
    expect(observers).toHaveLength(2)
    const firstObserver = observers[0]
    if (!firstObserver) throw new Error('Expected the first ResizeObserver to be recorded')
    expect(firstObserver.disconnected).toBe(true)
    view.unmount()
    expect(observers.every(observer => observer.disconnected && observer.targets.size === 0)).toBe(
      true
    )
    for (const [event, callback] of addWindow.mock.calls.filter(([event]) => event === 'resize')) {
      expect(
        removeWindow.mock.calls.filter(call => call[0] === event && call[1] === callback)
      ).toHaveLength(1)
    }
    const ownedListeners = addElement.mock.calls.filter(
      (call, index) =>
        addElement.mock.contexts[index] === scroller && ['scroll', 'wheel'].includes(call[0])
    )
    expect(ownedListeners.filter(([event]) => event === 'scroll')).toHaveLength(2)
    expect(ownedListeners.filter(([event]) => event === 'wheel')).toHaveLength(1)
    for (const [event, callback] of ownedListeners) {
      expect(
        removeElement.mock.calls.filter(
          (call, index) =>
            removeElement.mock.contexts[index] === scroller &&
            call[0] === event &&
            call[1] === callback
        )
      ).toHaveLength(1)
    }
  })
})
