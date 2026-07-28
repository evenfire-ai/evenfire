// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SandboxUiPage } from '../SandboxUiPage'

const sandboxUi = {
  listApps: vi.fn(),
  open: vi.fn(),
  close: vi.fn(),
  reload: vi.fn(),
  copyDeepLink: vi.fn(),
  setBounds: vi.fn(),
  setVisible: vi.fn(),
  capturePreview: vi.fn(),
  onClosed: vi.fn(() => vi.fn()),
  onRefreshError: vi.fn(() => vi.fn()),
}

function installClerumApi(): void {
  ;(window as unknown as { clerum: unknown }).clerum = { sandboxUi }
}

describe('SandboxUiPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sandboxUi.setBounds.mockResolvedValue(undefined)
    sandboxUi.setVisible.mockResolvedValue(undefined)
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
        defaultPath: '/',
        bounds: {
          x: 16,
          y: 12,
          width: 400,
          height: 300,
          dpr: expect.any(Number),
        },
      })
    })
    expect(await screen.findByRole('button', { name: 'Back to apps' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /^Back to / })).toHaveLength(1)
  })

  it('opens a deep-linked app at its stable entry point before handing off the client route', async () => {
    sandboxUi.listApps.mockResolvedValueOnce({ apps: [] })
    sandboxUi.open.mockResolvedValueOnce(undefined)
    const onEmbeddedAppOpening = vi.fn()

    render(
      <SandboxUiPage
        shortcutApp={{
          appRef: 'sandbox-recipes/task-board',
          label: 'Agentic Task Board',
          defaultPath: '/',
          routePath: '/tasks/task-42?panel=details',
        }}
        shortcutOpenRequestId={1}
        onEmbeddedAppOpening={onEmbeddedAppOpening}
      />
    )

    await waitFor(() => {
      expect(sandboxUi.open).toHaveBeenCalledWith({
        recipeNs: 'sandbox-recipes',
        recipeName: 'task-board',
        defaultPath: '/',
        routePath: '/tasks/task-42?panel=details',
        bounds: {
          x: 16,
          y: 12,
          width: 400,
          height: 300,
          dpr: expect.any(Number),
        },
      })
    })
    expect(onEmbeddedAppOpening).toHaveBeenCalledWith({
      appRef: 'sandbox-recipes/task-board',
      label: 'Agentic Task Board',
      defaultPath: '/',
      routePath: '/tasks/task-42?panel=details',
    })
  })

  it('returns to the originating conversation from an app', async () => {
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
    sandboxUi.close.mockResolvedValueOnce(undefined)
    const onBackToConversation = vi.fn()

    render(
      <SandboxUiPage
        conversationOrigin={{
          agentName: 'sales-agent',
          chatId: 'chat-123',
          title: 'Quarterly planning',
        }}
        onBackToConversation={onBackToConversation}
      />
    )

    fireEvent.click(await screen.findByRole('button', { name: "Open Andy's Sales CRM" }))
    fireEvent.click(await screen.findByRole('button', { name: 'Back to Quarterly planning' }))

    await waitFor(() => {
      expect(sandboxUi.close).toHaveBeenCalledTimes(1)
      expect(onBackToConversation).toHaveBeenCalledTimes(1)
    })
  })

  it('keeps the conversation origin during Strict Mode effect replay', async () => {
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
    const onBackToConversation = vi.fn()
    const onEmbeddedAppBack = vi.fn()

    render(
      <React.StrictMode>
        <SandboxUiPage
          conversationOrigin={{
            agentName: 'task-board-agent',
            chatId: 'chat-123',
            title: 'Plan the launch',
          }}
          onBackToConversation={onBackToConversation}
          onEmbeddedAppBack={onEmbeddedAppBack}
        />
      </React.StrictMode>
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Open Agentic Task Board' }))

    expect(await screen.findByRole('button', { name: 'Back to Plan the launch' })).toBeTruthy()
    expect(onEmbeddedAppBack).not.toHaveBeenCalled()
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
    await screen.findByRole('button', { name: 'Back to apps' })
    onEmbedBoundsApplied.mockClear()

    rerender(
      <SandboxUiPage boundsRefreshKey="drawer-open" onEmbedBoundsApplied={onEmbedBoundsApplied} />
    )

    await waitFor(() => {
      expect(onEmbedBoundsApplied).toHaveBeenCalled()
    })
  })

  it('reloads the embed in place when the Refresh button is clicked (no navigate-away needed)', async () => {
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
    sandboxUi.reload.mockResolvedValueOnce(undefined)

    render(<SandboxUiPage />)

    fireEvent.click(await screen.findByRole('button', { name: "Open Andy's Sales CRM" }))
    await screen.findByRole('button', { name: 'Back to apps' })

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))

    await waitFor(() => {
      expect(sandboxUi.reload).toHaveBeenCalledTimes(1)
    })
    // Refresh must NOT tear the embed down (that's the old navigate-away workaround).
    expect(sandboxUi.close).not.toHaveBeenCalled()
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
    await screen.findByRole('button', { name: 'Back to apps' })

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
    await screen.findByRole('button', { name: 'Back to apps' })
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

  it('hides an active native view even before local launch state is available', async () => {
    sandboxUi.listApps.mockResolvedValueOnce({ apps: [] })
    sandboxUi.capturePreview.mockResolvedValueOnce(null)

    render(<SandboxUiPage headerShellOverlayOpen />)

    await waitFor(() => {
      expect(sandboxUi.setVisible).toHaveBeenCalledWith(false)
    })
  })
})
