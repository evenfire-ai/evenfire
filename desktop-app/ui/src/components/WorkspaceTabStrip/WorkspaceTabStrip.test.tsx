// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTaskKey } from '@contexts/AgentTaskTrackerContext/types'
import { ChatListProvider } from '@contexts/ChatListContext'
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { MAX_TAB_TITLE_LEN } from '@constants/workspaceTabs'
import { createSessionFsmStore, projectSessionState } from '@hooks/domain/sessionFsm'
import {
  closeWorkspaceTab,
  createEmptyWorkspaceTabsState,
  createWorkspaceTabsState,
  newChatTab,
  openAppTab,
  openChatTab,
  openSettingsTab,
  reorderWorkspaceTab,
  setAppTabTitle,
} from '@lib/workspaceTabs'
import type { WorkspaceTabsState } from '@lib/workspaceTabs.types'
import { WorkspaceTabStrip } from '.'
import { installTabStripLayout } from './__fixtures__/tabStripLayout'

afterEach(cleanup)

// Fixtures are derived from the real universal-store producers, never hand-built
// WorkspaceTab objects — if the store's tab shape changes, these stop compiling
// against the real form (T1). `openChatTab` collapses the first persisted chat
// into the seed blank tab, so the ids resolve deterministically.
const twoChatTabs = newChatTab(
  openChatTab(createWorkspaceTabsState('one', 'alpha'), {
    id: 'one-persisted',
    agentRef: 'alpha',
    chatId: 'chat-1',
    title: 'First chat',
  }),
  'two',
  'alpha'
).tabs

describe('WorkspaceTabStrip', () => {
  it.each([1, 3])(
    'retains a pending active reveal until its tab mounts (%i initial tabs)',
    initialCount => {
      let state = createEmptyWorkspaceTabsState()
      for (let index = 0; index < 4; index += 1) {
        state = openAppTab(state, {
          id: `delayed-${index}`,
          appRef: 'example/app',
          title: `Delayed ${index}`,
        })
      }
      const onSelect = vi.fn()
      const props = { onClose: vi.fn(), onReorder: vi.fn(), onSelect }
      const view = render(
        <WorkspaceTabStrip
          {...props}
          activeTabId="delayed-0"
          tabs={state.tabs.slice(0, initialCount)}
        />
      )
      const layout = installTabStripLayout(view.container, Array(initialCount).fill(96), 248)
      const restoreRects = layout.trackFutureTabRects()
      try {
        layout.measure()
        view.rerender(
          <WorkspaceTabStrip
            {...props}
            activeTabId="delayed-3"
            tabs={state.tabs.slice(0, initialCount)}
          />
        )
        expect(layout.scrollLeft()).toBe(0)
        layout.setWidths([96, 96, 96, 96])
        view.rerender(<WorkspaceTabStrip {...props} activeTabId="delayed-3" tabs={state.tabs} />)
        expect(layout.scrollLeft()).toBe(layout.maximumScrollLeft())
        expect(onSelect).not.toHaveBeenCalled()

        layout.setScrollLeft(10)
        fireEvent.scroll(view.container.querySelector('.chat-view-tabs__scroller')!)
        view.rerender(
          <WorkspaceTabStrip {...props} activeTabId="delayed-3" tabs={[...state.tabs]} />
        )
        expect(layout.scrollLeft()).toBe(10)
        layout.resize(600)
        layout.resize(248)
        expect(layout.scrollLeft()).toBe(0)
      } finally {
        restoreRects()
      }
    }
  )

  it.each([null, 'stale-0'])(
    'cancels a pending reveal when the active ID changes to %s',
    nextActiveId => {
      let state = createEmptyWorkspaceTabsState()
      for (let index = 0; index < 4; index += 1) {
        state = openAppTab(state, {
          id: `stale-${index}`,
          appRef: 'example/app',
          title: `Stale ${index}`,
        })
      }
      const props = { onClose: vi.fn(), onReorder: vi.fn(), onSelect: vi.fn() }
      const view = render(
        <WorkspaceTabStrip {...props} activeTabId="stale-0" tabs={state.tabs.slice(0, 1)} />
      )
      const layout = installTabStripLayout(view.container, [96], 248)
      const restoreRects = layout.trackFutureTabRects()
      try {
        layout.measure()
        view.rerender(
          <WorkspaceTabStrip {...props} activeTabId="stale-3" tabs={state.tabs.slice(0, 1)} />
        )
        view.rerender(
          <WorkspaceTabStrip {...props} activeTabId={nextActiveId} tabs={state.tabs.slice(0, 1)} />
        )
        layout.setWidths([96, 96, 96, 96])
        view.rerender(<WorkspaceTabStrip {...props} activeTabId={nextActiveId} tabs={state.tabs} />)
        expect(layout.scrollLeft()).toBe(0)
        expect(props.onSelect).not.toHaveBeenCalled()
      } finally {
        restoreRects()
      }
    }
  )

  it('supersedes a missing active target with the latest missing target', () => {
    let state = createEmptyWorkspaceTabsState()
    for (let index = 0; index < 5; index += 1) {
      state = openAppTab(state, {
        id: `latest-${index}`,
        appRef: 'example/app',
        title: `Latest ${index}`,
      })
    }
    const props = { onClose: vi.fn(), onReorder: vi.fn(), onSelect: vi.fn() }
    const view = render(
      <WorkspaceTabStrip {...props} activeTabId="latest-0" tabs={state.tabs.slice(0, 1)} />
    )
    const layout = installTabStripLayout(view.container, [96], 248)
    const restoreRects = layout.trackFutureTabRects()
    try {
      layout.measure()
      view.rerender(
        <WorkspaceTabStrip {...props} activeTabId="latest-3" tabs={state.tabs.slice(0, 1)} />
      )
      view.rerender(
        <WorkspaceTabStrip {...props} activeTabId="latest-4" tabs={state.tabs.slice(0, 1)} />
      )
      layout.setWidths([96, 96, 96, 96])
      view.rerender(
        <WorkspaceTabStrip {...props} activeTabId="latest-4" tabs={state.tabs.slice(0, 4)} />
      )
      expect(layout.scrollLeft()).toBe(0)
      layout.setWidths([96, 96, 96, 96, 96])
      view.rerender(<WorkspaceTabStrip {...props} activeTabId="latest-4" tabs={state.tabs} />)
      expect(layout.scrollLeft()).toBe(layout.maximumScrollLeft())
    } finally {
      restoreRects()
    }
  })

  it('waits for a measurable viewport before consuming an active reveal', () => {
    let state = createEmptyWorkspaceTabsState()
    for (let index = 0; index < 4; index += 1) {
      state = openAppTab(state, {
        id: `hidden-${index}`,
        appRef: 'example/app',
        title: `Hidden ${index}`,
      })
    }
    const props = { onClose: vi.fn(), onReorder: vi.fn(), onSelect: vi.fn() }
    const view = render(<WorkspaceTabStrip {...props} activeTabId={null} tabs={state.tabs} />)
    const layout = installTabStripLayout(view.container, [96, 96, 96, 96], 48)
    layout.measure()
    view.rerender(<WorkspaceTabStrip {...props} activeTabId="hidden-3" tabs={state.tabs} />)
    expect(layout.viewportWidth()).toBe(0)
    expect(layout.scrollLeft()).toBe(0)
    layout.resize(248)
    expect(layout.scrollLeft()).toBe(layout.maximumScrollLeft())
  })

  it.each([
    { direction: 'right', widths: [96, 140], expected: 26 },
    { direction: 'left', widths: [96, 140], expected: 0 },
    { direction: 'right', widths: [160, 96, 120], expected: 90 },
    { direction: 'left', widths: [160, 96, 120], expected: 0 },
  ])(
    'moves $direction using oversized variable-width tab boundaries ($widths)',
    ({ direction, widths, expected }) => {
      let state = createEmptyWorkspaceTabsState()
      widths.forEach((_, index) => {
        state = openAppTab(state, {
          id: `oversized-${index}`,
          appRef: 'example/app',
          title: `Oversized ${index}`,
        })
      })
      const onSelect = vi.fn()
      const view = render(
        <WorkspaceTabStrip
          activeTabId={null}
          onClose={vi.fn()}
          onReorder={vi.fn()}
          onSelect={onSelect}
          tabs={state.tabs}
        />
      )
      const layout = installTabStripLayout(view.container, widths, 118)
      layout.measure()
      expect(layout.viewportWidth()).toBe(70)
      layout.setScrollLeft(10)
      fireEvent.scroll(view.container.querySelector('.chat-view-tabs__scroller')!)
      fireEvent.click(screen.getByRole('button', { name: `Scroll tabs ${direction}` }))
      expect(layout.scrollLeft()).toBe(expected)
      expect(direction === 'right' ? layout.scrollLeft() > 10 : layout.scrollLeft() < 10).toBe(true)
      expect(onSelect).not.toHaveBeenCalled()
      expect(view.container.querySelector('.chat-view-tab.is-active')).toBeNull()
    }
  )

  it('renders the tab order and exposes non-destructive view actions', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(
      <WorkspaceTabStrip
        tabs={twoChatTabs}
        activeTabId="one"
        onSelect={onSelect}
        onClose={onClose}
        onReorder={vi.fn()}
      />
    )

    expect(screen.getByRole('toolbar', { name: 'Workspace tabs' })).toBeTruthy()
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
    const longTabs = openChatTab(createWorkspaceTabsState('one', 'alpha'), {
      id: 'one-persisted',
      agentRef: 'alpha',
      chatId: 'chat-1',
      title: longTitle,
    }).tabs
    const { container } = render(
      <WorkspaceTabStrip
        tabs={longTabs}
        activeTabId="one"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onReorder={vi.fn()}
      />
    )

    const select = screen.getByRole('button', { name: longTitle })
    const scroller = container.querySelector('.chat-view-tabs__scroller')
    const list = container.querySelector('.chat-view-tabs__list')
    const label = container.querySelector('.chat-view-tab__label')
    const close = screen.getByRole('button', { name: `Close ${longTitle}` })
    expect(select.classList.contains('ui-button--align-start')).toBe(true)
    expect(label?.textContent).toBe(longTitle)
    expect(select.nextElementSibling).toBe(close)
    expect(scroller?.firstElementChild).toBe(list)

    const styles = readFileSync(path.join(process.cwd(), 'ui', 'src', 'styles.css'), 'utf8')
    expect(styles).toMatch(/\.chat-view-tabs\s*\{[^}]*padding:\s*var\(--space-2\) 0 0;/s)
    expect(styles).toMatch(/\.chat-view-tabs__scroller\s*\{[^}]*overflow-x:\s*auto;/s)
    expect(styles).toMatch(/\.chat-view-tabs__scroller\s*\{[^}]*scrollbar-width:\s*none;/s)
    expect(styles).toMatch(
      /\.chat-view-tabs__scroller::\-webkit-scrollbar\s*\{[^}]*display:\s*none;/s
    )
    expect(styles).toMatch(/\.chat-view-tabs__scroll-button\s*\{[^}]*flex:\s*0 0 auto;/s)
    expect(styles).toMatch(/\.chat-view-tabs__list\s*\{[^}]*width:\s*100%;/s)
    expect(styles).toMatch(/\.chat-view-tab\s*\{[^}]*flex:\s*1 1 var\(--chat-tab-max\);/s)
    expect(styles).toMatch(/\.chat-view-tab\s*\{[^}]*max-width:\s*var\(--chat-tab-max\);/s)
    expect(styles).toMatch(/\.chat-view-tab\s*\{[^}]*min-width:\s*var\(--chat-tab-min\);/s)
    expect(styles).toMatch(
      /\.chat-view-tab\.is-active\s*\{[^}]*box-shadow:\s*inset 0 2px 0 0 var\(--accent\);/s
    )
    expect(styles).toMatch(/\.ui-button:focus-visible,[\s\S]*outline:\s*1px solid var\(--accent\);/)
    expect(styles).toMatch(
      /\.ui-icon-button:focus-visible,[^{}]*\{[^}]*outline:\s*1px solid var\(--accent\);/
    )
    const activeRule = styles.match(/\.chat-view-tab\.is-active\s*\{([^}]*)\}/s)?.[1] ?? ''
    expect(activeRule).not.toMatch(/outline\s*:/)
    expect(styles).toMatch(/\.chat-view-tabs::after\s*\{[^}]*z-index:\s*-1;/s)
    expect(styles).toMatch(
      /\.chat-view-tab:not\(\.is-active\)\s*\{[^}]*border-bottom:\s*1px solid var\(--chat-view-selected-border\);/s
    )
    expect(styles).toMatch(/\.chat-view-tab__select\s*\{[^}]*flex:\s*1 1 auto;/s)
    expect(styles).toMatch(/\.chat-view-tab__label\s*\{[^}]*text-overflow:\s*ellipsis;/s)
  })

  it('shows arrows only for overflow and updates them after resize, insertion, and removal', () => {
    let state = openAppTab(createEmptyWorkspaceTabsState(), {
      id: 'tab-one',
      appRef: 'example/app',
      title: 'One',
    })
    state = openAppTab(state, { id: 'tab-two', appRef: 'example/app', title: 'Two' })
    const onClose = (id: string) => {
      state = closeWorkspaceTab(state, id)
    }
    const view = render(
      <WorkspaceTabStrip
        activeTabId={state.activeTabId}
        onClose={onClose}
        onReorder={vi.fn()}
        onSelect={vi.fn()}
        tabs={state.tabs}
      />
    )
    const layout = installTabStripLayout(view.container, [120, 120], 300)
    layout.measure()
    expect(screen.queryByRole('button', { name: 'Scroll tabs left' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Scroll tabs right' })).toBeNull()

    state = openAppTab(state, { id: 'tab-three', appRef: 'example/app', title: 'Three' })
    layout.setWidths([120, 120, 120])
    const restoreFutureRects = layout.trackFutureTabRects()
    view.rerender(
      <WorkspaceTabStrip
        activeTabId={state.activeTabId}
        onClose={onClose}
        onReorder={vi.fn()}
        onSelect={vi.fn()}
        tabs={state.tabs}
      />
    )
    restoreFutureRects()
    layout.syncTabRects()
    expect(
      screen.getByRole('button', { name: 'Scroll tabs left' }).matches('[aria-disabled="true"]')
    ).toBe(false)
    expect(
      screen.getByRole('button', { name: 'Scroll tabs right' }).matches('[aria-disabled="true"]')
    ).toBe(true)

    layout.resize(500)
    expect(screen.queryByRole('button', { name: 'Scroll tabs left' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Scroll tabs right' })).toBeNull()
    layout.resize(300)
    expect(screen.getByRole('button', { name: 'Scroll tabs left' })).toBeTruthy()

    onClose('tab-three')
    layout.setWidths([120, 120])
    view.rerender(
      <WorkspaceTabStrip
        activeTabId={state.activeTabId}
        onClose={onClose}
        onReorder={vi.fn()}
        onSelect={vi.fn()}
        tabs={state.tabs}
      />
    )
    layout.syncTabRects()
    expect(screen.queryByRole('button', { name: 'Scroll tabs left' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Scroll tabs right' })).toBeNull()
  })

  it('does not reveal the unchanged active tab when resizing back into overflow', () => {
    let state = createEmptyWorkspaceTabsState()
    for (let index = 0; index < 3; index += 1) {
      state = openAppTab(state, {
        id: `resize-${index}`,
        appRef: 'example/app',
        title: `Resize ${index}`,
      })
    }
    const view = render(
      <WorkspaceTabStrip
        activeTabId="resize-2"
        onClose={vi.fn()}
        onReorder={vi.fn()}
        onSelect={vi.fn()}
        tabs={state.tabs}
      />
    )
    const layout = installTabStripLayout(view.container, [110, 110, 110], 300)
    layout.measure()
    layout.setScrollLeft(0)
    fireEvent.scroll(view.container.querySelector('.chat-view-tabs__scroller') as HTMLDivElement)
    expect(
      screen.getByRole('button', { name: 'Scroll tabs right' }).matches('[aria-disabled="true"]')
    ).toBe(false)

    // The user moves to the left edge while the last tab stays active. Widening
    // removes overflow and narrowing it again must preserve that edge.
    layout.resize(400)
    expect(screen.queryByRole('button', { name: 'Scroll tabs right' })).toBeNull()
    layout.resize(300)

    expect(layout.scrollLeft()).toBe(0)
    expect(
      screen.getByRole('button', { name: 'Scroll tabs left' }).matches('[aria-disabled="true"]')
    ).toBe(true)
    expect(
      screen.getByRole('button', { name: 'Scroll tabs right' }).matches('[aria-disabled="true"]')
    ).toBe(false)
  })

  it('reveals measured tabs, follows active changes, and leaves manual scroll alone', () => {
    let state = createEmptyWorkspaceTabsState()
    const widths = [110, 135, 95, 160, 125]
    for (let index = 0; index < widths.length; index += 1) {
      state = openAppTab(state, {
        id: `tab-${index}`,
        appRef: 'example/app',
        title: `Tab ${index}`,
      })
    }
    const onSelect = vi.fn()
    const view = render(
      <WorkspaceTabStrip
        activeTabId="tab-0"
        onClose={vi.fn()}
        onReorder={vi.fn()}
        onSelect={onSelect}
        tabs={state.tabs}
      />
    )
    const layout = installTabStripLayout(view.container, widths, 300)
    layout.measure()
    const left = screen.getByRole('button', { name: 'Scroll tabs left' })
    const right = screen.getByRole('button', { name: 'Scroll tabs right' })
    expect(left.matches('[aria-disabled="true"]')).toBe(true)
    expect(right.matches('[aria-disabled="true"]')).toBe(false)

    fireEvent.click(right)
    expect(layout.scrollLeft()).toBe(104)
    fireEvent.click(right)
    expect(layout.scrollLeft()).toBe(272)
    expect(onSelect).not.toHaveBeenCalled()

    for (let click = 0; click < 5 && !right.matches('[aria-disabled="true"]'); click += 1) {
      fireEvent.click(right)
    }
    expect(layout.scrollLeft()).toBe(layout.maximumScrollLeft())
    expect(right.matches('[aria-disabled="true"]')).toBe(true)
    expect(left.matches('[aria-disabled="true"]')).toBe(false)

    fireEvent.click(left)
    expect(layout.scrollLeft()).toBe(364)
    expect(left.matches('[aria-disabled="true"]')).toBe(false)
    expect(onSelect).not.toHaveBeenCalled()

    layout.setScrollLeft(100)
    fireEvent.scroll(view.container.querySelector('.chat-view-tabs__scroller') as HTMLDivElement)
    view.rerender(
      <WorkspaceTabStrip
        activeTabId="tab-0"
        onClose={vi.fn()}
        onReorder={vi.fn()}
        onSelect={onSelect}
        tabs={state.tabs}
      />
    )
    expect(layout.scrollLeft()).toBe(100)

    view.rerender(
      <WorkspaceTabStrip
        activeTabId="tab-4"
        onClose={vi.fn()}
        onReorder={vi.fn()}
        onSelect={onSelect}
        tabs={state.tabs}
      />
    )
    expect(layout.scrollLeft()).toBe(layout.maximumScrollLeft())
    layout.setScrollLeft(100)
    fireEvent.scroll(view.container.querySelector('.chat-view-tabs__scroller') as HTMLDivElement)
    view.rerender(
      <WorkspaceTabStrip
        activeTabId="tab-4"
        onClose={vi.fn()}
        onReorder={vi.fn()}
        onSelect={onSelect}
        tabs={state.tabs}
      />
    )
    expect(layout.scrollLeft()).toBe(100)
  })

  it('uses measured nearest-tab boundaries after reorder with edge controls present', () => {
    let state = createEmptyWorkspaceTabsState()
    for (const id of ['a', 'b', 'c', 'd']) {
      state = openAppTab(state, { id, appRef: 'example/app', title: id })
    }
    const onSelect = vi.fn()
    const onReorder = (fromId: string, toIndex: number) => {
      state = reorderWorkspaceTab(state, fromId, toIndex)
    }
    const view = render(
      <WorkspaceTabStrip
        activeTabId="a"
        onClose={vi.fn()}
        onReorder={onReorder}
        onSelect={onSelect}
        tabs={state.tabs}
      />
    )
    const layout = installTabStripLayout(view.container, [60, 60, 60, 60], 150)
    layout.measure()
    expect(layout.viewportWidth()).toBe(102)
    expect(
      screen.getByRole('button', { name: 'Scroll tabs left' }).matches('[aria-disabled="true"]')
    ).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Scroll tabs right' }))
    expect(layout.scrollLeft()).toBe(26)

    state = reorderWorkspaceTab(state, 'd', 0)
    view.rerender(
      <WorkspaceTabStrip
        activeTabId="a"
        onClose={vi.fn()}
        onReorder={onReorder}
        onSelect={onSelect}
        tabs={state.tabs}
      />
    )
    layout.syncTabRects()

    expect(
      Array.from(view.container.querySelectorAll('.chat-view-tab')).map(
        tab => tab.querySelector('.chat-view-tab__label')?.textContent
      )
    ).toEqual(['d', 'a', 'b', 'c'])
    expect(
      screen.getByRole('button', { name: 'Scroll tabs left' }).matches('[aria-disabled="true"]')
    ).toBe(false)
    expect(
      screen.getByRole('button', { name: 'Scroll tabs right' }).matches('[aria-disabled="true"]')
    ).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Scroll tabs right' }))
    expect(layout.scrollLeft()).toBe(94)
    fireEvent.click(screen.getByRole('button', { name: 'Scroll tabs left' }))
    expect(layout.scrollLeft()).toBe(68)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('keeps overflow controls keyboard reachable and scrolls on Enter', async () => {
    let state = createEmptyWorkspaceTabsState()
    for (let index = 0; index < 4; index += 1) {
      state = openAppTab(state, {
        id: `keyboard-${index}`,
        appRef: 'example/app',
        title: `Keyboard ${index}`,
      })
    }
    const onSelect = vi.fn()
    const view = render(
      <WorkspaceTabStrip
        activeTabId="keyboard-0"
        onClose={vi.fn()}
        onReorder={vi.fn()}
        onSelect={onSelect}
        tabs={state.tabs}
      />
    )
    const layout = installTabStripLayout(view.container, [60, 60, 60, 60], 150)
    layout.measure()
    const right = screen.getByRole('button', { name: 'Scroll tabs right' })
    expect(right.tagName).toBe('BUTTON')
    right.focus()
    expect(document.activeElement).toBe(right)

    await userEvent.setup().keyboard('{Enter}')

    expect(layout.scrollLeft()).toBe(26)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('normalizes unmodified wheel input once, passes modifiers through, and refreshes manual-scroll state', () => {
    let state = createEmptyWorkspaceTabsState()
    for (let index = 0; index < 4; index += 1) {
      state = openAppTab(state, {
        id: `wheel-${index}`,
        appRef: 'example/app',
        title: `Wheel ${index}`,
      })
    }
    const onSelect = vi.fn()
    const view = render(
      <WorkspaceTabStrip
        activeTabId="wheel-0"
        onClose={vi.fn()}
        onReorder={vi.fn()}
        onSelect={onSelect}
        tabs={state.tabs}
      />
    )
    const layout = installTabStripLayout(view.container, [110, 110, 110, 110], 200)
    layout.measure()
    const scroller = view.container.querySelector('.chat-view-tabs__scroller') as HTMLDivElement

    const verticalWheel = createEvent.wheel(scroller, {
      deltaY: 2,
      deltaMode: WheelEvent.DOM_DELTA_LINE,
    })
    fireEvent(scroller, verticalWheel)
    expect(layout.scrollLeft()).toBe(32)
    expect(verticalWheel.defaultPrevented).toBe(true)

    const diagonalTrackpad = createEvent.wheel(scroller, { deltaX: 10, deltaY: 20 })
    fireEvent(scroller, diagonalTrackpad)
    expect(layout.scrollLeft()).toBe(42)
    expect(diagonalTrackpad.defaultPrevented).toBe(true)

    const pageWheel = createEvent.wheel(scroller, {
      deltaY: 1,
      deltaMode: WheelEvent.DOM_DELTA_PAGE,
    })
    fireEvent(scroller, pageWheel)
    expect(layout.scrollLeft()).toBe(42 + layout.viewportWidth())
    expect(pageWheel.defaultPrevented).toBe(true)

    for (const modifier of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'] as const) {
      const zoomGesture = createEvent.wheel(scroller, { deltaY: 12, [modifier]: true })
      fireEvent(scroller, zoomGesture)
      expect(layout.scrollLeft()).toBe(42 + layout.viewportWidth())
      expect(zoomGesture.defaultPrevented).toBe(false)
    }

    const outsideWheel = createEvent.wheel(document.body, { deltaY: 12 })
    fireEvent(document.body, outsideWheel)
    expect(layout.scrollLeft()).toBe(42 + layout.viewportWidth())
    expect(outsideWheel.defaultPrevented).toBe(false)

    scroller.scrollLeft = 100
    fireEvent.scroll(scroller)
    expect(layout.scrollLeft()).toBe(100)
    expect(
      screen.getByRole('button', { name: 'Scroll tabs left' }).matches('[aria-disabled="true"]')
    ).toBe(false)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('associates the active tab control with its owned surface, and only that one', () => {
    const tabs = openChatTab(
      openChatTab(createWorkspaceTabsState('one', 'alpha'), {
        id: 'one-persisted',
        agentRef: 'alpha',
        chatId: 'chat-1',
        title: 'First chat',
      }),
      {
        id: 'two',
        agentRef: 'alpha',
        chatId: 'chat-2',
        title: 'A second conversation with a long title that must remain usable',
      }
    ).tabs
    render(
      <WorkspaceTabStrip
        activeTabId="one"
        onClose={vi.fn()}
        onReorder={vi.fn()}
        onSelect={vi.fn()}
        panelId="chat-view-panel"
        tabs={tabs}
      />
    )

    expect(screen.getByRole('button', { name: 'First chat' }).getAttribute('aria-controls')).toBe(
      'chat-view-panel'
    )
    expect(
      screen
        .getByRole('button', {
          name: 'A second conversation with a long title that must remain usable',
        })
        .getAttribute('aria-controls')
    ).toBeNull()
  })

  it('shows running and approval indicators before their chat tab names', () => {
    const runningKey = makeTaskKey('alpha', 'chat-running')
    const approvalKey = makeTaskKey('beta', 'chat-approval')
    const fsm = createSessionFsmStore()
    fsm.dispatch(runningKey, { type: 'SEND_STARTED', taskId: 'task-running' })
    fsm.dispatch(runningKey, { type: 'TASK_CREATED', taskId: 'task-running' })
    fsm.dispatch(approvalKey, { type: 'SEND_STARTED', taskId: 'task-approval' })
    fsm.dispatch(approvalKey, { type: 'TASK_CREATED', taskId: 'task-approval' })
    fsm.dispatch(approvalKey, {
      type: 'STREAM_SUSPENDED',
      taskId: 'task-approval',
      approval: { requestId: 'request-1', displayName: 'Run shell' },
    })
    const sessionStateByChatKey = Object.fromEntries(
      Object.entries(fsm.getSnapshot()).map(([key, state]) => [key, projectSessionState(state)])
    )

    const tabs = newChatTab(
      openChatTab(
        openChatTab(createWorkspaceTabsState('seed', 'alpha'), {
          id: 'running',
          agentRef: 'alpha',
          chatId: 'chat-running',
          title: 'Running chat',
        }),
        { id: 'approval', agentRef: 'beta', chatId: 'chat-approval', title: 'Approval chat' }
      ),
      'blank',
      'alpha'
    ).tabs

    render(
      <ChatListProvider
        value={{
          activeChatId: 'chat-running',
          chatList: [],
          chatListLoading: false,
          latestChatSessions: [],
          latestChatSessionsLoading: false,
          sessionStateByChatId: {},
          sessionStateByChatKey,
        }}
      >
        <WorkspaceTabStrip
          tabs={tabs}
          activeTabId="seed"
          onSelect={vi.fn()}
          onClose={vi.fn()}
          onReorder={vi.fn()}
        />
      </ChatListProvider>
    )

    const running = screen.getByLabelText('Running')
    const awaitingApproval = screen.getByLabelText('Awaiting approval')
    const runningLabel = screen.getByText('Running chat')
    const approvalLabel = screen.getByText('Approval chat')

    expect(screen.getByRole('button', { name: 'Running chat' }).contains(running)).toBe(true)
    expect(screen.getByRole('button', { name: 'Approval chat' }).contains(awaitingApproval)).toBe(
      true
    )
    expect(running.nextElementSibling).toBe(runningLabel)
    expect(awaitingApproval.nextElementSibling).toBe(approvalLabel)
    // The blank chat tab carries no live badge — only the two running/approval do.
    expect(screen.getAllByRole('status')).toHaveLength(2)
  })

  it('renders app and settings tabs alongside chats, with badges only on chat tabs', () => {
    const runningKey = makeTaskKey('alpha', 'chat-1')
    const fsm = createSessionFsmStore()
    fsm.dispatch(runningKey, { type: 'SEND_STARTED', taskId: 'task-running' })
    fsm.dispatch(runningKey, { type: 'TASK_CREATED', taskId: 'task-running' })
    const sessionStateByChatKey = Object.fromEntries(
      Object.entries(fsm.getSnapshot()).map(([key, state]) => [key, projectSessionState(state)])
    )

    // A universal workspace: one running chat, one app, one settings section.
    const tabs = openSettingsTab(
      openAppTab(
        openChatTab(createWorkspaceTabsState('chat', 'alpha'), {
          id: 'chat',
          agentRef: 'alpha',
          chatId: 'chat-1',
          title: 'Running chat',
        }),
        { id: 'app-1', appRef: 'ns/app', title: 'My App' }
      ),
      { id: 'settings-1', section: 'settings', title: 'Settings' }
    ).tabs

    render(
      <ChatListProvider
        value={{
          activeChatId: 'chat-1',
          chatList: [],
          chatListLoading: false,
          latestChatSessions: [],
          latestChatSessionsLoading: false,
          sessionStateByChatId: {},
          sessionStateByChatKey,
        }}
      >
        <WorkspaceTabStrip
          tabs={tabs}
          activeTabId="app-1"
          onSelect={vi.fn()}
          onClose={vi.fn()}
          onReorder={vi.fn()}
        />
      </ChatListProvider>
    )

    expect(screen.getByRole('button', { name: 'Running chat' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'My App' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'My App' }).getAttribute('aria-pressed')).toBe('true')
    // Only the chat tab carries a live session badge — app/settings do not.
    expect(screen.getAllByRole('status')).toHaveLength(1)
  })
})

const cp = (code: number) => String.fromCodePoint(code)

describe('WorkspaceTabStrip — sanitized plugin title reaches the rendered chrome', () => {
  // The reviewer's ask: prove the FINAL workspace-tab label and the FINAL
  // close-button accessible name are clean — not just the pure helper. The title
  // travels the real border (`setAppTabTitle`) into the real store producer, so
  // the render inherits whatever that path actually stores (T1: no hand-built
  // tab). A pointer user sees the label; a screen-reader user hears the close
  // button's accessible name; both must be free of the bidi/invisible payload.
  it('strips bidi marks and invisibles from the tab label and close aria-label', () => {
    // RLO + "EVIL" + PDF + " report" + LRM + ZWSP: a directional-override attack
    // that would reverse the visible order plus a trailing invisible.
    const raw = `${cp(0x202e)}EVIL${cp(0x202c)} report${cp(0x200e)}${cp(0x200b)}`
    const state = setAppTabTitle(
      openAppTab(createEmptyWorkspaceTabsState(), { id: 'app-1', appRef: 'ns/app', title: 'App' }),
      'app-1',
      raw
    )
    const { container } = render(
      <WorkspaceTabStrip
        tabs={state.tabs}
        activeTabId="app-1"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onReorder={vi.fn()}
      />
    )

    expect(container.querySelector('.chat-view-tab__label')?.textContent).toBe('EVIL report')
    expect(screen.getByRole('button', { name: 'Close EVIL report' })).toBeTruthy()
  })

  it('keeps a legitimate ZWJ emoji sequence joined in the rendered label', () => {
    // The 👩‍💻 sequence (👩 + ZWJ + 💻) must survive the border and render as one
    // glyph, not split into 👩💻 — the shaping joiner is legitimate, not a hazard.
    const withEmoji = `Build ${cp(0x1f469)}${cp(0x200d)}${cp(0x1f4bb)}`
    const state = setAppTabTitle(
      openAppTab(createEmptyWorkspaceTabsState(), { id: 'app-1', appRef: 'ns/app', title: 'App' }),
      'app-1',
      withEmoji
    )
    const { container } = render(
      <WorkspaceTabStrip
        tabs={state.tabs}
        activeTabId="app-1"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onReorder={vi.fn()}
      />
    )

    expect(container.querySelector('.chat-view-tab__label')?.textContent).toBe(withEmoji)
    expect(screen.getByRole('button', { name: `Close ${withEmoji}` })).toBeTruthy()
  })

  it('bounds an overlong untrusted title in both the rendered label and the close aria-label', () => {
    // The reviewer's overlong case: a very long title with a leading bidi
    // override and trailing invisibles. The final label AND the close-button
    // accessible name must be the truncated, stripped value — not the raw
    // payload, not a value that overflows the tab into the close control.
    const raw = `${cp(0x202e)}${'A'.repeat(100)}${cp(0x200b)}${cp(0xfeff)}`
    // Derived independently of the sanitizer: the invisibles vanish, leaving 100
    // 'A's truncated to MAX-1 plus the ellipsis.
    const expected = `${'A'.repeat(MAX_TAB_TITLE_LEN - 1)}…`
    const state = setAppTabTitle(
      openAppTab(createEmptyWorkspaceTabsState(), { id: 'app-1', appRef: 'ns/app', title: 'App' }),
      'app-1',
      raw
    )
    const { container } = render(
      <WorkspaceTabStrip
        tabs={state.tabs}
        activeTabId="app-1"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onReorder={vi.fn()}
      />
    )

    const label = container.querySelector('.chat-view-tab__label')?.textContent ?? ''
    expect(label).toBe(expected)
    expect(Array.from(label).length).toBe(MAX_TAB_TITLE_LEN)
    expect(label.endsWith('…')).toBe(true)
    expect(label.includes(cp(0x202e))).toBe(false)
    expect(screen.getByRole('button', { name: `Close ${expected}` })).toBeTruthy()
  })
})

describe('WorkspaceTabStrip — reorder (drag & keyboard)', () => {
  // App tabs keep their ids and never dedupe, so this yields three distinct,
  // stably-ordered tabs [a, b, c] derived from the real store producer (T1).
  const threeTabs = openAppTab(
    openAppTab(
      openAppTab(createEmptyWorkspaceTabsState(), { id: 'a', appRef: 'ns/x', title: 'Alpha' }),
      { id: 'b', appRef: 'ns/x', title: 'Bravo' }
    ),
    { id: 'c', appRef: 'ns/x', title: 'Charlie' }
  ).tabs

  // jsdom returns a zeroed rect from getBoundingClientRect, so the drop side is
  // computed as 'after' for any clientX >= 0. Pin a real 100px-wide rect (midpoint
  // at x=50) on every element so `clientX` selects the half deterministically:
  // clientX < 50 → 'before', >= 50 → 'after'.
  let rectSpy: ReturnType<typeof vi.spyOn> | undefined
  beforeEach(() => {
    rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      width: 100,
      right: 100,
      top: 0,
      bottom: 0,
      height: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect)
  })
  afterEach(() => {
    rectSpy?.mockRestore()
  })

  const makeDataTransfer = () => {
    const store: Record<string, string> = {}
    return {
      effectAllowed: '',
      setData: (type: string, value: string) => {
        store[type] = value
      },
      getData: (type: string) => store[type] ?? '',
    }
  }

  const containerFor = (root: HTMLElement, name: string): HTMLElement =>
    screen.getByRole('button', { name }).closest('.chat-view-tab') as HTMLElement

  // jsdom has no DragEvent, so `fireEvent.drop(..., { clientX })` drops clientX on
  // the floor. Build the event explicitly and pin clientX so the side is real.
  const fireDrag = (
    kind: 'dragOver' | 'drop',
    node: HTMLElement,
    dataTransfer: unknown,
    clientX: number
  ): void => {
    const event = createEvent[kind](node, { dataTransfer })
    Object.defineProperty(event, 'clientX', { value: clientX })
    fireEvent(node, event)
  }

  it('drags a left tab to the right of a later tab (shift-adjusted final index)', () => {
    const onReorder = vi.fn()
    const { container } = render(
      <WorkspaceTabStrip
        tabs={threeTabs}
        activeTabId="a"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onReorder={onReorder}
      />
    )
    const source = containerFor(container, 'Alpha')
    const target = containerFor(container, 'Charlie')
    const dataTransfer = makeDataTransfer()
    fireEvent.dragStart(source, { dataTransfer })
    fireDrag('dragOver', target, dataTransfer, 90)
    fireDrag('drop', target, dataTransfer, 90)
    // Drop after 'c' (index 2); 'a' sat before it, so the final index is 2.
    expect(onReorder).toHaveBeenCalledWith('a', 2)
  })

  it('drags a right tab to the left of an earlier tab (no shift adjustment)', () => {
    const onReorder = vi.fn()
    const { container } = render(
      <WorkspaceTabStrip
        tabs={threeTabs}
        activeTabId="a"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onReorder={onReorder}
      />
    )
    const source = containerFor(container, 'Charlie')
    const target = containerFor(container, 'Alpha')
    const dataTransfer = makeDataTransfer()
    fireEvent.dragStart(source, { dataTransfer })
    fireDrag('dragOver', target, dataTransfer, 10)
    fireDrag('drop', target, dataTransfer, 10)
    // Drop before 'a' (index 0); 'c' sat after it, so the final index is 0.
    expect(onReorder).toHaveBeenCalledWith('c', 0)
  })

  it('does not reorder when dropped on itself', () => {
    const onReorder = vi.fn()
    const { container } = render(
      <WorkspaceTabStrip
        tabs={threeTabs}
        activeTabId="a"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onReorder={onReorder}
      />
    )
    const self = containerFor(container, 'Bravo')
    const dataTransfer = makeDataTransfer()
    fireEvent.dragStart(self, { dataTransfer })
    fireDrag('drop', self, dataTransfer, 90)
    expect(onReorder).not.toHaveBeenCalled()
  })

  it('moves a tab with Alt+ArrowRight / Alt+ArrowLeft from the focused select', () => {
    const onReorder = vi.fn()
    render(
      <WorkspaceTabStrip
        tabs={threeTabs}
        activeTabId="a"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onReorder={onReorder}
      />
    )
    const bravo = screen.getByRole('button', { name: 'Bravo' })
    fireEvent.keyDown(bravo, { key: 'ArrowRight', altKey: true })
    expect(onReorder).toHaveBeenLastCalledWith('b', 2) // index 1 -> 2
    fireEvent.keyDown(bravo, { key: 'ArrowLeft', altKey: true })
    expect(onReorder).toHaveBeenLastCalledWith('b', 0) // index 1 -> 0
  })

  it('ignores arrow keys without Alt (leaves navigation/select alone)', () => {
    const onReorder = vi.fn()
    render(
      <WorkspaceTabStrip
        tabs={threeTabs}
        activeTabId="a"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onReorder={onReorder}
      />
    )
    const bravo = screen.getByRole('button', { name: 'Bravo' })
    fireEvent.keyDown(bravo, { key: 'ArrowRight' })
    fireEvent.keyDown(bravo, { key: 'ArrowLeft' })
    expect(onReorder).not.toHaveBeenCalled()
  })

  it('keeps focus on the moved tab after a keyboard reorder (list keyed by id)', () => {
    // Drive the real store reducer so the rerender reflects the new order; the
    // moved tab's DOM node persists (keyed by id) and thus keeps DOM focus.
    let state: WorkspaceTabsState = { tabs: threeTabs, activeTabId: 'a' }
    const onReorder = (fromId: string, toIndex: number) => {
      state = reorderWorkspaceTab(state, fromId, toIndex)
    }
    const { rerender } = render(
      <WorkspaceTabStrip
        tabs={state.tabs}
        activeTabId={state.activeTabId}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onReorder={onReorder}
      />
    )
    const bravo = screen.getByRole('button', { name: 'Bravo' })
    bravo.focus()
    expect(document.activeElement).toBe(bravo)
    fireEvent.keyDown(bravo, { key: 'ArrowRight', altKey: true })
    rerender(
      <WorkspaceTabStrip
        tabs={state.tabs}
        activeTabId={state.activeTabId}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onReorder={onReorder}
      />
    )
    expect(state.tabs.map(t => t.id)).toEqual(['a', 'c', 'b'])
    // Same DOM node, now last, still focused.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Bravo' }))
    expect(document.activeElement).toBe(bravo)
  })

  // R3-H2: unlike a reorder (which keeps focus because the keyed node survives), a
  // close removes the focused control, so a keyboard user who closes the ACTIVE tab
  // would drop to <body>. Focus must follow the workspace to the tab that took over.
  it('moves keyboard focus to the surviving active tab when the active tab is closed (R3-H2, T3)', () => {
    // Drive the real store reducer: closing active 'b' (index 1) promotes 'c'.
    let state: WorkspaceTabsState = { tabs: threeTabs, activeTabId: 'b' }
    const onClose = (id: string) => {
      state = closeWorkspaceTab(state, id)
    }
    const { rerender } = render(
      <WorkspaceTabStrip
        tabs={state.tabs}
        activeTabId={state.activeTabId}
        onSelect={vi.fn()}
        onClose={onClose}
        onReorder={vi.fn()}
      />
    )
    const closeActive = screen.getByRole('button', { name: 'Close Bravo' })
    closeActive.focus()
    expect(document.activeElement).toBe(closeActive)
    // Keyboard activation of the close control: Enter/Space fire a click with
    // `detail === 0` (a pointer click reports >= 1).
    fireEvent.click(closeActive, { detail: 0 })
    rerender(
      <WorkspaceTabStrip
        tabs={state.tabs}
        activeTabId={state.activeTabId}
        onSelect={vi.fn()}
        onClose={onClose}
        onReorder={vi.fn()}
      />
    )
    expect(state.tabs.map(t => t.id)).toEqual(['a', 'c'])
    expect(state.activeTabId).toBe('c')
    // Observable result: focus landed on the now-active tab's control, not <body>.
    const nowActive = screen.getByRole('button', { name: 'Charlie' })
    expect(document.activeElement).toBe(nowActive)
  })

  it('keeps keyboard focus in the strip when the last tab is closed (R3-H2)', () => {
    let state: WorkspaceTabsState = { tabs: [threeTabs[0]!], activeTabId: 'a' }
    const onClose = (id: string) => {
      state = closeWorkspaceTab(state, id)
    }
    const { container, rerender } = render(
      <WorkspaceTabStrip
        tabs={state.tabs}
        activeTabId={state.activeTabId}
        onSelect={vi.fn()}
        onClose={onClose}
        onReorder={vi.fn()}
      />
    )
    const closeActive = screen.getByRole('button', { name: 'Close Alpha' })
    closeActive.focus()
    fireEvent.click(closeActive, { detail: 0 })
    rerender(
      <WorkspaceTabStrip
        tabs={state.tabs}
        activeTabId={state.activeTabId}
        onSelect={vi.fn()}
        onClose={onClose}
        onReorder={vi.fn()}
      />
    )
    expect(state.tabs).toHaveLength(0)
    expect(state.activeTabId).toBeNull()
    // No tab survives, so focus stays in the strip rather than dropping to <body>.
    const strip = container.querySelector('.chat-view-tabs') as HTMLElement
    expect(document.activeElement).toBe(strip)
  })
})
