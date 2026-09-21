// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@contexts/AuthContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { FilesPage } from '../FilesPage'

/**
 * The controller/page seam, which nothing else covers.
 *
 * `FilesPage.test.tsx` mocks `useGfsBrowserController` at module level, so
 * every test in it renders the page against a hand-written controller object.
 * That proves the page renders a `discoveryFailure` it was handed, and the
 * controller suite proves the controller emits one — but nothing proves the
 * two are the same field with the same shape. Rename it on one side and both
 * suites stay green while the user still waits on "Loading files…" forever,
 * which is the exact bug this PR exists to fix.
 *
 * This file therefore renders `FilesPage` against the REAL controller and
 * fakes only `window.clerum.gfs`, the process boundary.
 */

const RATE_LIMITED_IPC_MESSAGE =
  "Error invoking remote method 'gfs:listAccessible': Error: 429 Too Many Requests: " +
  'Too Many Requests retryAfterSeconds=7'

// The controller reads exactly three fields off this context — isAuthenticated,
// me and runtimeConfigState — and FilesPage reads none. The cast keeps the
// double to those three rather than restating forty unrelated auth-screen
// fields that no code under test touches.
const authValue = {
  isAuthenticated: true,
  me: {
    id: 'user-a',
    email: 'a@example.test',
    name: 'User A',
    picture: null,
    teamId: 'team-a',
    teamName: 'Team A',
    role: 'member' as const,
  },
  runtimeConfigState: null,
} as unknown as AuthContextValue

function renderFilesPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <AuthContext.Provider value={authValue}>
      <QueryClientProvider client={queryClient}>
        <FilesPage />
      </QueryClientProvider>
    </AuthContext.Provider>
  )
}

describe('FilesPage against the real GFS browser controller', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('turns a rate-limited discovery rejection into a retryable card, not an endless loader', async () => {
    const listAccessible = vi.fn(async () => {
      throw new Error(RATE_LIMITED_IPC_MESSAGE)
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible,
          resolve: vi.fn(),
          listChildren: vi.fn(async () => ({ items: [], nextCursor: null })),
          affordances: vi.fn(async () => ({
            held: [],
            canDelegate: false,
            grantableBits: [],
            canCreateShare: false,
          })),
        },
      },
    })

    renderFilesPage()

    await waitFor(() => {
      // The reported symptom, asserted first so it is the failure reported
      // when the seam is broken.
      expect(screen.queryByText('Loading files…')).toBeNull()
      // The raw IPC string must never reach the user.
      expect(screen.queryByText(/Error invoking remote method/)).toBeNull()
      // The route assertion: the controller's verdict reached the card with
      // its retry hint intact, across every hop this PR touches.
      expect(screen.getByTestId('gfs-discovery-retry-seconds').textContent).toBe('7')
    })

    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy()

    // Liveness witness: discovery really ran through the real controller, so
    // the absence assertions above describe a rendered failure rather than a
    // page that never got started.
    expect(listAccessible).toHaveBeenCalledTimes(1)
  })
})
