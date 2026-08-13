// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { usePluginPermissionsController } from '../usePluginPermissionsController'

type PluginSdkMock = {
  listGrants: ReturnType<typeof vi.fn>
  activity: ReturnType<typeof vi.fn>
  revoke: ReturnType<typeof vi.fn>
  clearActivity: ReturnType<typeof vi.fn>
}

function installPluginSdk(overrides: Partial<PluginSdkMock> = {}): PluginSdkMock {
  const sdk: PluginSdkMock = {
    listGrants: vi.fn(async () => []),
    activity: vi.fn(async () => []),
    revoke: vi.fn(async () => undefined),
    clearActivity: vi.fn(async () => undefined),
    ...overrides,
  }
  Object.defineProperty(window, 'clerum', { configurable: true, value: { pluginSdk: sdk } })
  return sdk
}

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
}

describe('usePluginPermissionsController', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    delete (window as { clerum?: unknown }).clerum
  })

  it('surfaces a failed revoke in the error banner, labeled (R1-M4)', async () => {
    installPluginSdk({
      revoke: vi.fn(async () => {
        throw new Error('revoke failed')
      }),
    })
    const { result } = renderHook(() => usePluginPermissionsController(), {
      wrapper: makeWrapper(),
    })
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.revoke('ns/plugin').catch(() => undefined)
    })
    // The security action used to fail silently; the banner must show it, labeled.
    await waitFor(() => expect(result.current.error).toBe('Failed to revoke access: revoke failed'))
  })

  // Both masking directions: one action's success must never wipe the OTHER
  // action's genuine failure, and the label keeps them unambiguous.
  it('a successful revoke does not mask a prior clear-activity failure (R2-M1)', async () => {
    installPluginSdk({
      clearActivity: vi.fn(async () => {
        throw new Error('clear failed')
      }),
    })
    const { result } = renderHook(() => usePluginPermissionsController(), {
      wrapper: makeWrapper(),
    })
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.clearActivity().catch(() => undefined)
    })
    await waitFor(() =>
      expect(result.current.error).toBe('Failed to clear the activity log: clear failed')
    )

    // A later SUCCESSFUL revoke must not wipe (or be misread as) the clear failure.
    await act(async () => {
      await result.current.revoke('ns/plugin')
    })
    await waitFor(() =>
      expect(result.current.error).toBe('Failed to clear the activity log: clear failed')
    )
    expect(result.current.error).not.toContain('revoke')
  })

  it('a successful clear-activity does not mask a prior revoke failure (R3-M1)', async () => {
    installPluginSdk({
      revoke: vi.fn(async () => {
        throw new Error('revoke failed')
      }),
    })
    const { result } = renderHook(() => usePluginPermissionsController(), {
      wrapper: makeWrapper(),
    })
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.revoke('ns/plugin').catch(() => undefined)
    })
    await waitFor(() => expect(result.current.error).toBe('Failed to revoke access: revoke failed'))

    // A later SUCCESSFUL clear-activity must not wipe the revoke failure.
    await act(async () => {
      await result.current.clearActivity()
    })
    await waitFor(() => expect(result.current.error).toBe('Failed to revoke access: revoke failed'))
  })
})
