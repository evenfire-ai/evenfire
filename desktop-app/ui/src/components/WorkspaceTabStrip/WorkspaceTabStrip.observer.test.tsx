// @vitest-environment jsdom
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import * as fc from 'fast-check'
import {
  closeWorkspaceTab,
  createEmptyWorkspaceTabsState,
  openAppTab,
  reorderWorkspaceTab,
  selectWorkspaceTab,
} from '@lib/workspaceTabs'
import { WorkspaceTabStrip } from '.'
import { installSyntheticTabStripLayout } from './__fixtures__/tabStripLayout'

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
  deliverQueued(target: Element) {
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

type OracleModel = {
  selectedId: string
  focusedId: string | null
  winnerId: string
  revealId: string | null
  geometryReady: boolean
  manualScrollLeft: number | null
}

type OracleSystem = {
  state: ReturnType<typeof makeTabs>
  onSelect: ReturnType<typeof vi.fn<(id: string) => void>>
  rerender: (element: React.ReactNode) => void
  layout: ReturnType<typeof installSyntheticTabStripLayout>
  deliverObservers: () => void
}

class FocusNextCommand implements fc.Command<OracleModel, OracleSystem> {
  check = () => true
  toString = () => 'focus-next-tab-without-selection'
  run(model: OracleModel, system: OracleSystem) {
    const active = document.activeElement?.matches('[role="tab"]')
      ? (document.activeElement as HTMLElement)
      : null
    const fromId = active?.dataset.workspaceTabId ?? model.focusedId ?? model.selectedId
    const index = system.state.tabs.findIndex(tab => tab.id === fromId)
    const next = system.state.tabs[(index + 1) % system.state.tabs.length]
    if (!next) throw new Error('producer fixture must contain tabs')
    // Reach the next tab through the actual tab key handler, independent of selection.
    const current = screen.getByRole('tab', {
      name: system.state.tabs[index]?.title === '0' ? '0' : system.state.tabs[index]?.title,
    })
    fireEvent.keyDown(current, { key: 'ArrowRight' })
    model.focusedId = next.id
    model.winnerId = next.id
    model.revealId = system.layout ? next.id : null
    model.manualScrollLeft = null
    if (model.geometryReady) model.revealId = null
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: next.title }))
    expect(screen.getByRole('tab', { name: next.title }).getAttribute('aria-selected')).toBe(
      String(model.selectedId === next.id)
    )
    expect(system.onSelect).not.toHaveBeenCalled()
  }
}

class CommitSelectionCommand implements fc.Command<OracleModel, OracleSystem> {
  constructor(private readonly selectedId: string) {}
  check(model: OracleModel) {
    return model.selectedId !== this.selectedId
  }
  toString = () => `commit-selection-${this.selectedId}`
  run(model: OracleModel, system: OracleSystem) {
    model.selectedId = this.selectedId
    model.winnerId = this.selectedId
    model.revealId = this.selectedId
    model.manualScrollLeft = null
    system.rerender(
      <WorkspaceTabStrip
        tabs={system.state.tabs}
        activeTabId={this.selectedId}
        onSelect={system.onSelect}
        onClose={vi.fn()}
        onReorder={vi.fn()}
      />
    )
    if (model.geometryReady) model.revealId = null
    expect(
      screen.getByRole('tab', { name: this.selectedId.slice(-1) }).getAttribute('aria-selected')
    ).toBe('true')
    expect(system.onSelect).not.toHaveBeenCalled()
  }
}

class DeliverMeasurementsCommand implements fc.Command<OracleModel, OracleSystem> {
  check = () => true
  toString = () => 'deliver-current-and-queued-measurements'
  run(model: OracleModel, system: OracleSystem) {
    system.deliverObservers()
    if (model.geometryReady) model.revealId = null
    expect(system.onSelect).not.toHaveBeenCalled()
  }
}

class RestoreGeometryCommand implements fc.Command<OracleModel, OracleSystem> {
  check(model: OracleModel) {
    return !model.geometryReady
  }
  toString = () => 'restore-positive-native-geometry'
  run(model: OracleModel, system: OracleSystem) {
    model.geometryReady = true
    system.layout.setStripWidth(300)
    system.deliverObservers()
    const target = document.querySelector<HTMLElement>(
      `[data-workspace-tab-id="${model.winnerId}"].chat-view-tab`
    )!
    const viewport = document
      .querySelector<HTMLElement>('.chat-view-tabs__scroller')!
      .getBoundingClientRect()
    const bounds = target.getBoundingClientRect()
    expect(bounds.left).toBeGreaterThanOrEqual(viewport.left - 1)
    expect(bounds.right).toBeLessThanOrEqual(viewport.right + 1)
    model.revealId = null
  }
}

class ManualScrollCommand implements fc.Command<OracleModel, OracleSystem> {
  check(model: OracleModel) {
    return model.geometryReady && model.revealId === null
  }
  toString = () => 'manual-scroll-after-current-reveal'
  run(model: OracleModel, system: OracleSystem) {
    const scroller = document.querySelector('.chat-view-tabs__scroller') as HTMLElement
    system.layout.setScrollLeft(21)
    model.manualScrollLeft = 21
    fireEvent.scroll(scroller)
    system.deliverObservers()
    expect(system.layout.scrollLeft()).toBe(model.manualScrollLeft)
    expect(system.onSelect).not.toHaveBeenCalled()
  }
}

beforeEach(() => {
  observers.length = 0
  vi.stubGlobal('ResizeObserver', ElementResizeObserver)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('WorkspaceTabStrip synthetic geometry and observer ownership', () => {
  it('issues one reveal write for one measurable keyboard focus intent', () => {
    const state = selectWorkspaceTab(makeTabs(3), 'observer-0')
    const onSelect = vi.fn()
    const view = render(
      <WorkspaceTabStrip
        tabs={state.tabs}
        activeTabId="observer-0"
        onSelect={onSelect}
        onClose={vi.fn()}
        onReorder={vi.fn()}
      />
    )
    const scroller = view.container.querySelector('.chat-view-tabs__scroller') as HTMLElement
    const layout = installSyntheticTabStripLayout(view.container, [96, 96, 96], 160)
    act(() => layout.resize(160))

    const scrollDescriptor = Object.getOwnPropertyDescriptor(scroller, 'scrollLeft')!
    let scrollWrites = 0
    Object.defineProperty(scroller, 'scrollLeft', {
      configurable: true,
      get: scrollDescriptor.get,
      set: value => {
        scrollWrites += 1
        scrollDescriptor.set?.call(scroller, value)
      },
    })

    fireEvent.keyDown(screen.getByRole('tab', { name: '0' }), { key: 'ArrowRight' })

    expect(document.activeElement).toBe(screen.getByRole('tab', { name: '1' }))
    expect(scrollWrites).toBe(1)
    expect(screen.getByRole('tab', { name: '0' }).getAttribute('aria-selected')).toBe('true')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('matches an independent focus/selection intent model across generated event orders', () => {
    const producerState = selectWorkspaceTab(makeTabs(3), 'observer-0')
    const tabs = producerState.tabs
    const commands = fc.commands(
      [
        fc.constant(new FocusNextCommand()),
        fc.constantFrom('observer-1', 'observer-2').map(id => new CommitSelectionCommand(id)),
        fc.constant(new DeliverMeasurementsCommand()),
        fc.constant(new RestoreGeometryCommand()),
        fc.constant(new ManualScrollCommand()),
      ],
      { maxCommands: 10 }
    )

    fc.assert(
      fc.property(commands, generated => {
        cleanup()
        const observerStart = observers.length
        const onSelect = vi.fn<(id: string) => void>()
        const view = render(
          <WorkspaceTabStrip
            tabs={tabs}
            activeTabId="observer-0"
            onSelect={onSelect}
            onClose={vi.fn()}
            onReorder={vi.fn()}
          />
        )
        const scroller = view.container.querySelector('.chat-view-tabs__scroller') as HTMLElement
        const layout = installSyntheticTabStripLayout(view.container, [128, 128, 128], 0)
        const initialObserver = observers.at(-1)!
        initialObserver.notify(scroller)
        const model: OracleModel = {
          selectedId: 'observer-0',
          focusedId: null,
          winnerId: 'observer-0',
          revealId: 'observer-0',
          geometryReady: false,
          manualScrollLeft: null,
        }
        const system: OracleSystem = {
          state: producerState,
          onSelect,
          rerender: element => view.rerender(element as React.ReactElement),
          layout,
          deliverObservers: () => {
            const current = observers.slice(observerStart)
            for (const observer of current) observer.deliverQueued(scroller)
            observers.at(-1)?.notify(scroller)
          },
        }

        fc.modelRun(() => ({ model, real: system }), generated)

        if (!model.geometryReady) {
          model.geometryReady = true
          layout.setStripWidth(300)
          system.deliverObservers()
          model.revealId = null
        }
        system.deliverObservers()

        expect(
          screen
            .getByRole('tab', { name: model.selectedId.slice(-1) })
            .getAttribute('aria-selected')
        ).toBe('true')
        if (model.focusedId) {
          expect(document.activeElement).toBe(
            screen.getByRole('tab', { name: model.focusedId.slice(-1) })
          )
        }
        if (model.manualScrollLeft === null) {
          const target = view.container.querySelector<HTMLElement>(
            `[data-workspace-tab-id="${model.winnerId}"].chat-view-tab`
          )!
          const viewport = scroller.getBoundingClientRect()
          const bounds = target.getBoundingClientRect()
          expect(bounds.left).toBeGreaterThanOrEqual(viewport.left - 1)
          expect(bounds.right).toBeLessThanOrEqual(viewport.right + 1)
        } else {
          expect(layout.scrollLeft()).toBe(model.manualScrollLeft)
        }
        expect(onSelect).not.toHaveBeenCalled()
        cleanup()
      }),
      { seed: 935146, numRuns: 30 }
    )
  })

  it('keeps focus-only navigation separate and reveals the pending keyboard destination', () => {
    const state = selectWorkspaceTab(makeTabs(3), 'observer-0')
    const onSelect = vi.fn()
    const view = render(
      <WorkspaceTabStrip
        tabs={state.tabs}
        activeTabId="observer-0"
        onSelect={onSelect}
        onClose={vi.fn()}
        onReorder={vi.fn()}
      />
    )
    const scroller = view.container.querySelector('.chat-view-tabs__scroller') as HTMLElement
    const layout = installSyntheticTabStripLayout(view.container, [96, 96, 96], 248)
    observers.at(-1)!.notify(scroller)
    const observer = observers.at(-1)!
    layout.setStripWidth(0)

    const selectedA = screen.getByRole('tab', { name: '0' })
    const focusedB = screen.getByRole('tab', { name: '1' })
    fireEvent.keyDown(selectedA, { key: 'ArrowRight' })

    expect(document.activeElement).toBe(focusedB)
    expect(selectedA.getAttribute('aria-selected')).toBe('true')
    expect(focusedB.getAttribute('aria-selected')).toBe('false')
    expect(onSelect).not.toHaveBeenCalled()

    layout.resize(120)
    observer.notify(scroller)

    const viewport = scroller.getBoundingClientRect()
    const tab = view.container.querySelector<HTMLElement>(
      '[data-workspace-tab-id="observer-1"].chat-view-tab'
    )!
    const bounds = tab.getBoundingClientRect()
    expect(bounds.right).toBeLessThanOrEqual(viewport.right + 1)
    expect(document.activeElement).toBe(focusedB)
    expect(selectedA.getAttribute('aria-selected')).toBe('true')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('keeps the latest B-to-C focus reveal through queued measurements and later manual scroll', () => {
    const state = selectWorkspaceTab(makeTabs(4), 'observer-0')
    const onSelect = vi.fn()
    const view = render(
      <WorkspaceTabStrip
        tabs={state.tabs}
        activeTabId="observer-0"
        onSelect={onSelect}
        onClose={vi.fn()}
        onReorder={vi.fn()}
      />
    )
    const scroller = view.container.querySelector('.chat-view-tabs__scroller') as HTMLElement
    const layout = installSyntheticTabStripLayout(view.container, [96, 96, 96, 96], 0)
    const queuedObserver = observers.at(-1)!
    queuedObserver.notify(scroller)

    fireEvent.keyDown(screen.getByRole('tab', { name: '0' }), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: '1' }))
    fireEvent.keyDown(screen.getByRole('tab', { name: '1' }), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: '2' }))
    expect(screen.getByRole('tab', { name: '0' }).getAttribute('aria-selected')).toBe('true')
    expect(onSelect).not.toHaveBeenCalled()

    layout.setStripWidth(160)
    queuedObserver.deliverQueued(scroller)
    observers.at(-1)!.notify(scroller)
    queuedObserver.deliverQueued(scroller)

    const viewport = scroller.getBoundingClientRect()
    const tabC = view.container.querySelector<HTMLElement>(
      '[data-workspace-tab-id="observer-2"].chat-view-tab'
    )!
    expect(tabC.getBoundingClientRect().left).toBeGreaterThanOrEqual(viewport.left - 1)
    expect(tabC.getBoundingClientRect().right).toBeLessThanOrEqual(viewport.right + 1)
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: '2' }))
    expect(screen.getByRole('tab', { name: '0' }).getAttribute('aria-selected')).toBe('true')
    const revealOffset = layout.scrollLeft()
    queuedObserver.deliverQueued(scroller)
    expect(layout.scrollLeft()).toBe(revealOffset)

    layout.setScrollLeft(17)
    fireEvent.scroll(scroller)
    queuedObserver.deliverQueued(scroller)
    observers.at(-1)!.notify(scroller)
    expect(layout.scrollLeft()).toBe(17)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('consumes a fitting focus request before overflow controls mount', () => {
    const state = selectWorkspaceTab(makeTabs(2), 'observer-0')
    const onSelect = vi.fn()
    const view = render(
      <WorkspaceTabStrip
        tabs={state.tabs}
        activeTabId="observer-0"
        onSelect={onSelect}
        onClose={vi.fn()}
        onReorder={vi.fn()}
      />
    )
    const scroller = view.container.querySelector('.chat-view-tabs__scroller') as HTMLElement
    const layout = installSyntheticTabStripLayout(view.container, [96, 96], 300)
    const observer = observers.at(-1)!
    observer.notify(scroller)

    expect(view.container.querySelectorAll('.chat-view-tabs__scroll-button')).toHaveLength(0)
    fireEvent.keyDown(screen.getByRole('tab', { name: '0' }), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: '1' }))
    expect(layout.scrollLeft()).toBe(0)
    expect(onSelect).not.toHaveBeenCalled()

    layout.resize(100)
    observer.notify(scroller)
    observers.at(-1)!.notify(scroller)

    const viewport = scroller.getBoundingClientRect()
    const focusedBounds = view.container
      .querySelector<HTMLElement>('[data-workspace-tab-id="observer-1"].chat-view-tab')!
      .getBoundingClientRect()
    expect(view.container.querySelectorAll('.chat-view-tabs__scroll-button')).toHaveLength(2)
    expect(focusedBounds.left).toBeGreaterThanOrEqual(viewport.right - 1)
    expect(layout.scrollLeft()).toBe(0)
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: '1' }))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('transfers keyboard focus only when overflow arrows disappear', () => {
    const state = makeTabs(4)
    const selectedId = state.activeTabId!
    const onSelect = vi.fn()
    const view = render(
      <WorkspaceTabStrip
        tabs={state.tabs}
        activeTabId={selectedId}
        onSelect={onSelect}
        onClose={vi.fn()}
        onReorder={vi.fn()}
      />
    )
    const layout = installSyntheticTabStripLayout(view.container, [96, 96, 96, 96], 248)
    layout.measure()
    observers.at(-1)!.notify(view.container.querySelector('.chat-view-tabs__scroller')!)
    const selected = screen.getByRole('tab', { name: selectedId.slice(-1) })
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus')
    const right = screen.getByRole('button', { name: 'Scroll tabs right' })

    fireEvent.keyDown(right, { key: 'Enter' })
    right.focus()
    layout.resize(600)

    expect(screen.queryByRole('button', { name: 'Scroll tabs right' })).toBeNull()
    expect(document.activeElement).toBe(selected)
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true })
    expect(onSelect).not.toHaveBeenCalled()

    layout.resize(248)
    const pointerArrow = screen.getByRole('button', { name: 'Scroll tabs right' })
    fireEvent.pointerDown(pointerArrow)
    pointerArrow.focus()
    layout.resize(600)
    expect(document.activeElement).not.toBe(selected)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('hands off a disappearing keyboard arrow to the roving tab with null selection', () => {
    const state = makeTabs(3)
    const onSelect = vi.fn()
    const view = render(
      <WorkspaceTabStrip
        tabs={state.tabs}
        activeTabId={null}
        onSelect={onSelect}
        onClose={vi.fn()}
        onReorder={vi.fn()}
      />
    )
    const scroller = view.container.querySelector('.chat-view-tabs__scroller') as HTMLElement
    const layout = installSyntheticTabStripLayout(view.container, [96, 96, 96], 248)
    layout.measure()
    observers.at(-1)!.notify(scroller)
    const right = screen.getByRole('button', { name: 'Scroll tabs right' })
    fireEvent.keyDown(right, { key: 'Enter' })
    right.focus()

    layout.resize(600)

    const firstTab = screen.getByRole('tab', { name: '0' })
    expect(screen.queryByRole('button', { name: 'Scroll tabs right' })).toBeNull()
    expect(document.activeElement).toBe(firstTab)
    expect(firstTab.getAttribute('aria-selected')).toBe('false')
    expect(screen.queryAllByRole('tab', { selected: true })).toHaveLength(0)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('lets a later committed selection C supersede a pending focus reveal B', () => {
    const state = selectWorkspaceTab(makeTabs(3), 'observer-0')
    const onSelect = vi.fn()
    const props = { onSelect, onClose: vi.fn(), onReorder: vi.fn() }
    const view = render(<WorkspaceTabStrip tabs={state.tabs} activeTabId="observer-0" {...props} />)
    const scroller = view.container.querySelector('.chat-view-tabs__scroller') as HTMLElement
    const layout = installSyntheticTabStripLayout(view.container, [96, 96, 96], 248)
    observers.at(-1)!.notify(scroller)
    const observer = observers.at(-1)!
    layout.setStripWidth(0)

    const focusedB = screen.getByRole('tab', { name: '1' })
    fireEvent.keyDown(screen.getByRole('tab', { name: '0' }), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(focusedB)
    expect(onSelect).not.toHaveBeenCalled()

    view.rerender(<WorkspaceTabStrip tabs={state.tabs} activeTabId="observer-2" {...props} />)
    layout.setStripWidth(248)
    observer.deliverQueued(scroller)

    const viewport = scroller.getBoundingClientRect()
    const selectedC = view.container.querySelector<HTMLElement>(
      '[data-workspace-tab-id="observer-2"].chat-view-tab'
    )!
    const bounds = selectedC.getBoundingClientRect()
    expect(bounds.left).toBeGreaterThanOrEqual(viewport.left - 1)
    expect(bounds.right).toBeLessThanOrEqual(viewport.right + 1)
    expect(document.activeElement).toBe(focusedB)
    expect(screen.getByRole('tab', { name: '1' }).getAttribute('aria-selected')).toBe('false')
    expect(screen.getByRole('tab', { name: '2' }).getAttribute('aria-selected')).toBe('true')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('observes the scroller/list and responds to assigned widths without window resize', () => {
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
    const layout = installSyntheticTabStripLayout(view.container, [96, 140, 120], 248)
    const observer = observers.at(-1)!
    expect(list.classList.contains('chat-view-tabs__list')).toBe(true)
    expect(list.parentElement).toBe(scroller)
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

  it('refreshes synthetic boundaries after store-produced insertion, reorder and removal', () => {
    let state = makeTabs(2)
    const props = { activeTabId: null, onSelect: vi.fn(), onClose: vi.fn(), onReorder: vi.fn() }
    const view = render(<WorkspaceTabStrip {...props} tabs={state.tabs} />)
    const scroller = view.container.querySelector('.chat-view-tabs__scroller') as HTMLElement
    const layout = installSyntheticTabStripLayout(view.container, [96, 140], 248)
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
      expect(layout.scrollLeft()).toBe(42)
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
      expect(layout.scrollLeft()).toBe(22)
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

  it('keeps one observer registration through StrictMode replay and isolates unmount', () => {
    const state = selectWorkspaceTab(makeTabs(4), 'observer-0')
    const view = render(
      <StrictMode>
        <WorkspaceTabStrip
          tabs={state.tabs}
          activeTabId={state.activeTabId}
          onSelect={vi.fn()}
          onClose={vi.fn()}
          onReorder={vi.fn()}
        />
      </StrictMode>
    )
    const scroller = view.container.querySelector('.chat-view-tabs__scroller') as HTMLElement
    const layout = installSyntheticTabStripLayout(view.container, [96, 96, 96, 96], 248)
    const live = observers.filter(observer => !observer.disconnected)
    expect(live).toHaveLength(1)
    expect([...live[0]!.targets]).toEqual([scroller, scroller.firstElementChild])
    expect(observers.some(observer => observer.disconnected)).toBe(true)

    const beforeUnmount = layout.scrollLeft()
    const queued = [...observers]
    view.unmount()
    expect(observers.every(observer => observer.disconnected && observer.targets.size === 0)).toBe(
      true
    )
    for (const observer of queued) observer.deliverQueued(scroller)
    expect(layout.scrollLeft()).toBe(beforeUnmount)
  })

  it('isolates a queued old-mount observer from a newly mounted strip', () => {
    const oldState = selectWorkspaceTab(makeTabs(3), 'observer-2')
    const oldView = render(
      <WorkspaceTabStrip
        tabs={oldState.tabs}
        activeTabId="observer-2"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onReorder={vi.fn()}
      />
    )
    const oldScroller = oldView.container.querySelector('.chat-view-tabs__scroller') as HTMLElement
    const oldLayout = installSyntheticTabStripLayout(oldView.container, [96, 96, 96], 0)
    const disposedObserver = observers.at(-1)!
    disposedObserver.notify(oldScroller)
    oldView.unmount()
    oldLayout.setScrollLeft(31)
    oldLayout.setStripWidth(160)

    let newState = createEmptyWorkspaceTabsState()
    for (let index = 0; index < 3; index += 1) {
      newState = openAppTab(newState, {
        id: `remount-${index}`,
        appRef: 'example/remount',
        title: `Remount ${index}`,
      })
    }
    newState = selectWorkspaceTab(newState, 'remount-2')
    const onSelect = vi.fn()
    const newView = render(
      <WorkspaceTabStrip
        tabs={newState.tabs}
        activeTabId="remount-2"
        onSelect={onSelect}
        onClose={vi.fn()}
        onReorder={vi.fn()}
      />
    )
    const newScroller = newView.container.querySelector('.chat-view-tabs__scroller') as HTMLElement
    const newLayout = installSyntheticTabStripLayout(newView.container, [96, 96, 96], 160)
    const newObserver = observers.at(-1)!
    newObserver.notify(newScroller)
    const newOffset = newLayout.scrollLeft()

    disposedObserver.deliverQueued(oldScroller)
    expect(oldLayout.scrollLeft()).toBe(31)
    expect(newLayout.scrollLeft()).toBe(newOffset)
    const viewport = newScroller.getBoundingClientRect()
    const selected = newView.container.querySelector<HTMLElement>(
      '[data-workspace-tab-id="remount-2"].chat-view-tab'
    )!
    expect(selected.getBoundingClientRect().left).toBeGreaterThanOrEqual(viewport.left - 1)
    expect(selected.getBoundingClientRect().right).toBeLessThanOrEqual(viewport.right + 1)
    expect(document.activeElement).not.toBe(oldScroller)
    expect(onSelect).not.toHaveBeenCalled()
  })
})

describe('WorkspaceTabStrip committed-membership cancellation', () => {
  it('cancels a committed-absent B reveal before same-ID restore and queued observers', () => {
    let state = createEmptyWorkspaceTabsState()
    state = openAppTab(state, { id: 'A', appRef: 'example/a', title: 'A' })
    state = openAppTab(state, { id: 'B', appRef: 'example/b', title: 'B' })
    state = openAppTab(state, { id: 'C', appRef: 'example/c', title: 'C' })
    state = selectWorkspaceTab(state, 'A')
    const snapshot = state
    const onSelect = vi.fn()
    const props = { onSelect, onClose: vi.fn(), onReorder: vi.fn() }
    const view = render(<WorkspaceTabStrip {...props} tabs={state.tabs} activeTabId="A" />)
    const layout = installSyntheticTabStripLayout(view.container, [96, 96, 96], 160)
    const restoreRects = layout.trackFutureTabRects()
    act(() => layout.resize(160))
    const scroller = view.container.querySelector('.chat-view-tabs__scroller')!
    const oldObserver = observers.at(-1)!

    act(() => layout.resize(0))
    fireEvent.keyDown(screen.getByRole('tab', { name: 'A' }), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'B' }))
    expect(onSelect).not.toHaveBeenCalled()

    state = closeWorkspaceTab(state, 'B')
    view.rerender(<WorkspaceTabStrip {...props} tabs={state.tabs} activeTabId="A" />)
    expect(state.tabs.map(tab => tab.id)).toEqual(['A', 'C'])
    expect(oldObserver.disconnected).toBe(true)

    layout.setWidths([96, 96, 96])
    act(() => layout.resize(160))
    layout.setScrollLeft(20)
    fireEvent.scroll(scroller)
    oldObserver.deliverQueued(scroller)
    observers.at(-1)!.deliverQueued(scroller)
    expect(layout.scrollLeft()).toBe(20)

    state = snapshot
    view.rerender(<WorkspaceTabStrip {...props} tabs={state.tabs} activeTabId="A" />)
    expect(state.tabs.map(tab => tab.id)).toEqual(['A', 'B', 'C'])
    oldObserver.deliverQueued(scroller)
    observers.at(-1)!.deliverQueued(scroller)

    expect(layout.scrollLeft()).toBe(20)
    expect(screen.getByRole('tab', { name: 'A' }).getAttribute('aria-selected')).toBe('true')
    expect(onSelect).not.toHaveBeenCalled()
    restoreRects()
  })

  it('preserves pending B when an absent ID never commits in the same batch', () => {
    let state = createEmptyWorkspaceTabsState()
    state = openAppTab(state, { id: 'A', appRef: 'example/a', title: 'A' })
    state = openAppTab(state, { id: 'B', appRef: 'example/b', title: 'B' })
    state = openAppTab(state, { id: 'C', appRef: 'example/c', title: 'C' })
    state = selectWorkspaceTab(state, 'A')
    const snapshot = state
    const onSelect = vi.fn()
    const props = { onSelect, onClose: vi.fn(), onReorder: vi.fn() }
    const view = render(<WorkspaceTabStrip {...props} tabs={state.tabs} activeTabId="A" />)
    const layout = installSyntheticTabStripLayout(view.container, [96, 96, 96], 160)
    act(() => layout.resize(0))
    fireEvent.keyDown(screen.getByRole('tab', { name: 'A' }), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'B' }))

    act(() => {
      state = closeWorkspaceTab(state, 'B')
      state = snapshot
      view.rerender(<WorkspaceTabStrip {...props} tabs={state.tabs} activeTabId="A" />)
    })
    expect(state.tabs.map(tab => tab.id)).toEqual(['A', 'B', 'C'])

    layout.setWidths([96, 96, 96])
    act(() => layout.resize(160))
    observers.at(-1)!.deliverQueued(view.container.querySelector('.chat-view-tabs__scroller')!)
    const scroller = view.container.querySelector('.chat-view-tabs__scroller') as HTMLElement
    const target = view.container.querySelector<HTMLElement>(
      '[data-workspace-tab-id="B"].chat-view-tab'
    )!
    const viewport = scroller.getBoundingClientRect()
    const bounds = target.getBoundingClientRect()
    expect(bounds.left).toBeGreaterThanOrEqual(viewport.left - 1)
    expect(bounds.right).toBeLessThanOrEqual(viewport.right + 1)
    expect(screen.getByRole('tab', { name: 'A' }).getAttribute('aria-selected')).toBe('true')
    expect(onSelect).not.toHaveBeenCalled()
  })
})
