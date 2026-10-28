// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { PluginAuditEntryView, PluginGrantView } from '../../../../../src/pluginSdkProtocol'
import { installAntdDomEnvironment } from '../../../test/antdDomEnvironment'
import { PluginPermissions } from '../index'

function makeGrant(overrides: Partial<PluginGrantView> = {}): PluginGrantView {
  return {
    pluginId: 'acme/repository-reader',
    pluginTitle: 'Repository Reader',
    capability: 'workspace.read',
    title: 'Read workspace files',
    dataDescription: 'File names and contents in the selected workspace.',
    tier: 'workspace',
    grantedAt: '2026-10-20T09:00:00.000Z',
    lastUsedAt: '2026-10-27T09:00:00.000Z',
    ...overrides,
  }
}

function installPluginSdk({
  grants = [makeGrant()],
  activity = [],
  listGrantsError,
}: {
  grants?: PluginGrantView[]
  activity?: PluginAuditEntryView[]
  listGrantsError?: Error
} = {}) {
  const sdk = {
    listGrants: vi.fn(async () => {
      if (listGrantsError) throw listGrantsError
      return grants
    }),
    activity: vi.fn(async () => activity),
    revoke: vi.fn(async () => undefined),
    clearActivity: vi.fn(async () => undefined),
  }
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: { pluginSdk: sdk },
  })
  return sdk
}

function renderPluginPermissions() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <PluginPermissions />
    </QueryClientProvider>
  )
}

describe('PluginPermissions', () => {
  beforeEach(() => {
    installAntdDomEnvironment()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    delete (window as { clerum?: unknown }).clerum
  })

  it('expands a plugin grant and sends per-capability revoke to the controller', async () => {
    const grant = makeGrant()
    const sdk = installPluginSdk({ grants: [grant] })
    let resolveRevoke: (() => void) | undefined
    sdk.revoke.mockImplementation(
      () =>
        new Promise<undefined>(resolve => {
          resolveRevoke = () => resolve(undefined)
        })
    )
    renderPluginPermissions()

    const pluginButton = await screen.findByRole('button', { name: 'Repository Reader' })
    expect(pluginButton.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(pluginButton)

    expect(pluginButton.getAttribute('aria-expanded')).toBe('true')
    expect(
      await screen.findByText('File names and contents in the selected workspace.')
    ).toBeTruthy()
    expect(document.getElementById(pluginButton.getAttribute('aria-controls') || '')).not.toBeNull()

    const revokeButton = screen.getByRole('button', { name: 'Revoke' })
    fireEvent.click(revokeButton)
    try {
      await waitFor(
        () => {
          expect(sdk.revoke).toHaveBeenCalledWith(grant.pluginId, grant.capability)
          expect(revokeButton.hasAttribute('disabled')).toBe(true)
        },
        { timeout: 2000 }
      )
    } finally {
      resolveRevoke?.()
    }
    await waitFor(
      () => {
        expect(revokeButton.hasAttribute('disabled')).toBe(false)
      },
      { timeout: 2000 }
    )
  })

  it('renders activity outcomes and clears the log through the controller', async () => {
    const user = userEvent.setup()
    const sdk = installPluginSdk({
      grants: [],
      activity: [
        {
          ts: '2026-10-27T09:00:00.000Z',
          userId: 'user-1',
          pluginId: 'acme/repository-reader',
          capability: 'workspace.read',
          outcome: 'denied',
        },
      ],
    })
    renderPluginPermissions()

    await user.click(screen.getByRole('tab', { name: 'Activity' }))

    expect(await screen.findByText('workspace.read')).toBeTruthy()
    expect(screen.getByText('Denied')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Clear activity log' }))
    await waitFor(() => expect(sdk.clearActivity).toHaveBeenCalledTimes(1))
  })

  it('surfaces a grant-loading failure as an alert', async () => {
    installPluginSdk({ grants: [], listGrantsError: new Error('permissions unavailable') })
    renderPluginPermissions()

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText('permissions unavailable')).toBeTruthy()
  })
})
