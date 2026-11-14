// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@contexts/AuthContext'
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { desktopQueryDefaults } from '@lib/queryClient'
import { accessibleResource, listAccessiblePage } from '@/gfs/__fixtures__/gfsProducerFixtures'
import { FilesPage } from '../FilesPage'

const authValue = {
  isAuthenticated: true,
  sessionGeneration: 1,
  me: {
    id: 'user-a',
    email: 'user-a@example.test',
    name: 'User A',
    picture: null,
    teamId: 'team-a',
    teamName: 'Team A',
    role: 'member',
  },
  runtimeConfigState: { envKey: 'desktop-test' },
} as unknown as AuthContextValue

function providers(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <AuthContext.Provider value={authValue}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </AuthContext.Provider>
  )
}

function checkingAnnouncements(): HTMLElement[] {
  return screen
    .queryAllByRole('status')
    .filter(element => element.textContent?.includes('Checking permissions for'))
}

afterEach(() => {
  cleanup()
  focusManager.setFocused(undefined)
  vi.restoreAllMocks()
  delete (window as { clerum?: unknown }).clerum
})

describe('FilesPage shared-root permission announcements', () => {
  it('does not announce a cached shared-root refresh once per row on repeated focus', async () => {
    const resources = await listAccessiblePage(
      Array.from({ length: 20 }, (_, index) =>
        accessibleResource(`shared-${index}`, `Shared ${index}`, 'file', {
          permissions: ['read'],
        })
      )
    )
    const releases: Array<(page: typeof resources) => void> = []
    const listAccessible = vi.fn(async () => {
      if (listAccessible.mock.calls.length === 1) return resources
      return new Promise<typeof resources>(resolve => releases.push(resolve))
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: { auth: { getSessionGeneration: vi.fn(async () => 1) }, gfs: { listAccessible } },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    render(<FilesPage />, { wrapper: providers(client) })
    await screen.findByRole('button', { name: 'Open Shared 0' })
    await waitFor(() => expect(listAccessible).toHaveBeenCalledTimes(1))
    expect(checkingAnnouncements()).toHaveLength(0)

    for (const expectedCallCount of [2, 3]) {
      act(() => {
        focusManager.setFocused(false)
        focusManager.setFocused(true)
      })
      await waitFor(() => expect(listAccessible).toHaveBeenCalledTimes(expectedCallCount))
      await waitFor(() => expect(checkingAnnouncements()).toHaveLength(0))
      expect(screen.getAllByRole('button', { name: /^Open Shared/ })).toHaveLength(20)

      await act(async () => {
        releases.shift()?.(resources)
      })
      await waitFor(() => expect(checkingAnnouncements()).toHaveLength(0))
    }

    expect(listAccessible).toHaveBeenCalledTimes(3)
    client.clear()
  })
})
