// Temporary planning harness: real FileExplorerTree + GfsResourceMenu composition.
// Only window.clerum (the external IPC boundary) and browser geometry are controlled.
// @vitest-environment jsdom
import { StrictMode, createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import * as fc from 'fast-check'
import {
  accessibleResource,
  listAccessiblePage,
  resourceAffordances,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { FileExplorerTree } from '..'
import { SidebarNav, shouldDeferCompactSidebarEscape } from '../../index'
import { assertA4, initial, transition } from '../sidebar-context-menu-a4-reference'

const auth = vi.hoisted(() => ({
  isAuthenticated: true,
  me: { id: 'u', teamId: 't' },
  busy: false,
  handleLogout: vi.fn(),
  runtimeConfigState: { envKey: 'test' },
  sessionGeneration: 7,
}))
const menuCapture = vi.hoisted(() => ({
  actionsByResource: new Map<string, unknown[]>(),
  contextStateByResource: new Map<string, unknown>(),
  states: [] as Array<[number, boolean, boolean]>,
  onMenuState: null as null | ((requestId: number, open: boolean, shareOpen: boolean) => void),
}))
vi.mock('@contexts/AuthContext', () => ({ useAuthContext: () => auth }))
vi.mock('@contexts/ChatListContext', () => ({
  useChatListContext: () => ({
    activeChatId: null,
    latestChatSessions: [],
    latestChatSessionsLoading: false,
    sessionStateByChatKey: {},
  }),
}))
vi.mock('@contexts/AgentChatActionsContext', () => ({
  useAgentChatActionsContext: () => ({
    captureChatDeleteFence: vi.fn(async () => {
      throw new Error('no delete target')
    }),
    handleRenameChatForAgent: vi.fn(),
    handleDeleteChatForAgent: vi.fn(),
  }),
}))
vi.mock('@contexts/NavigationContext', () => ({
  useNavigationContext: () => ({ selectedAgent: null, handleSelectChatAgent: vi.fn() }),
}))
vi.mock('@components/GfsResourceMenu', async importOriginal => {
  const actual = await importOriginal<typeof import('@components/GfsResourceMenu')>()
  return {
    ...actual,
    GfsResourceMenu: (props: Parameters<typeof actual.GfsResourceMenu>[0]) => {
      menuCapture.actionsByResource.set(props.resourceName, props.actions ?? [])
      menuCapture.contextStateByResource.set(props.resourceName, {
        presentation: props.presentation,
        contextVisible: props.contextVisible,
        ownerCurrent: props.isContextOwnerCurrent?.('open'),
      })
      return createElement(actual.GfsResourceMenu, {
        ...props,
        onSidebarMenuStateChange: (requestId, open, shareOpen) => {
          menuCapture.states.push([requestId, open, shareOpen])
          props.onSidebarMenuStateChange?.(requestId, open, shareOpen)
          menuCapture.onMenuState?.(requestId, open, shareOpen)
        },
      })
    },
  }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
  menuCapture.actionsByResource.clear()
  menuCapture.contextStateByResource.clear()
  menuCapture.states = []
  menuCapture.onMenuState = null
  auth.sessionGeneration = 7
})

type Pending = {
  resolve: (value: Awaited<ReturnType<typeof resourceAffordances>>) => void
  reject: (error: Error) => void
}

function mountedTree(
  controlled = false,
  strict = false,
  onContextMenuEscapeStateChange?: Parameters<
    typeof FileExplorerTree
  >[0]['onContextMenuEscapeStateChange'],
  compactSidebar = false,
  onCompactMenuOpenChange = vi.fn()
) {
  const idA = '00000000000000000000000000000001'
  const idB = '00000000000000000000000000000002'
  const resources = [accessibleResource(idA, 'A', 'file'), accessibleResource(idB, 'B', 'file')]
  const pending = new Map<string, Pending>()
  const affordances = vi.fn((resourceId: string) => {
    if (!controlled) return Promise.resolve(resourceAffordances(['read', 'manage_acl', 'write']))
    return new Promise<Awaited<ReturnType<typeof resourceAffordances>>>((resolve, reject) => {
      pending.set(resourceId, { resolve, reject })
    })
  })
  const download = vi.fn()
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      auth: { getSessionGeneration: vi.fn(async () => auth.sessionGeneration) },
      gfs: {
        listAccessible: vi.fn(async () => listAccessiblePage(resources)),
        listChildren: vi.fn(async () => ({ items: [], nextCursor: null })),
        affordances,
        download,
      },
    },
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onResourceAction = vi.fn()
  const pushToast = vi.fn()
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    if (this.classList.contains('left-nav'))
      return {
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 240,
        bottom: 600,
        width: 240,
        height: 600,
        toJSON: () => ({}),
      } as DOMRect
    if (this.classList.contains('da-file-explorer__label'))
      return {
        x: 24,
        y: 80,
        left: 24,
        top: 80,
        right: 220,
        bottom: 108,
        width: 196,
        height: 28,
        toJSON: () => ({}),
      } as DOMRect
    if (this.classList.contains('da-gfs-resource-menu__panel')) {
      const left = Number.parseFloat(this.style.left) || 0
      const top = Number.parseFloat(this.style.top) || 0
      const width = Number.parseFloat(this.style.width) || 232
      const height = Math.min(240, Number.parseFloat(this.style.maxHeight) || 552)
      return {
        x: left,
        y: top,
        left,
        top,
        right: left + width,
        bottom: top + height,
        width,
        height,
        toJSON: () => ({}),
      } as DOMRect
    }
    if (this.classList.contains('da-gfs-resource-menu__submenu')) {
      const left = Number.parseFloat(this.style.left) || 0
      const top = Number.parseFloat(this.style.top) || 0
      const width = Number.parseFloat(this.style.width) || 232
      const height = Math.min(144, Number.parseFloat(this.style.maxHeight) || 552)
      return {
        x: left,
        y: top,
        left,
        top,
        right: left + width,
        bottom: top + height,
        width,
        height,
        toJSON: () => ({}),
      } as DOMRect
    }
    if (this.classList.contains('ui-menu-item__icon')) {
      return {
        x: 16,
        y: 120,
        left: 16,
        top: 120,
        right: 36,
        bottom: 140,
        width: 20,
        height: 20,
        toJSON: () => ({}),
      } as DOMRect
    }
    return {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 100,
      bottom: 24,
      width: 100,
      height: 24,
      toJSON: () => ({}),
    } as DOMRect
  })
  const tree = () => {
    if (compactSidebar) {
      const content = (
        <QueryClientProvider client={queryClient}>
          <SidebarNav
            navItem="chat"
            collapsed={false}
            compactMode
            compactMenuOpen
            onCompactMenuOpenChange={onCompactMenuOpenChange}
            activeSandboxUiApp={null}
            availableSandboxUiApps={[]}
            onCollapsedChange={vi.fn()}
            onNewChat={vi.fn()}
            onOpenSandboxUiApp={vi.fn()}
            onSelect={vi.fn()}
            onOpenFilesSection={vi.fn()}
            onOpenPreviewSection={vi.fn()}
            onGfsResourceAction={onResourceAction}
            pushToast={pushToast}
          />
        </QueryClientProvider>
      )
      return strict ? <StrictMode>{content}</StrictMode> : content
    }
    const content = (
      <QueryClientProvider client={queryClient}>
        <div className="left-nav">
          <FileExplorerTree
            onOpenFolder={vi.fn()}
            onOpenPreview={vi.fn()}
            onResourceAction={onResourceAction}
            pushToast={pushToast}
            onContextMenuEscapeStateChange={onContextMenuEscapeStateChange}
          />
        </div>
      </QueryClientProvider>
    )
    return strict ? <StrictMode>{content}</StrictMode> : content
  }
  const rendered = render(tree())
  return {
    idA,
    idB,
    queryClient,
    onResourceAction,
    pushToast,
    affordances,
    pending,
    download,
    ...rendered,
    rerenderTree: () => rendered.rerender(tree()),
  }
}

async function openMouse(name: string) {
  const button = await screen.findByRole('button', { name })
  const row = button.closest('[role="treeitem"]')!
  fireEvent.contextMenu(row.querySelector('.da-file-explorer__row')!, {
    clientX: 170,
    clientY: 120,
  })
  await waitFor(() => {
    expect(
      screen.queryByRole('menu', { name: `Actions for ${name}` }) ||
        screen.queryByRole('menu', { name: `Share options for ${name}` })
    ).toBeTruthy()
  })
  return button
}

async function openKeyboard(name: string) {
  const button = await screen.findByRole('button', { name })
  fireEvent.keyDown(button, { key: 'ContextMenu' })
  await waitFor(() => {
    expect(
      screen.queryByRole('menu', { name: `Actions for ${name}` }) ||
        screen.queryByRole('menu', { name: `Share options for ${name}` })
    ).toBeTruthy()
  })
  return button
}

async function resolvePermission(
  f: ReturnType<typeof mountedTree>,
  id: string,
  bits = ['read', 'manage_acl', 'write']
) {
  await waitFor(() => expect(f.pending.has(id)).toBe(true))
  await act(async () => {
    f.pending.get(id)!.resolve(await resourceAffordances(bits))
    f.pending.delete(id)
  })
  await waitFor(() => expect(f.queryClient.isFetching()).toBe(0))
}

function observe(f: ReturnType<typeof mountedTree>, resource?: string) {
  const panels = screen.queryAllByRole('menu') as HTMLElement[]
  const main = panels.find(panel => panel.getAttribute('aria-label') === `Actions for ${resource}`)
  const share = panels.find(
    panel => panel.getAttribute('aria-label') === `Share options for ${resource}`
  )
  const panel = share ?? main
  const items = panel ? (within(panel).queryAllByRole('menuitem') as HTMLElement[]) : []
  const style = panel ? (panel as HTMLElement).style : null
  return {
    resource: main || share ? (resource ?? null) : null,
    open: panels.length > 0,
    view: share ? 'share' : main ? 'main' : 'closed',
    visiblePanelCount: panels.length,
    panelIdentity: panel ? panels.indexOf(panel) : null,
    rect: style
      ? {
          left: style.left,
          top: style.top,
          width: style.width,
          maxHeight: style.maxHeight,
          overflowY: style.overflowY,
        }
      : null,
    focus: document.activeElement?.textContent?.trim() ?? null,
    activeActions: items.map(item => ({
      name: item.textContent?.trim() ?? '',
      disabled: (item as HTMLButtonElement).disabled,
    })),
    permissionRequests: f.pending.size,
    queryFetches: f.queryClient.isFetching(),
    queryMutations: f.queryClient.isMutating(),
    actionEffects: f.onResourceAction.mock.calls.map(call => ({
      target: call[0]?.name,
      action: call[1],
    })),
    downloads: f.download.mock.calls.length,
    feedback: f.pushToast.mock.calls.length,
  }
}

async function settle(f: ReturnType<typeof mountedTree>) {
  await waitFor(() => {
    expect(f.pending.size).toBe(0)
    expect(f.queryClient.isFetching()).toBe(0)
    expect(f.queryClient.isMutating()).toBe(0)
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  expect(f.pending.size).toBe(0)
  expect(f.queryClient.isFetching()).toBe(0)
  expect(f.queryClient.isMutating()).toBe(0)
}

describe('r14 mounted-component independent A4 comparisons', () => {
  it('compares generated real producer histories against the independent A4 model', async () => {
    type Model = ReturnType<typeof initial>
    type Real = ReturnType<typeof mountedTree> & { trace: string[] }
    const traces: string[][] = []
    const mismatches: unknown[] = []
    const reached = new Set<string>()
    const stats = { checked: 0, rejected: 0 }
    const admit = (ok: boolean) => {
      stats.checked += 1
      if (!ok) stats.rejected += 1
      return ok
    }
    class OpenA implements fc.Command<Model, Real> {
      check() {
        return admit(true)
      }
      async run(model: Model, real: Real) {
        real.trace.push('contextmenu:A')
        await openMouse('A')
        await settle(real)
        Object.assign(
          model,
          transition(model, { type: 'open', resource: 'A', request: model.request + 1 })
        )
      }
      toString() {
        return 'OpenA(mouse-contextmenu)'
      }
    }
    class SelectShare implements fc.Command<Model, Real> {
      check(model: Model) {
        return admit(model.menu === 'open' && model.view === 'main')
      }
      async run(model: Model, real: Real) {
        real.trace.push('click:Share')
        const menu = screen.getByRole('menu', { name: `Actions for ${model.resource}` })
        fireEvent.click(within(menu).getByRole('menuitem', { name: 'Share' }), { detail: 1 })
        await screen.findByRole('menu', { name: `Share options for ${model.resource}` })
        Object.assign(model, transition(model, { type: 'share', resource: model.resource! }))
      }
      toString() {
        return 'SelectShare(click)'
      }
    }
    class ReturnFromShare implements fc.Command<Model, Real> {
      check(model: Model) {
        return admit(model.menu === 'open' && model.view === 'share')
      }
      async run(model: Model, real: Real) {
        real.trace.push('ArrowLeft:Share')
        const child = within(
          screen.getByRole('menu', { name: `Share options for ${model.resource}` })
        ).getByRole('menuitem', { name: 'Copy link' })
        fireEvent.keyDown(child, { key: 'ArrowLeft' })
        await waitFor(() =>
          expect(
            screen.queryByRole('menu', { name: `Share options for ${model.resource}` })
          ).toBeNull()
        )
        Object.assign(model, transition(model, { type: 'back' }))
      }
      toString() {
        return 'ReturnFromShare(ArrowLeft)'
      }
    }
    class OpenB implements fc.Command<Model, Real> {
      check(model: Model) {
        return admit(model.menu === 'open' && model.resource !== 'B')
      }
      async run(model: Model, real: Real) {
        real.trace.push('ContextMenu:B')
        await openKeyboard('B')
        await settle(real)
        Object.assign(
          model,
          transition(model, { type: 'open', resource: 'B', request: model.request + 1 })
        )
      }
      toString() {
        return 'OpenB(keyboard-ContextMenu)'
      }
    }
    class Escape implements fc.Command<Model, Real> {
      check(model: Model) {
        return admit(model.menu === 'open')
      }
      async run(model: Model, real: Real) {
        real.trace.push(`Escape:${model.view}`)
        fireEvent.keyDown(window, { key: 'Escape' })
        await act(async () => {
          await Promise.resolve()
          await Promise.resolve()
        })
        Object.assign(model, transition(model, { type: 'escape', restoreConnected: true }))
      }
      toString() {
        return 'Escape(active-menu)'
      }
    }
    class Dismiss implements fc.Command<Model, Real> {
      check(model: Model) {
        return admit(model.menu === 'open')
      }
      async run(model: Model, real: Real) {
        real.trace.push('outside-mousedown')
        fireEvent.mouseDown(document.body)
        await waitFor(() => expect(screen.queryAllByRole('menu')).toHaveLength(0))
        Object.assign(model, transition(model, { type: 'dismiss', restoreConnected: true }))
      }
      toString() {
        return 'Dismiss(outside-mousedown)'
      }
    }
    const commandArbs = [
      fc.constant(new OpenA()),
      fc.constant(new SelectShare()),
      fc.constant(new ReturnFromShare()),
      fc.constant(new OpenB()),
      fc.constant(new Escape()),
      fc.constant(new Dismiss()),
    ]
    await fc.assert(
      fc.asyncProperty(fc.commands(commandArbs, { maxCommands: 4 }), async generated => {
        const f = mountedTree()
        const model = initial()
        const real = { ...f, trace: [] as string[] }
        const commands = [new OpenA(), new SelectShare(), ...Array.from(generated)]
        try {
          await fc.asyncModelRun(() => ({ model, real }), commands)
          await settle(f)
          const actual = observe(f, model.resource ?? undefined)
          const panelRects = actual.open
            ? (screen.queryAllByRole('menu') as HTMLElement[]).map(panel => {
                const rect = panel.getBoundingClientRect()
                return {
                  left: rect.left,
                  top: rect.top,
                  right: rect.right,
                  bottom: rect.bottom,
                }
              })
            : []
          const sidebarRect = document.querySelector('.left-nav')!.getBoundingClientRect()
          Object.assign(
            model,
            transition(model, {
              type: 'geometry',
              id: model.request,
              sidebar: {
                left: sidebarRect.left,
                top: sidebarRect.top,
                right: sidebarRect.right,
                bottom: sidebarRect.bottom,
              },
              rect: panelRects[0] ?? null,
              rects: panelRects,
            })
          )
          Object.assign(model, transition(model, { type: 'settled' }))
          assertA4(model)
          const expected = {
            resource: model.menu === 'open' ? model.resource : null,
            open: model.menu === 'open',
            view: model.menu === 'open' ? model.view : 'closed',
            visiblePanelCount: model.panels.length,
            actionEffects: [],
            downloads: 0,
          }
          const observed = {
            resource: actual.resource,
            open: actual.open,
            view: actual.view,
            visiblePanelCount: actual.visiblePanelCount,
            actionEffects: actual.actionEffects,
            downloads: actual.downloads,
          }
          traces.push(real.trace)
          real.trace.forEach(event => reached.add(event.split(':')[0] ?? 'unknown'))
          if (JSON.stringify(observed) !== JSON.stringify(expected))
            mismatches.push({ trace: real.trace, observed, expected })
          expect(commands.length).toBeGreaterThanOrEqual(2)
        } finally {
          cleanup()
          f.queryClient.clear()
        }
      }),
      { numRuns: 12, seed: 20261114, endOnFailure: true }
    )
    const report = {
      seed: 20261114,
      runs: traces.length,
      traces,
      reached: [...reached],
      preconditions: stats,
      mismatches,
    }
    expect(traces).toHaveLength(12)
    expect(reached.size).toBeGreaterThanOrEqual(3)
    expect(mismatches).toEqual([])
  })

  it('uses fc.scheduler with two producer-created pending permission requests', async () => {
    const runs: Array<{
      order: string[]
      pendingBeforeRelease: number
      observedPanels: number
      expectedPanels: number
    }> = []
    await fc.assert(
      fc.asyncProperty(fc.scheduler(), async scheduler => {
        const f = mountedTree(true)
        try {
          await openMouse('A')
          await waitFor(() => expect(f.pending.has(f.idA)).toBe(true))
          await openKeyboard('B')
          await waitFor(() => expect(f.pending.has(f.idB)).toBe(true))
          const pendingBeforeRelease = f.pending.size
          const a = f.pending.get(f.idA)!
          const b = f.pending.get(f.idB)!
          const scheduledA = scheduler
            .schedule(
              Promise.resolve(resourceAffordances(['read', 'manage_acl', 'write'])),
              'A permission'
            )
            .then(a.resolve)
          const scheduledB = scheduler
            .schedule(
              Promise.resolve(resourceAffordances(['read', 'manage_acl', 'write'])),
              'B permission'
            )
            .then(b.resolve)
          expect(scheduler.count()).toBe(2)
          await scheduler.waitIdle()
          await Promise.all([scheduledA, scheduledB])
          f.pending.clear()
          await settle(f)
          const panels = screen.getAllByRole('menu')
          const observed = {
            order: scheduler.report().map(entry => entry.label),
            pendingBeforeRelease,
            observedPanels: panels.length,
            expectedPanels: 1,
            currentB: screen.queryByRole('menu', { name: 'Actions for B' }) !== null,
          }
          runs.push(observed)
          expect(observed.pendingBeforeRelease).toBe(2)
          expect(observed.currentB).toBe(true)
        } finally {
          cleanup()
          f.queryClient.clear()
        }
      }),
      { numRuns: 8, seed: 20261115, endOnFailure: true }
    )
    expect(runs).toHaveLength(8)
    expect(runs.every(run => run.pendingBeforeRelease === 2)).toBe(true)
    expect(runs.every(run => run.observedPanels === run.expectedPanels)).toBe(true)
    expect(new Set(runs.map(run => run.order.join(' → '))).size).toBeGreaterThan(1)
  })

  it('keeps one request and one action under React StrictMode effect replay', async () => {
    const f = mountedTree(false, true)
    await openMouse('A')
    const menu = screen.getByRole('menu', { name: 'Actions for A' })
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Download' }))
    await settle(f)
    const observed = {
      affordanceInvocations: f.affordances.mock.calls.filter(call => call[0] === f.idA).length,
      actionCalls: f.onResourceAction.mock.calls.filter(
        call => call[0]?.name === 'A' && call[1] === 'download'
      ).length,
      downloads: f.download.mock.calls.length,
    }
    expect(observed.actionCalls).toBe(1)
    expect(observed.downloads).toBe(0)
    f.queryClient.clear()
  })

  it('compares Main plus overlapping Share against the independent overlay model', async () => {
    const f = mountedTree()
    await openMouse('A')
    await settle(f)
    const model = transition(initial(), { type: 'open', resource: 'A', request: 1 })
    const before = observe(f, 'A')
    expect(before).toMatchObject({
      resource: model.resource,
      open: true,
      view: 'main',
      visiblePanelCount: 1,
    })
    const main = screen.getByRole('menu', { name: 'Actions for A' })
    const identity = main
    fireEvent.click(within(main).getByRole('menuitem', { name: 'Share' }), { detail: 1 })
    await screen.findByRole('menu', { name: 'Share options for A' })
    const shareModel = transition(model, { type: 'share', resource: 'A', modality: 'touch' })
    const after = observe(f, 'A')
    const modelPanelCount = shareModel.panels.length
    const mainStayedMounted = screen.queryByRole('menu', { name: 'Actions for A' }) === identity
    await settle(f)
    expect({
      view: after.view,
      panelCount: after.visiblePanelCount,
      sameMain: mainStayedMounted,
    }).toEqual({ view: shareModel.view, panelCount: modelPanelCount, sameMain: true })
    f.queryClient.clear()
  })

  it('opens a separate overlapping Share flyout on sidebar hover', async () => {
    const f = mountedTree()
    await openMouse('A')
    await settle(f)
    const main = screen.getByRole('menu', { name: 'Actions for A' })
    const share = within(main).getByRole('menuitem', { name: 'Share' })
    expect(menuCapture.contextStateByResource.get('A')).toEqual({
      presentation: 'sidebar-context',
      contextVisible: true,
      ownerCurrent: true,
    })
    const activeElement = document.activeElement

    fireEvent.mouseOver(share)

    expect(share.getAttribute('aria-expanded')).toBe('true')
    const flyout = document.querySelector<HTMLElement>(
      '.da-gfs-resource-menu__submenu--sidebar-context'
    )
    expect(flyout).not.toBeNull()
    expect(flyout?.style.visibility).not.toBe('hidden')
    expect(screen.getByRole('menu', { name: 'Actions for A' })).toBe(main)
    expect(screen.getAllByRole('menu')).toHaveLength(2)
    expect(flyout).not.toBe(main)
    expect(document.activeElement).toBe(activeElement)

    const mainRect = main.getBoundingClientRect()
    const flyoutRect = flyout.getBoundingClientRect()
    const iconRect = share.querySelector('.ui-menu-item__icon')!.getBoundingClientRect()
    const sidebarRect = document.querySelector('.left-nav')!.getBoundingClientRect()
    expect(flyoutRect.left - mainRect.left).toBeGreaterThanOrEqual(44)
    expect(flyoutRect.left - mainRect.left).toBeLessThanOrEqual(56)
    expect(flyoutRect.left).toBeLessThan(mainRect.right)
    expect(iconRect.right).toBeLessThan(flyoutRect.left)
    expect(flyoutRect.right).toBeLessThanOrEqual(sidebarRect.right)
    expect(flyoutRect.top).toBeGreaterThanOrEqual(sidebarRect.top)
    expect(flyoutRect.bottom).toBeLessThanOrEqual(sidebarRect.bottom)
    expect(f.onResourceAction).not.toHaveBeenCalled()
    f.queryClient.clear()
  })

  it('preserves trigger-to-flyout transit and gives Main actions hover precedence', async () => {
    const f = mountedTree()
    await openMouse('A')
    await settle(f)
    const main = screen.getByRole('menu', { name: 'Actions for A' })
    const shareTrigger = within(main).getByRole('menuitem', { name: 'Share' })
    fireEvent.mouseOver(shareTrigger)
    const flyout = await screen.findByRole('menu', { name: 'Share options for A' })
    const copyLink = within(flyout).getByRole('menuitem', { name: 'Copy link' })

    fireEvent.mouseLeave(shareTrigger, { relatedTarget: copyLink })
    expect(screen.getByRole('menu', { name: 'Share options for A' })).toBe(flyout)
    copyLink.focus()
    const rename = within(main).getByRole('menuitem', { name: 'Rename' })
    fireEvent.mouseLeave(flyout, { relatedTarget: rename })

    await waitFor(() =>
      expect(screen.queryByRole('menu', { name: 'Share options for A' })).toBeNull()
    )
    expect(screen.getByRole('menu', { name: 'Actions for A' })).toBe(main)
    expect(document.activeElement).toBe(rename)
    expect(f.onResourceAction).not.toHaveBeenCalled()

    fireEvent.click(rename)
    expect(f.onResourceAction).toHaveBeenCalledOnce()
    expect(f.onResourceAction.mock.calls[0]?.[1]).toBe('rename')
    f.queryClient.clear()
  })

  it('closes a passively hovered flyout on external ArrowLeft without moving focus', async () => {
    const f = mountedTree()
    const external = document.createElement('button')
    external.textContent = 'External control'
    document.body.append(external)
    await openMouse('A')
    await settle(f)
    const main = screen.getByRole('menu', { name: 'Actions for A' })
    const share = within(main).getByRole('menuitem', { name: 'Share' })
    external.focus()
    fireEvent.mouseOver(share)
    await screen.findByRole('menu', { name: 'Share options for A' })
    expect(document.activeElement).toBe(external)

    const event = new KeyboardEvent('keydown', {
      key: 'ArrowLeft',
      bubbles: true,
      cancelable: true,
    })
    external.dispatchEvent(event)
    await waitFor(() =>
      expect(screen.queryByRole('menu', { name: 'Share options for A' })).toBeNull()
    )
    expect(event.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(external)
    expect(screen.getByRole('menu', { name: 'Actions for A' })).toBe(main)
    expect(f.onResourceAction).not.toHaveBeenCalled()
    external.remove()
    f.queryClient.clear()
  })

  it('activates one existing Share child once and closes both menu panels', async () => {
    const f = mountedTree()
    await openMouse('A')
    await settle(f)
    const main = screen.getByRole('menu', { name: 'Actions for A' })
    fireEvent.mouseOver(within(main).getByRole('menuitem', { name: 'Share' }))
    const flyout = await screen.findByRole('menu', { name: 'Share options for A' })
    const copyLink = within(flyout).getByRole('menuitem', { name: 'Copy link' })
    fireEvent.mouseDown(copyLink)
    expect(screen.getByRole('menu', { name: 'Actions for A' })).toBe(main)
    expect(screen.getByRole('menu', { name: 'Share options for A' })).toBe(flyout)
    fireEvent.mouseUp(copyLink)
    fireEvent.click(copyLink)
    expect(f.onResourceAction).toHaveBeenCalledOnce()
    expect(f.onResourceAction.mock.calls[0]?.[1]).toBe('copy-link')
    await waitFor(() => expect(screen.queryAllByRole('menu')).toHaveLength(0))
    expect(f.onResourceAction).toHaveBeenCalledOnce()
    f.queryClient.clear()
  })

  it('opens a hover-visible Share flyout from keyboard activation and focuses its first child', async () => {
    const f = mountedTree()
    await openKeyboard('A')
    await settle(f)
    const main = screen.getByRole('menu', { name: 'Actions for A' })
    const share = within(main).getByRole('menuitem', { name: 'Share' })
    share.focus()
    fireEvent.click(share, { detail: 0 })
    const flyout = await screen.findByRole('menu', { name: 'Share options for A' })
    expect(screen.getByRole('menu', { name: 'Actions for A' })).toBe(main)
    expect(document.activeElement?.getAttribute('data-share-child')).toBe('true')
    expect(flyout).not.toBe(main)
    f.queryClient.clear()
  })

  it('publishes the exact tree-owner admission and committed menu states', async () => {
    const reports: Array<{
      requestId: number
      state: {
        phase: 'open' | 'replace'
        menuOpen: boolean
        shareOpen: boolean
        admissionPending: boolean
      } | null
    }> = []
    const f = mountedTree(false, false, (requestId, state) => {
      reports.push({ requestId, state })
    })
    await openMouse('A')
    await settle(f)
    const ownerReport = reports.find(report => report.state !== null)
    expect(ownerReport).toBeDefined()
    expect(
      reports.some(
        report =>
          report.state?.admissionPending &&
          shouldDeferCompactSidebarEscape(document.body, report.state)
      )
    ).toBe(true)
    expect(reports.at(-1)?.state).toMatchObject({
      phase: 'open',
      menuOpen: true,
      shareOpen: false,
      admissionPending: false,
    })

    fireEvent.mouseOver(
      within(screen.getByRole('menu', { name: 'Actions for A' })).getByRole('menuitem', {
        name: 'Share',
      })
    )
    await screen.findByRole('menu', { name: 'Share options for A' })
    expect(reports.at(-1)).toMatchObject({
      requestId: ownerReport?.requestId,
      state: { phase: 'open', menuOpen: true, shareOpen: true, admissionPending: false },
    })
    expect(shouldDeferCompactSidebarEscape(document.body, reports.at(-1)?.state ?? null)).toBe(true)

    fireEvent.mouseDown(document.body)
    await waitFor(() => expect(screen.queryAllByRole('menu')).toHaveLength(0))
    expect(reports.at(-1)).toEqual({ requestId: ownerReport?.requestId, state: null })
    expect(shouldDeferCompactSidebarEscape(document.body, reports.at(-1)?.state ?? null)).toBe(
      false
    )
    f.queryClient.clear()
  })

  it('keeps Main mounted and restores focus across Share Escape and keyboard navigation', async () => {
    const f = mountedTree()
    await openMouse('A')
    await settle(f)
    const main = screen.getByRole('menu', { name: 'Actions for A' })
    const share = within(main).getByRole('menuitem', { name: 'Share' })
    const panelIdentity = main

    fireEvent.mouseOver(share)
    expect(screen.getByRole('menu', { name: 'Actions for A' })).toBe(panelIdentity)
    expect(screen.getAllByRole('menu')).toHaveLength(2)

    fireEvent.keyDown(share, { key: 'ArrowRight' })
    const sharePanel = await screen.findByRole('menu', { name: 'Share options for A' })
    expect(sharePanel).not.toBe(panelIdentity)
    expect(screen.getAllByRole('menu')).toHaveLength(2)
    expect(document.activeElement?.getAttribute('data-share-child')).toBe('true')

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
    await waitFor(() =>
      expect(screen.queryByRole('menu', { name: 'Share options for A' })).toBeNull()
    )
    expect(screen.getByRole('menu', { name: 'Actions for A' })).toBe(panelIdentity)
    expect(document.activeElement).toBe(
      within(panelIdentity).getByRole('menuitem', { name: 'Share' })
    )

    fireEvent.mouseOver(share)
    await screen.findByRole('menu', { name: 'Share options for A' })
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() =>
      expect(screen.queryByRole('menu', { name: 'Share options for A' })).toBeNull()
    )
    expect(screen.getByRole('menu', { name: 'Actions for A' })).toBe(panelIdentity)
    expect(document.activeElement).toBe(
      within(panelIdentity).getByRole('menuitem', { name: 'Share' })
    )

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(document.activeElement).toBe(await screen.findByRole('button', { name: 'A' }))
    f.queryClient.clear()
  })

  it('restores row focus before Main Escape at the Share-close commit in compact SidebarNav', async () => {
    const onCompactMenuOpenChange = vi.fn()
    const f = mountedTree(false, false, undefined, true, onCompactMenuOpenChange)
    fireEvent.click(screen.getByTestId('nav-files-explorer-toggle'))
    const row = await openMouse('A')
    await settle(f)
    const main = screen.getByRole('menu', { name: 'Actions for A' })
    const shareTrigger = within(main).getByRole('menuitem', { name: 'Share' })
    fireEvent.mouseOver(shareTrigger)
    const sharePanel = await screen.findByRole('menu', { name: 'Share options for A' })
    fireEvent.keyDown(shareTrigger, { key: 'ArrowRight' })
    expect(document.activeElement?.getAttribute('data-share-child')).toBe('true')

    let injectedEscape = false
    menuCapture.onMenuState = (_requestId, open, shareOpen) => {
      if (injectedEscape || !open || shareOpen) return
      injectedEscape = true
      // This callback runs from GfsResourceMenu's layout effect after the
      // Share-close commit, before its passive focus effect can run.
      fireEvent.keyDown(window, { key: 'Escape' })
    }

    fireEvent.mouseLeave(shareTrigger, { relatedTarget: row })

    expect(screen.queryByRole('menu', { name: 'Share options for A' })).toBeNull()
    expect(injectedEscape, `state reports: ${JSON.stringify(menuCapture.states)}`).toBe(true)
    expect(screen.queryByRole('menu', { name: 'Share options for A' })).toBeNull()
    expect(screen.queryByRole('menu', { name: 'Actions for A' })).toBeNull()
    expect(document.activeElement).toBe(row)
    expect(onCompactMenuOpenChange).not.toHaveBeenCalledWith(false)
    f.queryClient.clear()
  })

  it('changes the tree owner on a real touch long-press and starts the new owner in Main', async () => {
    const f = mountedTree()
    await openMouse('A')
    await settle(f)
    fireEvent.click(
      within(screen.getByRole('menu', { name: 'Actions for A' })).getByRole('menuitem', {
        name: 'Share',
      })
    )
    await screen.findByRole('menu', { name: 'Share options for A' })
    const b = await screen.findByRole('button', { name: 'B' })
    const rowB = b.closest('[role="treeitem"]')!.querySelector('.da-file-explorer__row')!
    vi.useFakeTimers()
    fireEvent.pointerDown(rowB, { pointerType: 'touch', pointerId: 4, clientX: 80, clientY: 130 })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    const next = screen.getByRole('menu', { name: 'Actions for B' })
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    expect(screen.queryByRole('menu', { name: 'Share options for A' })).toBeNull()
    expect(within(next).queryByRole('menuitem', { name: 'Back' })).toBeNull()
    vi.useRealTimers()
    f.queryClient.clear()
  })

  it('keeps a fresh same-resource owner when the prior request cleanup runs', async () => {
    const f = mountedTree()
    await openKeyboard('A')
    await settle(f)
    const priorPanel = screen.getByRole('menu', { name: 'Actions for A' })

    // A second production ContextMenu event updates the tree-scoped request ID.
    // The previous owner's layout cleanup runs during that commit and must not
    // clear the new request merely because both requests target resource A.
    const button = await screen.findByRole('button', { name: 'A' })
    await act(async () => {
      fireEvent.keyDown(button, { key: 'ContextMenu' })
      await Promise.resolve()
      await Promise.resolve()
    })
    await settle(f)

    expect(screen.queryByRole('menu', { name: 'Actions for A' })).toBe(priorPanel)
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    expect(f.onResourceAction).not.toHaveBeenCalled()
    expect(f.download).not.toHaveBeenCalled()
    f.queryClient.clear()
  })

  it('keeps B as the active owner when A cleanup arrives after owner transfer', async () => {
    const f = mountedTree()
    await openKeyboard('A')
    await settle(f)

    // The real row producer synchronously installs B's tree-scoped receipt.
    // During the ensuing commit React runs A's registered layout cleanup.
    await openKeyboard('B')
    await settle(f)

    const model = transition(transition(initial(), { type: 'open', resource: 'A', request: 1 }), {
      type: 'open',
      resource: 'B',
      request: 2,
    })
    const activePanel = screen.getByRole('menu', { name: 'Actions for B' }) as HTMLElement
    const panelRect = activePanel.getBoundingClientRect()
    const sidebarRect = document.querySelector('.left-nav')!.getBoundingClientRect()
    Object.assign(
      model,
      transition(model, {
        type: 'geometry',
        id: 2,
        sidebar: {
          left: sidebarRect.left,
          top: sidebarRect.top,
          right: sidebarRect.right,
          bottom: sidebarRect.bottom,
        },
        rect: {
          left: panelRect.left,
          top: panelRect.top,
          right: panelRect.right,
          bottom: panelRect.bottom,
        },
      })
    )
    Object.assign(model, transition(model, { type: 'settled' }))
    expect(assertA4(model).onePanel).toBe(true)
    expect(screen.getByRole('menu', { name: 'Actions for B' })).toBeTruthy()
    expect(screen.queryByRole('menu', { name: 'Actions for A' })).toBeNull()
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    expect(f.onResourceAction).not.toHaveBeenCalled()
    expect(f.download).not.toHaveBeenCalled()
    f.queryClient.clear()
  })

  it('rejects an action callback captured for A after B takes the tree owner', async () => {
    const f = mountedTree()
    await openKeyboard('A')
    await settle(f)

    const capturedA = menuCapture.actionsByResource.get('A') as
      | Array<{ id: string; run: () => void }>
      | undefined
    const staleDownload = capturedA?.find(action => action.id === 'download')
    expect(staleDownload).toBeTruthy()

    await openKeyboard('B')
    await settle(f)
    expect(screen.getByRole('menu', { name: 'Actions for B' })).toBeTruthy()

    const beforeEffects = f.onResourceAction.mock.calls.length
    await act(async () => staleDownload!.run())
    await settle(f)

    expect(f.onResourceAction).toHaveBeenCalledTimes(beforeEffects)
    expect(f.download).not.toHaveBeenCalled()
    expect(screen.getByRole('menu', { name: 'Actions for B' })).toBeTruthy()
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    f.queryClient.clear()
  })

  it('does not replay a request when its row unmounts before the menu effect and remounts', async () => {
    const f = mountedTree()
    await waitFor(() => expect(f.queryClient.isFetching()).toBe(0))
    const accessible = f.queryClient
      .getQueryCache()
      .findAll()
      .find(query => query.queryKey.includes('accessible'))
    expect(accessible).toBeTruthy()
    const priorData = f.queryClient.getQueryData(accessible!.queryKey) as {
      pages: unknown[]
      pageParams: unknown[]
    }
    const emptyData = { ...priorData, pages: [await listAccessiblePage([])] }
    const button = await screen.findByRole('button', { name: 'A' })

    // Batch the real ContextMenu producer with a permission-derived row removal.
    // The request is admitted, but no menu-owning row reaches its open effect.
    await act(async () => {
      fireEvent.keyDown(button, { key: 'ContextMenu' })
      f.queryClient.setQueryData(accessible!.queryKey, emptyData)
      await Promise.resolve()
    })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'A' })).toBeNull())
    await settle(f)
    expect(screen.queryByRole('menu')).toBeNull()

    // The same resource returns through the list producer, without a new user request.
    await act(async () => {
      f.queryClient.setQueryData(accessible!.queryKey, priorData)
      await Promise.resolve()
    })
    await screen.findByRole('button', { name: 'A' })
    await settle(f)
    expect(screen.queryByRole('menu', { name: 'Actions for A' })).toBeNull()
    expect(screen.queryAllByRole('menu')).toHaveLength(0)
    expect(f.onResourceAction).not.toHaveBeenCalled()
    expect(f.download).not.toHaveBeenCalled()
    f.queryClient.clear()
  })

  it('retains a live Replace handoff, cancels it, and rejects a late result after owner transfer', async () => {
    const f = mountedTree()
    await openMouse('A')
    await settle(f)
    const inputA = screen.getByLabelText('Replace A') as HTMLInputElement
    const clickA = vi.spyOn(inputA, 'click').mockImplementation(() => {})
    fireEvent.click(screen.getByRole('menuitem', { name: 'Replace file' }))
    expect(clickA).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Actions for A' })).toBeNull())
    const selected = new File(['current'], 'current.txt')
    fireEvent.change(inputA, { target: { files: [selected] } })
    await settle(f)
    expect(f.onResourceAction.mock.calls.filter(call => call[1] === 'replace')).toEqual([
      [expect.objectContaining({ name: 'A' }), 'replace', selected],
    ])

    await openMouse('A')
    await settle(f)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Replace file' }))
    fireEvent(inputA, new Event('cancel', { bubbles: true }))
    await openKeyboard('B')
    const beforeLateCompletion = f.onResourceAction.mock.calls.length
    fireEvent.change(inputA, { target: { files: [new File(['stale'], 'stale.txt')] } })
    await settle(f)
    expect(f.onResourceAction.mock.calls.length).toBe(beforeLateCompletion)
    expect(screen.getByRole('menu', { name: 'Actions for B' })).toBeTruthy()
    f.queryClient.clear()
  })

  it('compares resize and scroll geometry to the sidebar intersection at quiescence', async () => {
    const f = mountedTree()
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 180 })
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains('left-nav'))
          return {
            x: 20,
            y: 0,
            left: 20,
            top: 0,
            right: 260,
            bottom: 180,
            width: 240,
            height: 180,
            toJSON: () => ({}),
          }
        if (this.classList.contains('da-gfs-resource-menu__panel')) {
          const left = Number.parseFloat(this.style.left) || 0
          const top = Number.parseFloat(this.style.top) || 0
          const width = Number.parseFloat(this.style.width) || 232
          const height = Math.min(300, Number.parseFloat(this.style.maxHeight) || 164)
          return {
            x: left,
            y: top,
            left,
            top,
            right: left + width,
            bottom: top + height,
            width,
            height,
            toJSON: () => ({}),
          }
        }
        if (this.classList.contains('da-file-explorer__row'))
          return {
            x: 40,
            y: 150,
            left: 40,
            top: 150,
            right: 220,
            bottom: 174,
            width: 180,
            height: 24,
            toJSON: () => ({}),
          }
        return {
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          right: 240,
          bottom: 180,
          width: 240,
          height: 180,
          toJSON: () => ({}),
        }
      })
    await openMouse('A')
    const panel = screen.getByRole('menu', { name: 'Actions for A' }) as HTMLElement
    const leftBefore = panel.style.left
    fireEvent.resize(window)
    fireEvent.scroll(window)
    await settle(f)
    const rect = panel.getBoundingClientRect()
    const observed = {
      leftBefore,
      leftAfter: panel.style.left,
      rect,
      sidebar: document.querySelector('.left-nav')!.getBoundingClientRect(),
      listenerReachedPanel: rectSpy.mock.calls.length > 0,
    }
    const model = transition(transition(initial(), { type: 'open', resource: 'A', request: 1 }), {
      type: 'geometry',
      id: 1,
      sidebar: { left: 20, top: 0, right: 260, bottom: 180 },
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
    })
    expect(observed.listenerReachedPanel).toBe(true)
    expect(
      model.rect &&
        model.rect.right <= model.sidebar.right &&
        model.rect.bottom <= model.sidebar.bottom
    ).toBe(true)
    f.queryClient.clear()
  })

  it('keeps Main and Share panels stable and repositions Share with its row on scroll', async () => {
    const f = mountedTree()
    let rowTop = 50
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      if (this.classList.contains('left-nav'))
        return {
          x: 20,
          y: 0,
          left: 20,
          top: 0,
          right: 260,
          bottom: 800,
          width: 240,
          height: 800,
          toJSON: () => ({}),
        }
      if (this.closest('.da-gfs-drive') || this.classList.contains('da-gfs-drive'))
        return {
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          right: 900,
          bottom: 800,
          width: 900,
          height: 800,
          toJSON: () => ({}),
        }
      if (this.classList.contains('da-file-explorer__label'))
        return {
          x: 40,
          y: rowTop,
          left: 40,
          top: rowTop,
          right: 220,
          bottom: rowTop + 24,
          width: 180,
          height: 24,
          toJSON: () => ({}),
        }
      if (this.classList.contains('da-gfs-resource-menu__panel')) {
        const left = Number.parseFloat(this.style.left) || 0
        const top = Number.parseFloat(this.style.top) || 0
        const width = Number.parseFloat(this.style.width) || 232
        const height = Math.min(240, Number.parseFloat(this.style.maxHeight) || 760)
        return {
          x: left,
          y: top,
          left,
          top,
          right: left + width,
          bottom: top + height,
          width,
          height,
          toJSON: () => ({}),
        }
      }
      return {
        x: 40,
        y: 40,
        left: 40,
        top: 40,
        right: 240,
        bottom: 64,
        width: 200,
        height: 24,
        toJSON: () => ({}),
      }
    })
    await openMouse('A')
    await settle(f)
    fireEvent.click(
      within(screen.getByRole('menu', { name: 'Actions for A' })).getByRole('menuitem', {
        name: 'Share',
      })
    )
    const share = (await screen.findByRole('menu', { name: 'Share options for A' })) as HTMLElement
    const before = {
      left: Number.parseFloat(share.style.left),
      top: Number.parseFloat(share.style.top),
      panels: screen.getAllByRole('menu').length,
    }
    rowTop = 110
    fireEvent.scroll(window)
    await settle(f)
    const afterScroll = {
      left: Number.parseFloat(share.style.left),
      top: Number.parseFloat(share.style.top),
      panels: screen.getAllByRole('menu').length,
    }
    rowTop = 130
    fireEvent.resize(window)
    await settle(f)
    const afterResize = {
      left: Number.parseFloat(share.style.left),
      top: Number.parseFloat(share.style.top),
      panels: screen.getAllByRole('menu').length,
    }
    const observed = {
      before,
      afterScroll,
      afterResize,
      sidebarRight: 260,
      shareRight: afterResize.left + Number.parseFloat(share.style.width),
    }
    expect(afterScroll.top).toBe(180)
    expect(afterResize.top).toBe(200)
    expect(afterResize.panels).toBe(2)
    expect(observed.shareRight).toBeLessThanOrEqual(observed.sidebarRight - 8)
    f.queryClient.clear()
  })

  it('settles old permission requests without retargeting the active resource or duplicating effects', async () => {
    const f = mountedTree(true)
    await openMouse('A')
    await resolvePermission(f, f.idA)
    fireEvent.mouseDown(document.body)
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    await openKeyboard('B')
    await resolvePermission(f, f.idB)
    await settle(f)
    const before = observe(f, 'B')
    expect(before).toMatchObject({
      resource: 'B',
      open: true,
      view: 'main',
      visiblePanelCount: 1,
      actionEffects: [],
      downloads: 0,
    })
    expect(before.activeActions.some(item => item.disabled)).toBe(false)
    f.queryClient.clear()
  })

  it('refreshes the Share permission projection while Share is open', async () => {
    const f = mountedTree(true)
    await openMouse('A')
    await resolvePermission(f, f.idA)
    const main = screen.getByRole('menu', { name: 'Actions for A' })
    fireEvent.click(within(main).getByRole('menuitem', { name: 'Share' }))
    const share = await screen.findByRole('menu', { name: 'Share options for A' })
    const before = Array.from(share.querySelectorAll<HTMLElement>('[role="menuitem"]')).map(item =>
      item.textContent?.trim()
    )
    const query = f.queryClient
      .getQueryCache()
      .findAll()
      .find(entry => entry.queryKey.includes(f.idA) && entry.queryKey.includes('affordances'))
    expect(query).toBeTruthy()
    const refresh = f.queryClient.invalidateQueries({ queryKey: query!.queryKey, exact: true })
    await waitFor(() => expect(f.pending.has(f.idA)).toBe(true))
    await act(async () => {
      f.pending.get(f.idA)!.resolve(await resourceAffordances(['read']))
      f.pending.delete(f.idA)
      await refresh
    })
    await settle(f)
    const actualShare = screen.getByRole('menu', { name: 'Share options for A' })
    const after = Array.from(actualShare.querySelectorAll<HTMLElement>('[role="menuitem"]')).map(
      item => item.textContent?.trim()
    )
    const observed = {
      before,
      after,
      sameResource: actualShare.getAttribute('aria-label') === 'Share options for A',
      panels: screen.getAllByRole('menu').length,
    }
    expect(observed.sameResource).toBe(true)
    expect(observed.panels).toBe(2)
    expect(after).not.toEqual(before)
    f.queryClient.clear()
  })

  it('ignores a late permission denial from a prior session generation', async () => {
    const f = mountedTree(true)
    await openMouse('A')
    await waitFor(() => expect(f.pending.has(f.idA)).toBe(true))
    auth.sessionGeneration = 8
    f.rerenderTree()
    await openKeyboard('B')
    await resolvePermission(f, f.idB)
    await act(async () => {
      f.pending.get(f.idA)!.reject(new Error('401 Unauthorized'))
      f.pending.delete(f.idA)
    })
    await settle(f)
    const observed = observe(f, 'B')
    expect(observed).toMatchObject({
      resource: 'B',
      open: true,
      view: 'main',
      actionEffects: [],
      downloads: 0,
    })
    expect(screen.getByRole('menu', { name: 'Actions for B' })).toBeTruthy()
    f.queryClient.clear()
  })

  it('keeps Replace callback ownership tied to A only until same-owner completion or cancellation', async () => {
    const f = mountedTree()
    await openMouse('A')
    const replace = await screen.findByRole('menuitem', { name: 'Replace file' })
    const input = screen.getByLabelText('Replace A') as HTMLInputElement
    vi.spyOn(input, 'click').mockImplementation(() => {})
    fireEvent.click(replace)
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Actions for A' })).toBeNull())
    fireEvent(input, new Event('cancel', { bubbles: true }))
    await openKeyboard('B')
    const before = f.onResourceAction.mock.calls.length
    fireEvent.change(input, { target: { files: [new File(['late'], 'late.txt')] } })
    await settle(f)
    const observed = {
      before,
      after: f.onResourceAction.mock.calls.length,
      target: f.onResourceAction.mock.calls.at(-1)?.[0]?.name ?? null,
    }
    expect(observed.after).toBe(observed.before)
    f.queryClient.clear()
  })
})
