// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { createEmptyWorkspaceTabsState, openAppTab, selectWorkspaceTab } from '@lib/workspaceTabs'
import { WorkspaceTabStrip } from '.'
import { installSyntheticTabStripLayout } from './__fixtures__/tabStripLayout'

const observers: ControlledResizeObserver[] = []

class ControlledResizeObserver {
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
    this.deliverQueued(target)
  }

  deliverQueued(target: Element) {
    const entry = { target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry
    act(() => this.callback([entry], this as unknown as ResizeObserver))
  }
}

function makeFourAppTabs() {
  let state = createEmptyWorkspaceTabsState()
  for (let index = 0; index < 4; index += 1) {
    state = openAppTab(state, {
      id: `edge-${index}`,
      appRef: 'example/app',
      title: `Edge ${index}`,
    })
  }
  return selectWorkspaceTab(state, 'edge-0')
}

beforeEach(() => {
  observers.length = 0
  vi.stubGlobal('ResizeObserver', ControlledResizeObserver)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('WorkspaceTabStrip r15 one-pixel edge', () => {
  it('completes the committed Apps-to-Chat reveal within epsilon and preserves later manual scroll', () => {
    const storeState = makeFourAppTabs()
    const selectedId = storeState.activeTabId!
    const onSelect = vi.fn()
    const view = render(
      <WorkspaceTabStrip
        tabs={storeState.tabs}
        activeTabId={null}
        onSelect={onSelect}
        onClose={vi.fn()}
        onReorder={vi.fn()}
      />
    )
    const scroller = view.container.querySelector('.chat-view-tabs__scroller') as HTMLElement
    const layout = installSyntheticTabStripLayout(view.container, [96, 96, 96, 96], 248)
    layout.measure()
    const appsObserver = observers.at(-1)!
    expect(view.container.querySelectorAll('.chat-view-tabs__scroll-button')).toHaveLength(2)

    // Apps Picker projects null while the producer-owned store selection remains A.
    expect(storeState.activeTabId).toBe(selectedId)
    expect(view.container.querySelectorAll('[role="tab"][aria-selected="true"]')).toHaveLength(0)
    layout.setScrollLeft(1)

    // Returning to Chat commits A. At scrollLeft=1, A's left edge is exactly one
    // CSS pixel before the viewport; the upstream inclusive epsilon completes it.
    view.rerender(
      <WorkspaceTabStrip
        tabs={storeState.tabs}
        activeTabId={selectedId}
        onSelect={onSelect}
        onClose={vi.fn()}
        onReorder={vi.fn()}
      />
    )
    const chatObserver = observers.at(-1)!
    expect(appsObserver.disconnected).toBe(true)
    const activeTab = view.container.querySelector<HTMLElement>(
      `[data-workspace-tab-id="${selectedId}"].chat-view-tab`
    )!
    const viewport = scroller.getBoundingClientRect()
    const activeBounds = activeTab.getBoundingClientRect()
    expect(
      view.container
        .querySelector('[role="tab"][aria-selected="true"]')
        ?.getAttribute('data-workspace-tab-id')
    ).toBe(selectedId)
    expect(activeBounds.left - viewport.left).toBe(-1)
    expect(layout.scrollLeft()).toBe(1)

    // An old same-mount observer callback and the current observer cannot revive
    // the completed reveal. A later real scroll remains authoritative.
    appsObserver.deliverQueued(scroller)
    chatObserver.notify(scroller)
    expect(layout.scrollLeft()).toBe(1)
    layout.setScrollLeft(31)
    fireEvent.scroll(scroller)
    appsObserver.deliverQueued(scroller)
    chatObserver.notify(scroller)
    expect(layout.scrollLeft()).toBe(31)
    expect(onSelect).not.toHaveBeenCalled()
  })
})
