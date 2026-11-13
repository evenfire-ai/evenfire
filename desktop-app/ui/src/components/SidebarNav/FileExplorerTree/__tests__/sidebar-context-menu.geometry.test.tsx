// Planning-only A3-05 probe. Runs the real FileExplorerTree/GfsResourceMenu
// composition and captures the observer callback registered by the component.
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FileExplorerTree } from '@components/SidebarNav/FileExplorerTree'
import {
  accessibleResource,
  listAccessiblePage,
  resourceAffordances,
} from '@/gfs/__fixtures__/gfsProducerFixtures'

const auth = vi.hoisted(() => ({
  isAuthenticated: true,
  me: { id: 'u', teamId: 't' },
  runtimeConfigState: { envKey: 'test' },
  sessionGeneration: 7,
}))
vi.mock('@contexts/AuthContext', () => ({ useAuthContext: () => auth }))

type ObserverEntry = { target: Element; contentRect: DOMRectReadOnly }
type CapturedObserver = {
  callback: ResizeObserverCallback
  targets: Element[]
  deliveries: Element[]
  observe: (target: Element) => void
  disconnect: () => void
  unobserve: (target: Element) => void
  deliver: (target: Element) => void
}

const observers: CapturedObserver[] = []
class CapturingResizeObserver {
  callback: ResizeObserverCallback
  targets: Element[] = []
  deliveries: Element[] = []
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    observers.push(this)
  }
  observe = (target: Element) => {
    this.targets.push(target)
  }
  disconnect = () => {}
  unobserve = (target: Element) => {
    this.targets = this.targets.filter(item => item !== target)
  }
  deliver = (target: Element) => {
    this.deliveries.push(target)
    const rect = target.getBoundingClientRect()
    const contentRect = { ...rect, toJSON: () => ({}) } as DOMRectReadOnly
    this.callback(
      [{ target, contentRect } as ResizeObserverEntry],
      this as unknown as ResizeObserver
    )
  }
}

function rect(left: number, top: number, right: number, bottom: number) {
  return {
    x: left,
    y: top,
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    toJSON: () => ({ left, top, right, bottom, width: right - left, height: bottom - top }),
  } as DOMRect
}
function snapshot(value: DOMRect) {
  return {
    left: value.left,
    top: value.top,
    right: value.right,
    bottom: value.bottom,
    width: value.width,
    height: value.height,
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  observers.length = 0
})

describe('A3-05 actual sidebar resize observer ordering', () => {
  it('repositions the mounted context menu after sidebar expansion and contraction', async () => {
    vi.stubGlobal('ResizeObserver', CapturingResizeObserver)
    let sidebarBox = rect(20, 0, 520, 700)
    let rowBox = rect(40, 100, 500, 128)
    const panelBox = rect(0, 0, 232, 180)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      if (this.classList.contains('left-nav')) return sidebarBox
      if (this.classList.contains('da-file-explorer__label')) return rowBox
      if (this.classList.contains('da-gfs-resource-menu__panel')) {
        const left = Number.parseFloat(this.style.left) || 0
        const top = Number.parseFloat(this.style.top) || 0
        const width = Number.parseFloat(this.style.width) || panelBox.width
        const maxHeight = Number.parseFloat(this.style.maxHeight) || panelBox.height
        const height = Math.min(panelBox.height, maxHeight)
        return rect(left, top, left + width, top + height)
      }
      return rect(0, 0, 100, 24)
    })

    const id = '00000000000000000000000000000001'
    const resource = accessibleResource(id, 'A', 'file')
    const affordances = vi.fn(async () => resourceAffordances(['read', 'manage_acl', 'write']))
    const download = vi.fn()
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        auth: { getSessionGeneration: vi.fn(async () => auth.sessionGeneration) },
        gfs: {
          listAccessible: vi.fn(async () => listAccessiblePage([resource])),
          listChildren: vi.fn(async () => ({ items: [], nextCursor: null })),
          affordances,
          download,
        },
      },
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const onResourceAction = vi.fn()
    const pushToast = vi.fn()
    const rendered = render(
      <QueryClientProvider client={queryClient}>
        <aside className="left-nav">
          <FileExplorerTree
            onOpenFolder={vi.fn()}
            onOpenPreview={vi.fn()}
            onResourceAction={onResourceAction}
            pushToast={pushToast}
          />
        </aside>
      </QueryClientProvider>
    )

    const label = await screen.findByRole('button', { name: 'A' })
    const row = label.closest('[role="treeitem"]')!.querySelector('.da-file-explorer__row')!
    fireEvent.contextMenu(row, { clientX: 180, clientY: 115 })
    const panel = await screen.findByRole('menu', { name: 'Actions for A' })
    await waitFor(() => expect(observers.length).toBeGreaterThan(0))
    await waitFor(() => expect(queryClient.isFetching()).toBe(0))
    const sidebar = document.querySelector<HTMLElement>('.left-nav')!
    const observer = observers.find(item => item.targets.includes(sidebar))
    expect(observer, 'the component must register its actual sidebar ResizeObserver').toBeTruthy()
    const registeredSidebar = observer!.targets.find(target => target === sidebar)!
    const initial = {
      sidebar: snapshot(sidebarBox),
      popup: snapshot((panel as HTMLElement).getBoundingClientRect()),
      observerTargetRegistered: observer!.targets.includes(registeredSidebar),
    }

    sidebarBox = rect(20, 0, 620, 700)
    rowBox = rect(40, 100, 600, 128)
    await act(async () => {
      observer!.deliver(registeredSidebar)
    })
    const expanded = {
      sidebar: snapshot(sidebarBox),
      popup: snapshot((panel as HTMLElement).getBoundingClientRect()),
      deliveries: observer!.deliveries.length,
    }

    sidebarBox = rect(20, 0, 220, 700)
    rowBox = rect(40, 100, 200, 128)
    await act(async () => {
      observer!.deliver(registeredSidebar)
    })
    const contracted = {
      sidebar: snapshot(sidebarBox),
      popup: snapshot((panel as HTMLElement).getBoundingClientRect()),
      deliveries: observer!.deliveries.length,
    }

    fireEvent.scroll(window)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    const afterScroll = {
      sidebar: snapshot(sidebarBox),
      popup: snapshot((panel as HTMLElement).getBoundingClientRect()),
      visibleMenuCount: screen.getAllByRole('menu').length,
      queryFetches: queryClient.isFetching(),
      queryMutations: queryClient.isMutating(),
      actionEffects: onResourceAction.mock.calls.length,
      downloads: download.mock.calls.length,
    }
    const evidence = {
      initial,
      expanded,
      contracted,
      afterScroll,
      registeredObserverTargets: observer!.targets.map(
        target => (target as HTMLElement).className || target.tagName
      ),
    }
    process.stderr.write(`A3-05_MEASUREMENTS ${JSON.stringify(evidence)}\n`)

    expect(observer!.deliveries).toEqual([registeredSidebar, registeredSidebar])
    expect.soft(initial.popup.left).toBe(initial.sidebar.left + 8)
    expect.soft(expanded.popup.left).toBe(expanded.sidebar.left + 8)
    expect.soft(expanded.popup.right).toBeLessThanOrEqual(expanded.sidebar.right - 8)
    expect.soft(contracted.popup.left).toBeGreaterThanOrEqual(contracted.sidebar.left + 8)
    expect.soft(contracted.popup.width).toBeLessThanOrEqual(contracted.sidebar.width - 16)
    expect.soft(contracted.popup.right).toBeLessThanOrEqual(contracted.sidebar.right - 8)
    expect.soft(afterScroll.popup.right).toBeLessThanOrEqual(afterScroll.sidebar.right - 8)
    expect(afterScroll.visibleMenuCount).toBe(1)
    expect(afterScroll.queryFetches).toBe(0)
    expect(afterScroll.queryMutations).toBe(0)
    expect(afterScroll.actionEffects).toBe(0)
    expect(afterScroll.downloads).toBe(0)
    queryClient.clear()
    rendered.unmount()
  })
})
