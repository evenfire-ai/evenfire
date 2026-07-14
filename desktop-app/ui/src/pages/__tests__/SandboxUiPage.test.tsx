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
  setBounds: vi.fn(),
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

  afterEach(() => {
    cleanup()
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

  it('shows an embed preview and parks the native view while shell overlays are open', async () => {
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
      expect(sandboxUi.setBounds).toHaveBeenLastCalledWith({
        x: -10000,
        y: -10000,
        width: 1,
        height: 1,
        dpr: expect.any(Number),
      })
    })

    rerender(<SandboxUiPage />)

    await waitFor(() => {
      expect(sandboxUi.setBounds).toHaveBeenLastCalledWith({
        x: 16,
        y: 12,
        width: 400,
        height: 300,
        dpr: expect.any(Number),
      })
    })
    expect(screen.queryByTestId('sandbox-ui-embed-preview')).toBeNull()
  })
})
