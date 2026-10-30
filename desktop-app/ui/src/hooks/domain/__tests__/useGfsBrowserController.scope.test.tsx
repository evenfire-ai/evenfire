// @vitest-environment jsdom
import { type ReactNode, useLayoutEffect, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@contexts/AuthContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  listAccessiblePage,
  listChildrenPage,
  resolveResource,
  resolvedDirectory,
  resourceAffordances,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { useGfsBrowserController } from '../useGfsBrowserController'

const USER_A = {
  id: 'scope-user',
  email: 'scope@example.test',
  name: 'Scope User',
  picture: null,
  teamId: 'team-a',
  teamName: 'Team A',
  role: 'member' as const,
}

function ScopeProbe({ uri }: { uri: string }) {
  const ctrl = useGfsBrowserController()
  const [result, setResult] = useState('not-started')
  return (
    <>
      <div data-testid="scope-result">{result}</div>
      <div data-testid="scope-crumbs">{ctrl.crumbs.map(crumb => crumb.name).join('/')}</div>
      <button
        type="button"
        onClick={() =>
          void ctrl.openUri(uri).then(opened => {
            setResult(
              opened === false
                ? 'cancelled'
                : `opened:${opened.originatingSessionScope ?? 'unscoped'}`
            )
          })
        }
      >
        Open delayed GFS resource
      </button>
    </>
  )
}

function ScopeRaceHarness({
  children,
  onTeamBLayoutCommit,
}: {
  children: ReactNode
  onTeamBLayoutCommit: () => void
}) {
  const [me, setMe] = useState(USER_A)
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
  )
  useLayoutEffect(() => {
    if (me.teamId === 'team-b') onTeamBLayoutCommit()
  }, [me.teamId, onTeamBLayoutCommit])

  const auth = {
    isAuthenticated: true,
    sessionGeneration: 1,
    me,
    runtimeConfigState: null,
  } as AuthContextValue

  return (
    <AuthContext.Provider value={auth}>
      <QueryClientProvider client={queryClient}>
        {children}
        <button type="button" onClick={() => setMe({ ...USER_A, teamId: 'team-b' })}>
          Switch to Team B
        </button>
      </QueryClientProvider>
    </AuthContext.Provider>
  )
}

describe('useGfsBrowserController authorization-scope continuations', () => {
  afterEach(() => {
    cleanup()
    delete (window as { clerum?: unknown }).clerum
    vi.restoreAllMocks()
  })

  it('drops a delayed URI resolve completed during the new scope commit', async () => {
    const resource = await resolveResource(
      resolvedDirectory('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Team A folder')
    )
    let finishResolve!: (value: typeof resource) => void
    const delayedResolve = new Promise<typeof resource>(resolve => {
      finishResolve = resolve
    })
    const resolve = vi.fn((uri: string) => {
      if (uri !== resource.gfsUri) throw new Error(`Unexpected resolve: ${uri}`)
      return delayedResolve
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => listAccessiblePage([])),
          listChildren: vi.fn(async () => listChildrenPage([])),
          resolve,
          affordances: vi.fn(async () => resourceAffordances(['read'])),
        },
      },
    })

    render(
      <ScopeRaceHarness onTeamBLayoutCommit={() => finishResolve(resource)}>
        <ScopeProbe uri={resource.gfsUri} />
      </ScopeRaceHarness>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open delayed GFS resource' }))
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(resource.gfsUri))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Switch to Team B' }))
      await delayedResolve
    })

    await waitFor(() => expect(screen.getByTestId('scope-result').textContent).toBe('cancelled'))
    expect(screen.getByTestId('scope-crumbs').textContent).toBe('')
  })

  it('drops a partially resolved breadcrumb chain when an ancestor finishes after a scope change', async () => {
    const parentId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const parent = await resolveResource(resolvedDirectory(parentId, 'Team A parent'))
    const leaf = await resolveResource(
      resolvedDirectory('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Team A child', {
        parentResourceId: parentId,
      })
    )
    let finishParent!: (value: typeof parent) => void
    const delayedParent = new Promise<typeof parent>(resolve => {
      finishParent = resolve
    })
    const resolve = vi.fn((uri: string) => {
      if (uri === leaf.gfsUri) return Promise.resolve(leaf)
      if (uri === parent.gfsUri) return delayedParent
      throw new Error(`Unexpected resolve: ${uri}`)
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => listAccessiblePage([])),
          listChildren: vi.fn(async () => listChildrenPage([])),
          resolve,
          affordances: vi.fn(async () => resourceAffordances(['read'])),
        },
      },
    })

    render(
      <ScopeRaceHarness onTeamBLayoutCommit={() => finishParent(parent)}>
        <ScopeProbe uri={leaf.gfsUri} />
      </ScopeRaceHarness>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open delayed GFS resource' }))
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(parent.gfsUri))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Switch to Team B' }))
      await delayedParent
    })

    await waitFor(() => expect(screen.getByTestId('scope-result').textContent).toBe('cancelled'))
    expect(screen.getByTestId('scope-crumbs').textContent).toBe('')
  })
})
