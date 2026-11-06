// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { EmbedOwnershipMachine } from '@lib/embedOwnershipMachine.types'
import {
  type SandboxUiMainFake,
  createSandboxUiMainFake,
} from '../../__tests__/__fixtures__/sandboxUiMainFake'
import { SandboxUiPage as SandboxUiPageBase } from '../SandboxUiPage'
import {
  LaunchingSandboxUiPage as SandboxUiPage,
  createPageEmbed,
} from './__fixtures__/launchingSandboxUiPage'

// The sandbox-ui main fake runs the real main process; these are the
// layers under it that the suite does not stand up.
vi.mock(
  'electron',
  async () =>
    (await import('../../../../src/__tests__/__fixtures__/sandboxUiElectronFakes')).electronModule
)
vi.mock(
  '../../../../src/config',
  async () =>
    (await import('../../../../src/__tests__/__fixtures__/sandboxUiMainModuleMocks')).configModule
)
vi.mock(
  '../../../../src/sandboxUiPartitionGc',
  async () =>
    (await import('../../../../src/__tests__/__fixtures__/sandboxUiMainModuleMocks'))
      .partitionGcModule
)
vi.mock(
  '../../../../src/rpcTokenManager',
  async () =>
    (await import('../../../../src/__tests__/__fixtures__/sandboxUiMainModuleMocks'))
      .rpcTokenManagerModule
)
vi.mock(
  '../../../../src/authClient',
  async () =>
    (await import('../../../../src/__tests__/__fixtures__/sandboxUiMainModuleMocks'))
      .authClientModule
)
vi.mock(
  '../../../../src/tokenStore',
  async () =>
    (await import('../../../../src/__tests__/__fixtures__/sandboxUiMainModuleMocks'))
      .tokenStoreModule
)

const sandboxUi = {
  listApps: vi.fn(),
  open: vi.fn(),
  close: vi.fn(),
  copyDeepLink: vi.fn(),
  setBounds: vi.fn(),
  setVisible: vi.fn(),
  capturePreview: vi.fn(),
  findInPage: vi.fn(),
  stopFindInPage: vi.fn(),
  focusActive: vi.fn(),
  onFindResult: vi.fn((_callback: (result: FindResultPayload) => void) => vi.fn()),
}
type FindResultPayload = {
  requestId: number
  clientRequestId: number
  activeMatchOrdinal: number
  matches: number
  finalUpdate: boolean
}
let emitFindResult: ((result: FindResultPayload) => void) | null = null

function installClerumApi(): void {
  ;(window as unknown as { clerum: unknown }).clerum = { sandboxUi }
}

describe('SandboxUiPage', () => {
  let mainFake: SandboxUiMainFake | null = null
  beforeEach(() => {
    vi.clearAllMocks()
    sandboxUi.setBounds.mockResolvedValue(undefined)
    sandboxUi.setVisible.mockResolvedValue(undefined)
    sandboxUi.findInPage.mockResolvedValue({ status: 'started', requestId: 17 })
    sandboxUi.onFindResult.mockImplementation(callback => {
      emitFindResult = callback
      return vi.fn()
    })
    sandboxUi.stopFindInPage.mockResolvedValue(undefined)
    sandboxUi.focusActive.mockResolvedValue(true)
    installClerumApi()
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn()
        unobserve = vi.fn()
        disconnect = vi.fn()
      }
    )
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 12,
      left: 16,
      right: 416,
      bottom: 312,
      width: 400,
      height: 300,
      toJSON: () => ({}),
    } as DOMRect)
  })

  afterEach(async () => {
    cleanup()
    await new Promise(resolve => window.setTimeout(resolve, 0))
    await mainFake?.dispose()
    mainFake = null
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    delete (window as { clerum?: unknown }).clerum
  })

  it('renders all accessible Sandbox UI apps instead of the empty state', async () => {
    sandboxUi.listApps.mockResolvedValueOnce({
      apps: [
        {
          appRef: 'sandbox-recipes/sales-crm',
          title: "Andy's Sales CRM",
          defaultPath: '/',
          ready: true,
          phase: 'active',
          updatedAt: null,
        },
        {
          appRef: 'sandbox-recipes/support-desk',
          title: 'Support Desk',
          defaultPath: '/tickets',
          ready: true,
          phase: 'active',
          updatedAt: null,
        },
      ],
    })

    render(<SandboxUiPage />)

    expect(await screen.findByText("Andy's Sales CRM")).toBeTruthy()
    expect(screen.getByText('Support Desk')).toBeTruthy()
    expect(screen.queryByText('No available apps yet')).toBeNull()
    expect(screen.getAllByRole('button', { name: /^Open / })).toHaveLength(2)
  })

  it('hands a grid pick to the owner instead of opening the embed itself', async () => {
    sandboxUi.listApps.mockResolvedValueOnce({
      apps: [
        {
          appRef: 'sandbox-recipes/sales-crm',
          title: " Andy's Sales CRM ",
          icon: 'data:image/png;base64,icon',
          defaultPath: '/accounts',
          ready: true,
          phase: 'active',
          updatedAt: null,
        },
      ],
    })
    const onLaunchApp = vi.fn()

    render(<SandboxUiPageBase embed={createPageEmbed()} onLaunchApp={onLaunchApp} />)
    fireEvent.click(await screen.findByRole('button', { name: "Open Andy's Sales CRM" }))

    expect(onLaunchApp).toHaveBeenCalledExactlyOnceWith({
      appRef: 'sandbox-recipes/sales-crm',
      label: "Andy's Sales CRM",
      icon: 'data:image/png;base64,icon',
      defaultPath: '/accounts',
    })
    await new Promise(resolve => window.setTimeout(resolve, 0))
    // Without an owner feeding the app back, the page stays on the picker.
    expect(sandboxUi.open).not.toHaveBeenCalled()
    expect(screen.queryByTestId('sandbox-ui-mounted')).toBeNull()
  })

  it('does not launch an app that is still starting up', async () => {
    sandboxUi.listApps.mockResolvedValueOnce({
      apps: [
        {
          appRef: 'sandbox-recipes/sales-crm',
          title: "Andy's Sales CRM",
          defaultPath: '/',
          ready: false,
          phase: 'deploying',
          updatedAt: null,
        },
      ],
    })
    const onLaunchApp = vi.fn()

    render(<SandboxUiPageBase embed={createPageEmbed()} onLaunchApp={onLaunchApp} />)
    fireEvent.click(await screen.findByText("Andy's Sales CRM"))

    expect(screen.queryByRole('button', { name: "Open Andy's Sales CRM" })).toBeNull()
    expect(onLaunchApp).not.toHaveBeenCalled()
  })

  it('does not let an old unmount timer close an immediate replacement page', async () => {
    sandboxUi.listApps.mockResolvedValue({ apps: [] })
    sandboxUi.close.mockResolvedValue(undefined)
    const first = render(<SandboxUiPage />)

    first.unmount()
    render(<SandboxUiPage />)
    await new Promise(resolve => window.setTimeout(resolve, 0))

    expect(sandboxUi.close).not.toHaveBeenCalled()
  })

  it('renders the empty apps page with calm centered guidance', async () => {
    sandboxUi.listApps.mockResolvedValueOnce({ apps: [] })

    render(<SandboxUiPage />)

    expect(await screen.findByRole('heading', { name: 'Apps' })).toBeTruthy()
    expect(await screen.findByText('No available apps yet')).toBeTruthy()
    expect(screen.getByText('Ask an admin if you expected to see one here.')).toBeTruthy()
    expect(screen.queryByText(/No recipes you can access expose a sandbox UI/)).toBeNull()
  })

  it('treats a 403 app list response as an empty apps page', async () => {
    sandboxUi.listApps.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'sandboxUi:listApps': Error: 403 Forbidden: No permitted scopes/hostRefs for requested RPC token"
      )
    )

    render(<SandboxUiPage />)

    expect(await screen.findByText('No available apps yet')).toBeTruthy()
    expect(screen.getByText('Ask an admin if you expected to see one here.')).toBeTruthy()
    expect(screen.queryByText(/403 Forbidden/)).toBeNull()
  })

  it('opens the selected app through the sandbox UI bridge with measured bounds', async () => {
    sandboxUi.listApps.mockResolvedValueOnce({
      apps: [
        {
          appRef: 'sandbox-recipes/sales-crm',
          title: "Andy's Sales CRM",
          defaultPath: '/',
          ready: true,
          phase: 'active',
          updatedAt: null,
        },
      ],
    })
    sandboxUi.open.mockResolvedValueOnce(undefined)

    render(<SandboxUiPage />)

    fireEvent.click(await screen.findByRole('button', { name: "Open Andy's Sales CRM" }))

    await waitFor(() => {
      expect(sandboxUi.open).toHaveBeenCalledWith({
        recipeNs: 'sandbox-recipes',
        recipeName: 'sales-crm',
        title: "Andy's Sales CRM",
        defaultPath: '/',
        bounds: {
          x: 16,
          y: 12,
          width: 400,
          height: 300,
          dpr: expect.any(Number),
        },
        launchId: expect.any(String),
      })
    })
    expect(await screen.findByTestId('sandbox-ui-mounted')).toBeTruthy()
    // "Back to apps" was removed by design — the sidebar owns the return to the
    // app picker now. The mounted app-actions moved to the title-bar leading slot.
    expect(screen.queryByRole('button', { name: 'Back to apps' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Refresh app content' })).toBeTruthy()
  })

  it('does not portal an empty leading-actions container while minting without a conversation origin', async () => {
    sandboxUi.listApps.mockResolvedValueOnce({
      apps: [
        {
          appRef: 'sandbox-recipes/sales-crm',
          title: "Andy's Sales CRM",
          defaultPath: '/',
          ready: true,
          phase: 'active',
          updatedAt: null,
        },
      ],
    })
    // Hold the open in-flight so the page stays in 'minting' (never reaches
    // 'mounted'). With no conversationOrigin and no drawer/back handlers, every
    // leading control is absent — the wrapper must not be portaled at all,
    // otherwise an empty <div> is injected into the shared title bar.
    sandboxUi.open.mockReturnValueOnce(new Promise<void>(() => {}))

    render(<SandboxUiPage />)
    fireEvent.click(await screen.findByRole('button', { name: "Open Andy's Sales CRM" }))

    // The mounted/minting section renders (shared testid) and the open request
    // is in-flight, so we are firmly in 'minting'.
    expect(await screen.findByTestId('sandbox-ui-mounted')).toBeTruthy()
    await waitFor(() => expect(sandboxUi.open).toHaveBeenCalled())

    // The leading slot (portaled into the container) must stay empty.
    expect(document.body.querySelector('.window-titlebar__leading-actions')).toBeNull()
  })

  // Mini-spec 04a §C: the chat-drawer toggle moved to the app header. The leading
  // slot no longer renders it (or the old conversation-origin variant); only
  // refresh + copy remain there.
  it('never renders a chat-drawer toggle in the leading slot, keeping only refresh + copy', async () => {
    sandboxUi.listApps.mockResolvedValueOnce({
      apps: [
        {
          appRef: 'sandbox-recipes/sales-crm',
          title: "Andy's Sales CRM",
          defaultPath: '/',
          ready: true,
          phase: 'active',
          updatedAt: null,
        },
      ],
    })
    sandboxUi.open.mockResolvedValueOnce(undefined)

    render(<SandboxUiPage />)
    fireEvent.click(await screen.findByRole('button', { name: "Open Andy's Sales CRM" }))
    await screen.findByTestId('sandbox-ui-mounted')

    // No drawer toggle in the leading slot, in either label state.
    expect(screen.queryByRole('button', { name: 'Open chat drawer' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Close chat drawer' })).toBeNull()
    // Refresh + copy stay wired.
    expect(screen.getByRole('button', { name: 'Refresh app content' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy current app link' })).toBeTruthy()
  })

  it('asks its owner to refresh on Refresh, only once the app is mounted', async () => {
    sandboxUi.listApps.mockResolvedValue({
      apps: [
        {
          appRef: 'sandbox-recipes/sales-crm',
          title: 'Sales CRM',
          defaultPath: '/',
          ready: true,
          phase: 'active',
          updatedAt: null,
        },
      ],
    })
    let finishOpen!: () => void
    sandboxUi.open.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          finishOpen = resolve
        })
    )
    const onRefresh = vi.fn()
    const onRelaunch = vi.fn()
    render(<SandboxUiPage onRefresh={onRefresh} onRelaunch={onRelaunch} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open Sales CRM' }))
    await waitFor(() => expect(sandboxUi.open).toHaveBeenCalledOnce())
    // While the view is still opening there is nothing to refresh.
    expect(screen.queryByRole('button', { name: 'Refresh app content' })).toBeNull()

    await act(async () => finishOpen())
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh app content' }))

    expect(onRefresh).toHaveBeenCalledOnce()
    expect(onRelaunch).not.toHaveBeenCalled()
    // The refresh is the owner's: the page itself neither reloads nor closes.
    expect(sandboxUi.close).not.toHaveBeenCalled()
  })

  it('runs contextual find only against the mounted active WebContents contract', async () => {
    sandboxUi.listApps.mockResolvedValueOnce({
      apps: [
        {
          appRef: 'sandbox-recipes/sales-crm',
          title: "Andy's Sales CRM",
          defaultPath: '/',
          ready: true,
          phase: 'active',
          updatedAt: null,
        },
      ],
    })
    sandboxUi.open.mockResolvedValueOnce(undefined)

    render(<SandboxUiPage localSearchRequestId={1} />)
    fireEvent.click(await screen.findByRole('button', { name: "Open Andy's Sales CRM" }))
    const input = await screen.findByRole('textbox', { name: 'Find in current app' })
    fireEvent.change(input, { target: { value: 'invoice' } })
    await waitFor(() => {
      expect(sandboxUi.findInPage).toHaveBeenCalledWith('invoice', {
        operation: 'start',
        clientRequestId: expect.any(Number),
      })
    })
    expect(screen.getByRole('status').textContent).toBe('Searching…')
    const startOptions = sandboxUi.findInPage.mock.calls.at(-1)?.[1]
    emitFindResult?.({
      requestId: 17,
      clientRequestId: startOptions.clientRequestId,
      activeMatchOrdinal: 1,
      matches: 2,
      finalUpdate: true,
    })
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('1/2'))
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(sandboxUi.findInPage).toHaveBeenLastCalledWith('invoice', {
      operation: 'previous',
      clientRequestId: startOptions.clientRequestId,
    })
    fireEvent.keyDown(input, { key: 'Escape' })
    await waitFor(() => {
      expect(sandboxUi.stopFindInPage).toHaveBeenCalled()
      expect(sandboxUi.focusActive).toHaveBeenCalled()
    })
    expect(screen.queryByRole('textbox', { name: 'Find in current app' })).toBeNull()
  })

  it('accepts the first native find result before the invoke response resolves', async () => {
    sandboxUi.listApps.mockResolvedValueOnce({
      apps: [
        {
          appRef: 'sandbox-recipes/sales-crm',
          title: "Andy's Sales CRM",
          defaultPath: '/',
          ready: true,
          phase: 'active',
          updatedAt: null,
        },
      ],
    })
    sandboxUi.open.mockResolvedValueOnce(undefined)
    sandboxUi.findInPage.mockReturnValueOnce(new Promise(() => undefined))

    render(<SandboxUiPage localSearchRequestId={1} />)
    fireEvent.click(await screen.findByRole('button', { name: "Open Andy's Sales CRM" }))
    const input = await screen.findByRole('textbox', { name: 'Find in current app' })
    fireEvent.change(input, { target: { value: 'invoice' } })
    const options = sandboxUi.findInPage.mock.calls.at(-1)?.[1]
    expect(options?.clientRequestId).toEqual(expect.any(Number))

    emitFindResult?.({
      requestId: 17,
      clientRequestId: options.clientRequestId,
      activeMatchOrdinal: 1,
      matches: 2,
      finalUpdate: true,
    })

    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('1/2'))

    fireEvent.change(input, { target: { value: 'receipt' } })
    const nextOptions = sandboxUi.findInPage.mock.calls.at(-1)?.[1]
    expect(nextOptions.clientRequestId).not.toBe(options.clientRequestId)
    emitFindResult?.({
      requestId: 17,
      clientRequestId: options.clientRequestId,
      activeMatchOrdinal: 2,
      matches: 9,
      finalUpdate: true,
    })
    expect(screen.getByRole('status').textContent).toBe('Searching…')
    emitFindResult?.({
      requestId: 18,
      clientRequestId: nextOptions.clientRequestId,
      activeMatchOrdinal: 1,
      matches: 1,
      finalUpdate: true,
    })
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('1/1'))
  })

  it('rejects a queued find result from a prior mounted page', async () => {
    const listing = {
      apps: [
        {
          appRef: 'sandbox-recipes/sales-crm',
          title: "Andy's Sales CRM",
          defaultPath: '/',
          ready: true,
          phase: 'active',
          updatedAt: null,
        },
      ],
    }
    sandboxUi.listApps.mockResolvedValue(listing)
    sandboxUi.open.mockResolvedValue(undefined)

    const first = render(<SandboxUiPage localSearchRequestId={1} />)
    fireEvent.click(await screen.findByRole('button', { name: "Open Andy's Sales CRM" }))
    fireEvent.change(await screen.findByRole('textbox', { name: 'Find in current app' }), {
      target: { value: 'old' },
    })
    const oldOptions = sandboxUi.findInPage.mock.calls.at(-1)?.[1]
    const emitOldResult = emitFindResult
    first.unmount()

    render(<SandboxUiPage localSearchRequestId={1} />)
    fireEvent.click(await screen.findByRole('button', { name: "Open Andy's Sales CRM" }))
    fireEvent.change(await screen.findByRole('textbox', { name: 'Find in current app' }), {
      target: { value: 'new' },
    })
    const newOptions = sandboxUi.findInPage.mock.calls.at(-1)?.[1]
    expect(newOptions.clientRequestId).not.toBe(oldOptions.clientRequestId)

    emitOldResult?.({
      requestId: 17,
      clientRequestId: oldOptions.clientRequestId,
      activeMatchOrdinal: 7,
      matches: 7,
      finalUpdate: true,
    })
    expect(screen.getByRole('status').textContent).toBe('Searching…')
  })

  it('opens a deep-linked app at its stable entry point before handing off the client route', async () => {
    sandboxUi.listApps.mockResolvedValueOnce({ apps: [] })
    sandboxUi.open.mockResolvedValueOnce(undefined)

    render(
      <SandboxUiPage
        initialLaunch={{
          appRef: 'sandbox-recipes/task-board',
          label: 'Agentic Task Board',
          defaultPath: '/',
          routePath: '/tasks/task-42',
        }}
      />
    )

    await waitFor(() => {
      expect(sandboxUi.open).toHaveBeenCalledWith({
        recipeNs: 'sandbox-recipes',
        recipeName: 'task-board',
        // Host-owned title: consent prompts and notification attribution read
        // this, so it must come from the app list, never from the plugin.
        title: 'Agentic Task Board',
        defaultPath: '/',
        routePath: '/tasks/task-42',
        bounds: {
          x: 16,
          y: 12,
          width: 400,
          height: 300,
          dpr: expect.any(Number),
        },
        launchId: expect.any(String),
      })
    })
    expect(await screen.findByTestId('sandbox-ui-mounted')).toBeTruthy()
  })

  it('shows a failed open as the failure banner of the active app', async () => {
    sandboxUi.listApps.mockResolvedValue({ apps: [] })
    sandboxUi.open.mockRejectedValueOnce(new Error('native mount failed'))

    render(
      <SandboxUiPage
        activeAppRef="sandbox-recipes/task-board"
        initialLaunch={{
          appRef: 'sandbox-recipes/task-board',
          label: 'Agentic Task Board',
          defaultPath: '/',
        }}
      />
    )

    expect(await screen.findByText('sandbox-recipes/task-board: native mount failed')).toBeTruthy()
    expect(screen.queryByTestId('sandbox-ui-mounted')).toBeNull()
  })

  it('maps the session status of a failed open to its user-facing copy', async () => {
    sandboxUi.listApps.mockResolvedValue({ apps: [] })
    sandboxUi.open.mockRejectedValueOnce(new Error('Sandbox UI session failed (404): gone'))

    render(
      <SandboxUiPage
        activeAppRef="sandbox-recipes/task-board"
        initialLaunch={{ appRef: 'sandbox-recipes/task-board', label: 'Task', defaultPath: '/' }}
      />
    )

    expect(
      await screen.findByText('sandbox-recipes/task-board: This app was removed.')
    ).toBeTruthy()
  })

  it('shows a slot that never laid out as the slot failure', async () => {
    sandboxUi.listApps.mockResolvedValue({ apps: [] })
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    } as DOMRect)

    render(
      <SandboxUiPage
        activeAppRef="sandbox-recipes/task-board"
        initialLaunch={{ appRef: 'sandbox-recipes/task-board', label: 'Task', defaultPath: '/' }}
      />
    )

    expect(
      await screen.findByText(
        'sandbox-recipes/task-board: Embed slot is not laid out — cannot determine bounds'
      )
    ).toBeTruthy()
    expect(sandboxUi.open).not.toHaveBeenCalled()
  })

  // What main reports when the mounted view's renderer dies.
  function crashOf(embed: EmbedOwnershipMachine, openCall = 0) {
    const { launchId } = sandboxUi.open.mock.calls[openCall]![0] as { launchId: string }
    act(() => embed.onReleased({ launchId, reason: 'crashed', location: null }))
  }

  it('shows a crash of the mounted app with a Reopen that asks the owner to relaunch', async () => {
    sandboxUi.listApps.mockResolvedValue({ apps: [] })
    sandboxUi.open.mockResolvedValue(undefined)
    const embed = createPageEmbed()
    const onRelaunch = vi.fn()

    render(
      <SandboxUiPage
        embed={embed}
        onRelaunch={onRelaunch}
        initialLaunch={{ appRef: 'sandbox-recipes/task-board', label: 'Task', defaultPath: '/' }}
      />
    )
    await screen.findByRole('button', { name: 'Refresh app content' })

    crashOf(embed)

    expect(await screen.findByText('The app closed unexpectedly.')).toBeTruthy()
    expect(screen.queryByTestId('sandbox-ui-mounted')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    expect(onRelaunch).toHaveBeenCalledOnce()
  })

  it("shows the live view's session failure with a Retry that asks the owner to relaunch", async () => {
    sandboxUi.listApps.mockResolvedValue({ apps: [] })
    sandboxUi.open.mockResolvedValue(undefined)
    const onRelaunch = vi.fn()
    const app = { appRef: 'sandbox-recipes/task-board', label: 'Task', defaultPath: '/' }

    const { rerender } = render(<SandboxUiPage onRelaunch={onRelaunch} initialLaunch={app} />)
    await screen.findByRole('button', { name: 'Refresh app content' })
    const { launchId } = sandboxUi.open.mock.calls[0]![0] as { launchId: string }

    // A failure of a view that is not the live one is not shown.
    rerender(
      <SandboxUiPage
        onRelaunch={onRelaunch}
        refreshError={{ launchId: crypto.randomUUID(), message: 'stale' }}
      />
    )
    expect(screen.queryByText(/Session refresh failed/)).toBeNull()

    rerender(
      <SandboxUiPage onRelaunch={onRelaunch} refreshError={{ launchId, message: 'mint failed' }} />
    )
    expect(await screen.findByText('Session refresh failed: mint failed.')).toBeTruthy()
    expect(screen.queryByText(/Close and re-open/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRelaunch).toHaveBeenCalledOnce()
  })

  it('keeps the embed mounted during Strict Mode effect replay', async () => {
    sandboxUi.listApps.mockResolvedValue({
      apps: [
        {
          appRef: 'sandbox-recipes/task-board',
          title: 'Agentic Task Board',
          defaultPath: '/',
          ready: true,
          phase: 'active',
          updatedAt: null,
        },
      ],
    })
    sandboxUi.open.mockResolvedValueOnce(undefined)

    render(
      <React.StrictMode>
        <SandboxUiPage />
      </React.StrictMode>
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Open Agentic Task Board' }))

    // The mounted embed survives StrictMode's double-invoke without tearing down;
    // its leading refresh control is the observable that it stayed mounted.
    expect(await screen.findByRole('button', { name: 'Refresh app content' })).toBeTruthy()
    expect(sandboxUi.open).toHaveBeenCalledOnce()
    expect(sandboxUi.close).not.toHaveBeenCalled()
  })

  it('copies a deep link for the current app route and active team', async () => {
    sandboxUi.listApps.mockResolvedValueOnce({
      apps: [
        {
          appRef: 'sandbox-recipes/sales-crm',
          title: "Andy's Sales CRM",
          defaultPath: '/accounts',
          ready: true,
          phase: 'active',
          updatedAt: null,
        },
      ],
    })
    sandboxUi.open.mockResolvedValueOnce(undefined)
    sandboxUi.copyDeepLink.mockResolvedValueOnce({
      url: 'evenfire://app/sandbox-recipes/sales-crm?path=%2Faccounts&team=team-123',
    })
    const onNotify = vi.fn()

    render(<SandboxUiPage currentTeamId="team-123" onNotify={onNotify} />)

    fireEvent.click(await screen.findByRole('button', { name: "Open Andy's Sales CRM" }))
    fireEvent.click(await screen.findByRole('button', { name: 'Copy current app link' }))

    await waitFor(() => {
      expect(sandboxUi.copyDeepLink).toHaveBeenCalledWith('team-123')
      expect(onNotify).toHaveBeenCalledWith('App link copied to clipboard.', 'success')
    })
  })

  it('reports when resized embedded app bounds are applied', async () => {
    sandboxUi.listApps.mockResolvedValueOnce({
      apps: [
        {
          appRef: 'sandbox-recipes/sales-crm',
          title: "Andy's Sales CRM",
          defaultPath: '/',
          ready: true,
          phase: 'active',
          updatedAt: null,
        },
      ],
    })
    sandboxUi.open.mockResolvedValueOnce(undefined)
    sandboxUi.setBounds.mockResolvedValue(undefined)
    const onEmbedBoundsApplied = vi.fn()

    const { rerender } = render(
      <SandboxUiPage boundsRefreshKey="drawer-closed" onEmbedBoundsApplied={onEmbedBoundsApplied} />
    )

    fireEvent.click(await screen.findByRole('button', { name: "Open Andy's Sales CRM" }))
    await screen.findByTestId('sandbox-ui-mounted')
    onEmbedBoundsApplied.mockClear()

    rerender(
      <SandboxUiPage boundsRefreshKey="drawer-open" onEmbedBoundsApplied={onEmbedBoundsApplied} />
    )

    await waitFor(() => {
      expect(onEmbedBoundsApplied).toHaveBeenCalled()
    })
  })

  it('publishes the measured embed slot top through onEmbedSlotTopChange', async () => {
    sandboxUi.listApps.mockResolvedValueOnce({
      apps: [
        {
          appRef: 'sandbox-recipes/sales-crm',
          title: "Andy's Sales CRM",
          defaultPath: '/',
          ready: true,
          phase: 'active',
          updatedAt: null,
        },
      ],
    })
    sandboxUi.open.mockResolvedValueOnce(undefined)
    const onEmbedSlotTopChange = vi.fn()

    render(<SandboxUiPage onEmbedSlotTopChange={onEmbedSlotTopChange} />)

    fireEvent.click(await screen.findByRole('button', { name: "Open Andy's Sales CRM" }))
    await screen.findByTestId('sandbox-ui-mounted')

    // The slot rect (getBoundingClientRect mock -> top: 12) flows through the real
    // useEmbedBounds push, so the callback fires with Math.round(rect.top) = 12.
    await waitFor(() => {
      expect(onEmbedSlotTopChange).toHaveBeenCalledWith(12)
    })
    const calls = onEmbedSlotTopChange.mock.calls.length

    // A push that measures the same top must NOT re-emit (dedupe against churn).
    fireEvent.scroll(window)
    await new Promise(resolve => window.setTimeout(resolve, 0))
    expect(onEmbedSlotTopChange.mock.calls.length).toBe(calls)
  })

  it('publishes the measured embed slot right edge for the notification drawer rail', async () => {
    sandboxUi.listApps.mockResolvedValueOnce({
      apps: [
        {
          appRef: 'sandbox-recipes/sales-crm',
          title: "Andy's Sales CRM",
          defaultPath: '/',
          ready: true,
          phase: 'active',
          updatedAt: null,
        },
      ],
    })
    sandboxUi.open.mockResolvedValueOnce(undefined)
    const onEmbedSlotRightChange = vi.fn()

    render(<SandboxUiPage onEmbedSlotRightChange={onEmbedSlotRightChange} />)

    fireEvent.click(await screen.findByRole('button', { name: "Open Andy's Sales CRM" }))
    // This branch removed the in-view "Back to apps" button (the sidebar owns the
    // return to apps), so wait on the mounted-page marker as the ready signal.
    await screen.findByTestId('sandbox-ui-mounted')

    // The real slot rect is x=16 and width=400 in this producer-backed fixture.
    await waitFor(() => {
      expect(onEmbedSlotRightChange).toHaveBeenCalledWith(416)
    })
  })

  it('shows an embed preview and hides the native view while shell overlays are open', async () => {
    sandboxUi.listApps.mockResolvedValueOnce({
      apps: [
        {
          appRef: 'sandbox-recipes/sales-crm',
          title: "Andy's Sales CRM",
          defaultPath: '/',
          ready: true,
          phase: 'active',
          updatedAt: null,
        },
      ],
    })
    sandboxUi.open.mockResolvedValueOnce(undefined)
    sandboxUi.capturePreview.mockResolvedValueOnce('data:image/png;base64,abc')

    const { rerender } = render(<SandboxUiPage />)

    fireEvent.click(await screen.findByRole('button', { name: "Open Andy's Sales CRM" }))
    await screen.findByTestId('sandbox-ui-mounted')

    rerender(<SandboxUiPage headerShellOverlayOpen />)

    await waitFor(() => {
      expect(screen.getByTestId('sandbox-ui-embed-preview')).toBeTruthy()
      expect(sandboxUi.setVisible).toHaveBeenLastCalledWith(false)
    })

    let resolveRestore: (() => void) | undefined
    sandboxUi.setVisible.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          resolveRestore = resolve
        })
    )
    rerender(<SandboxUiPage />)

    await waitFor(() => {
      expect(sandboxUi.setVisible).toHaveBeenLastCalledWith(true)
      expect(sandboxUi.setBounds).toHaveBeenLastCalledWith({
        x: 16,
        y: 12,
        width: 400,
        height: 300,
        dpr: expect.any(Number),
      })
    })
    expect(screen.getByTestId('sandbox-ui-embed-preview')).toBeTruthy()

    resolveRestore?.()
    await waitFor(() => {
      expect(screen.queryByTestId('sandbox-ui-embed-preview')).toBeNull()
    })
  })

  it('keeps the native view visible until the toast preview is ready', async () => {
    sandboxUi.listApps.mockResolvedValueOnce({
      apps: [
        {
          appRef: 'sandbox-recipes/sales-crm',
          title: "Andy's Sales CRM",
          defaultPath: '/',
          ready: true,
          phase: 'active',
          updatedAt: null,
        },
      ],
    })
    sandboxUi.open.mockResolvedValueOnce(undefined)
    let resolvePreview: ((value: string | null) => void) | undefined
    sandboxUi.capturePreview.mockReturnValueOnce(
      new Promise<string | null>(resolve => {
        resolvePreview = resolve
      })
    )

    const { rerender } = render(<SandboxUiPage />)

    fireEvent.click(await screen.findByRole('button', { name: "Open Andy's Sales CRM" }))
    await screen.findByTestId('sandbox-ui-mounted')
    await waitFor(() => expect(sandboxUi.setVisible).toHaveBeenLastCalledWith(true))
    sandboxUi.setVisible.mockClear()

    rerender(<SandboxUiPage toastShellOverlayOpen />)

    await waitFor(() => expect(sandboxUi.capturePreview).toHaveBeenCalledTimes(1))
    expect(sandboxUi.setVisible).not.toHaveBeenCalled()
    expect(screen.queryByTestId('sandbox-ui-embed-preview')).toBeNull()

    resolvePreview?.('data:image/png;base64,toast-preview')
    expect(await screen.findByTestId('sandbox-ui-embed-preview')).toBeTruthy()
    await waitFor(() => {
      expect(sandboxUi.setVisible).toHaveBeenLastCalledWith(false)
    })
  })

  it('hides the native view while a deep-link dialog overlay is open and restores it on close', async () => {
    sandboxUi.listApps.mockResolvedValueOnce({
      apps: [
        {
          appRef: 'sandbox-recipes/sales-crm',
          title: "Andy's Sales CRM",
          defaultPath: '/',
          ready: true,
          phase: 'active',
          updatedAt: null,
        },
      ],
    })
    sandboxUi.open.mockResolvedValueOnce(undefined)
    sandboxUi.capturePreview.mockResolvedValueOnce('data:image/png;base64,deeplink')

    const { rerender } = render(<SandboxUiPage />)

    fireEvent.click(await screen.findByRole('button', { name: "Open Andy's Sales CRM" }))
    await screen.findByTestId('sandbox-ui-mounted')
    await waitFor(() => expect(sandboxUi.setVisible).toHaveBeenLastCalledWith(true))
    sandboxUi.setVisible.mockClear()

    // The "Open app link?" / "App link could not be opened" dialogs live in the
    // renderer DOM; without hiding the WebContentsView they render behind the
    // embedded app and the user can never reach the confirm/dismiss buttons.
    rerender(<SandboxUiPage deepLinkShellOverlayOpen />)

    // toHaveBeenLastCalledWith(false) would be satisfied by a stray false->true
    // ->false flicker inside this phase; assert the exact call list (scoped by
    // the mockClear above) so any transient setVisible(true) fails the test.
    await waitFor(() => expect(screen.getByTestId('sandbox-ui-embed-preview')).toBeTruthy())
    // The placeholder shown while the native view is hidden is the captured
    // preview data URL; assert it so the fixture literal is load-bearing.
    expect(screen.getByTestId('sandbox-ui-embed-preview').getAttribute('src')).toBe(
      'data:image/png;base64,deeplink'
    )
    expect(sandboxUi.setVisible.mock.calls).toEqual([[false]])

    sandboxUi.setVisible.mockClear()
    rerender(<SandboxUiPage />)

    await waitFor(() => expect(screen.queryByTestId('sandbox-ui-embed-preview')).toBeNull())
    expect(sandboxUi.setVisible.mock.calls).toEqual([[true]])
  })

  // This test pins the refcount-like behaviour of the overlay OR: two overlays
  // open, closing one keeps the embed hidden, closing the last restores it. It
  // does NOT discriminate the "collapse the whole OR" mutant on its own —
  // `deepLinkShellOverlayOpen` stays true through every phase here, so that
  // mutant is caught by the single-overlay tests above, not by this one. Keep
  // those tests: this one does not subsume them.
  it('keeps the native view hidden until the last of several overlays closes', async () => {
    sandboxUi.listApps.mockResolvedValueOnce({
      apps: [
        {
          appRef: 'sandbox-recipes/sales-crm',
          title: "Andy's Sales CRM",
          defaultPath: '/',
          ready: true,
          phase: 'active',
          updatedAt: null,
        },
      ],
    })
    sandboxUi.open.mockResolvedValueOnce(undefined)
    sandboxUi.capturePreview.mockResolvedValueOnce('data:image/png;base64,multi')

    const { rerender } = render(<SandboxUiPage />)

    fireEvent.click(await screen.findByRole('button', { name: "Open Andy's Sales CRM" }))
    await screen.findByTestId('sandbox-ui-mounted')
    await waitFor(() => expect(sandboxUi.setVisible).toHaveBeenLastCalledWith(true))
    sandboxUi.setVisible.mockClear()

    // Two overlays open at once (a deep-link dialog and a header overlay); the
    // native view must hide exactly once.
    rerender(<SandboxUiPage deepLinkShellOverlayOpen headerShellOverlayOpen />)

    await waitFor(() => expect(screen.getByTestId('sandbox-ui-embed-preview')).toBeTruthy())
    expect(sandboxUi.setVisible.mock.calls).toEqual([[false]])

    // Close only ONE overlay: the OR of the remaining overlays is still true, so
    // the embed stays hidden and setVisible is not called again.
    sandboxUi.setVisible.mockClear()
    rerender(<SandboxUiPage deepLinkShellOverlayOpen />)

    await waitFor(() => expect(sandboxUi.capturePreview).toHaveBeenCalledTimes(1))
    expect(sandboxUi.setVisible).not.toHaveBeenCalled()
    expect(screen.getByTestId('sandbox-ui-embed-preview')).toBeTruthy()

    // Close the last overlay: only now is the native view restored.
    sandboxUi.setVisible.mockClear()
    rerender(<SandboxUiPage />)

    await waitFor(() => expect(screen.queryByTestId('sandbox-ui-embed-preview')).toBeNull())
    expect(sandboxUi.setVisible.mock.calls).toEqual([[true]])
  })

  it('hides the native view without a preview when the capture does not answer in time', async () => {
    sandboxUi.listApps.mockResolvedValue({ apps: [] })
    sandboxUi.open.mockResolvedValue(undefined)
    sandboxUi.capturePreview.mockReturnValue(new Promise<string | null>(() => {}))
    const app = { appRef: 'sandbox-recipes/task-board', label: 'Task', defaultPath: '/' }
    const { rerender } = render(<SandboxUiPage initialLaunch={app} />)
    await screen.findByRole('button', { name: 'Refresh app content' })
    await waitFor(() => expect(sandboxUi.setVisible).toHaveBeenLastCalledWith(true))
    sandboxUi.setVisible.mockClear()

    vi.useFakeTimers()
    try {
      rerender(<SandboxUiPage headerShellOverlayOpen />)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(499)
      })
      expect(sandboxUi.capturePreview).toHaveBeenCalled()
      expect(sandboxUi.setVisible).not.toHaveBeenCalled()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1)
      })
      expect(sandboxUi.setVisible.mock.calls).toEqual([[false]])
      expect(screen.queryByTestId('sandbox-ui-embed-preview')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('hides an active native view even before local launch state is available', async () => {
    sandboxUi.listApps.mockResolvedValueOnce({ apps: [] })
    sandboxUi.capturePreview.mockResolvedValueOnce(null)

    render(<SandboxUiPage headerShellOverlayOpen />)

    await waitFor(() => {
      expect(sandboxUi.setVisible).toHaveBeenCalledWith(false)
    })
  })

  // Main ignores setVisible until the view is attached, then attaches it
  // visible: a hide sent while the app is still opening is lost unless the page
  // repeats it once the view mounts.
  it('hides an app that finishes opening while a shell overlay is already open', async () => {
    sandboxUi.listApps.mockResolvedValue({ apps: [] })
    let finishOpen!: () => void
    sandboxUi.open.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          finishOpen = resolve
        })
    )
    sandboxUi.capturePreview.mockResolvedValue('data:image/png;base64,opened')
    const app = { appRef: 'sandbox-recipes/task-board', label: 'Task', defaultPath: '/' }
    render(<SandboxUiPage toastShellOverlayOpen initialLaunch={app} />)
    await waitFor(() => expect(sandboxUi.open).toHaveBeenCalledOnce())
    await waitFor(() => expect(sandboxUi.setVisible).toHaveBeenCalledWith(false))
    sandboxUi.setVisible.mockClear()

    await act(async () => finishOpen())
    await screen.findByRole('button', { name: 'Refresh app content' })
    await act(async () => {
      await new Promise(resolve => window.setTimeout(resolve, 0))
    })

    expect(sandboxUi.setVisible.mock.calls).toEqual([[false]])
    expect(screen.getByTestId('sandbox-ui-embed-preview').getAttribute('src')).toBe(
      'data:image/png;base64,opened'
    )
  })

  it('hides the replacement view of a relaunch made while a shell overlay is open', async () => {
    sandboxUi.listApps.mockResolvedValue({ apps: [] })
    sandboxUi.capturePreview.mockResolvedValue(null)
    // The relaunch waits for main to release the old view, so main's lifecycle
    // events are needed here; they come from the shared fake, wired the way App
    // wires them.
    const main = createSandboxUiMainFake()
    mainFake = main
    sandboxUi.open.mockImplementation(main.bridge.open)
    sandboxUi.close.mockImplementation(main.bridge.close)
    const embed = createPageEmbed()
    main.bridge.onReleased(event => embed.onReleased(event))
    const app = { appRef: 'sandbox-recipes/task-board', label: 'Task', defaultPath: '/' }
    const { rerender } = render(<SandboxUiPage embed={embed} initialLaunch={app} />)
    await screen.findByRole('button', { name: 'Refresh app content' })
    rerender(<SandboxUiPage embed={embed} headerShellOverlayOpen />)
    await waitFor(() => expect(sandboxUi.setVisible).toHaveBeenLastCalledWith(false))

    const heldOpen = main.holdNextOpen()
    const previous = main.live()
    if (!previous) throw new Error('expected a live view before the relaunch')
    const tabId = embed.getSnapshot().views.get(previous.launchId)?.tabId
    if (!tabId) throw new Error('expected the live view to belong to a tab')
    // The same relaunch App dispatches for Refresh: a new launch on the same tab.
    act(() =>
      embed.relaunch({
        launchId: crypto.randomUUID(),
        tabId,
        appRef: app.appRef,
        route: { kind: 'tab' },
        app: { label: app.label, defaultPath: app.defaultPath },
      })
    )
    await waitFor(() => expect(main.bridge.open).toHaveBeenCalledTimes(2))
    await act(async () => {
      await new Promise(resolve => window.setTimeout(resolve, 0))
    })
    sandboxUi.setVisible.mockClear()

    await act(async () => heldOpen().resolve())
    await screen.findByRole('button', { name: 'Refresh app content' })
    await act(async () => {
      await new Promise(resolve => window.setTimeout(resolve, 0))
    })

    expect(main.live()?.launchId).not.toBe(previous.launchId)
    expect(sandboxUi.setVisible.mock.calls).toEqual([[false]])
  })
})
