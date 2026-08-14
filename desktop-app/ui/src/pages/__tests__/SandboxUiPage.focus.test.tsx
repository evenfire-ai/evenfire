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
  findInPage: vi.fn(),
  stopFindInPage: vi.fn(),
  focusActive: vi.fn(),
  onFindResult: vi.fn(() => vi.fn()),
  onClosed: vi.fn(() => vi.fn()),
  onRefreshError: vi.fn(() => vi.fn()),
}

const apps = [
  {
    appRef: 'sandbox-recipes/sales-crm',
    title: 'Sales CRM',
    defaultPath: '/',
    ready: true,
    phase: 'active',
    updatedAt: null,
  },
]

function installSandboxBridge(): void {
  ;(window as unknown as { clerum: unknown }).clerum = { sandboxUi }
}

async function openApp(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Open Sales CRM' }))
  await screen.findByRole('button', { name: 'Back to apps' })
}

describe('SandboxUiPage contextual-search focus ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sandboxUi.listApps.mockResolvedValue({ apps })
    sandboxUi.open.mockResolvedValue(undefined)
    sandboxUi.close.mockResolvedValue(undefined)
    sandboxUi.setBounds.mockResolvedValue(undefined)
    sandboxUi.setVisible.mockResolvedValue(undefined)
    sandboxUi.capturePreview.mockResolvedValue(null)
    sandboxUi.findInPage.mockResolvedValue({ status: 'started', requestId: 17 })
    sandboxUi.stopFindInPage.mockResolvedValue(undefined)
    sandboxUi.focusActive.mockResolvedValue(true)
    installSandboxBridge()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
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

  it('focuses the committed input on the first request and preserves its query on repeat', async () => {
    const rendered = render(<SandboxUiPage localSearchRequestId={0} />)
    await openApp()

    rendered.rerender(<SandboxUiPage localSearchRequestId={1} />)
    const input = await screen.findByRole('textbox', { name: 'Find in current app' })
    expect(document.activeElement).toBe(input)

    fireEvent.change(input, { target: { value: 'invoice' } })
    screen.getByRole('button', { name: 'Refresh' }).focus()
    rendered.rerender(<SandboxUiPage localSearchRequestId={2} />)

    expect(document.activeElement).toBe(input)
    expect(input).toHaveProperty('value', 'invoice')
  })

  it('stops the find session and restores native app focus when closed', async () => {
    const rendered = render(<SandboxUiPage localSearchRequestId={0} />)
    await openApp()
    rendered.rerender(<SandboxUiPage localSearchRequestId={1} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Close current app search' }))

    await waitFor(() => {
      expect(sandboxUi.stopFindInPage).toHaveBeenCalledOnce()
      expect(sandboxUi.focusActive).toHaveBeenCalledOnce()
    })
    expect(screen.queryByRole('textbox', { name: 'Find in current app' })).toBeNull()
  })

  it('does not replay a stale focus request after the page remounts', async () => {
    const first = render(<SandboxUiPage localSearchRequestId={0} />)
    await openApp()
    first.rerender(<SandboxUiPage localSearchRequestId={1} />)
    await screen.findByRole('textbox', { name: 'Find in current app' })
    first.unmount()

    render(<SandboxUiPage localSearchRequestId={0} />)
    await openApp()
    await new Promise(resolve => window.setTimeout(resolve, 0))

    expect(screen.queryByRole('textbox', { name: 'Find in current app' })).toBeNull()
  })
})
