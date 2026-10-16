// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, waitFor } from '@testing-library/react'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { GfsDragSessionProvider, GfsDragSessionStore, useGfsDragSession } from '../dragSession'
import type { GfsDragSource } from '../dragSession.types'

vi.mock('@contexts/AuthContext', () => ({
  useAuthContext: () => authState,
}))

let authState = {
  isAuthenticated: true,
  me: { id: 'user-1', teamId: 'team-1' },
  runtimeConfigState: { envKey: 'test' },
}

function source(overrides: Partial<Omit<GfsDragSource, 'generation'>> = {}) {
  return {
    resourceId: 'r-1',
    gfsUri: 'gfs://main/r1',
    drive: 'main',
    kind: 'file' as const,
    name: 'a.txt',
    version: 2,
    parentKnown: true,
    parentResourceId: 'p-1',
    knownAncestorIds: ['p-1'],
    origin: 'sidebar' as const,
    scope: 'test:user-1:team-1',
    ...overrides,
  }
}

beforeEach(() => {
  authState = {
    isAuthenticated: true,
    me: { id: 'user-1', teamId: 'team-1' },
    runtimeConfigState: { envKey: 'test' },
  }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('GfsDragSessionStore — one active source per session', () => {
  it('begins one drag, refuses a second, and clears on endDrag', () => {
    const store = new GfsDragSessionStore()
    expect(store.beginDrag(source())).toBe(true)
    expect(store.beginDrag(source({ resourceId: 'r-2' }))).toBe(false)
    expect(store.activeSource()?.resourceId).toBe('r-1')
    store.endDrag()
    expect(store.activeSource()).toBeNull()
    // After clearing, a new drag can start with a fresh generation.
    expect(store.beginDrag(source({ resourceId: 'r-2' }))).toBe(true)
    expect(store.activeSource()?.generation).toBeGreaterThan(1)
  })

  it('matches scope only while the same session drag is active', () => {
    const store = new GfsDragSessionStore()
    expect(store.matchesScope('test:user-1:team-1')).toBe(false)
    store.beginDrag(source())
    expect(store.matchesScope('test:user-1:team-1')).toBe(true)
    expect(store.matchesScope('other:user-1:team-1')).toBe(false)
    expect(store.matchesScope(null)).toBe(false)
  })

  it('invalidate clears the source and bumps the generation (race discard)', () => {
    const store = new GfsDragSessionStore()
    store.beginDrag(source())
    const generation = store.activeSource()!.generation
    store.invalidate('authority')
    expect(store.activeSource()).toBeNull()
    expect(store.currentGeneration()).toBeGreaterThan(generation)
  })
})

function Probe({ onApi }: { onApi: (api: ReturnType<typeof useGfsDragSession>) => void }) {
  const api = useGfsDragSession()
  onApi(api)
  return null
}

describe('GfsDragSessionProvider — lifecycle binding', () => {
  it('exposes begin/active/end through context and clears on revoked access state', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let api: ReturnType<typeof useGfsDragSession> | null = null
    render(
      <QueryClientProvider client={queryClient}>
        <GfsDragSessionProvider>
          <Probe onApi={captured => (api = captured)} />
        </GfsDragSessionProvider>
      </QueryClientProvider>
    )
    expect(api).not.toBeNull()
    expect(api!.beginDrag(source())).toBe(true)
    expect(api!.activeSource()?.resourceId).toBe('r-1')

    // The shared fail-closed boundary writes 'revoked' via setQueryData; the
    // provider subscription must clear the active drag in the same turn.
    queryClient.setQueryData(desktopQueryKeys.gfsAccessState('test:user-1:team-1'), 'revoked')
    await waitFor(() => expect(api!.activeSource()).toBeNull())
  })

  it('refuses to begin a drag for a foreign scope', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let api: ReturnType<typeof useGfsDragSession> | null = null
    render(
      <QueryClientProvider client={queryClient}>
        <GfsDragSessionProvider>
          <Probe onApi={captured => (api = captured)} />
        </GfsDragSessionProvider>
      </QueryClientProvider>
    )
    expect(api!.beginDrag(source({ scope: 'other:user-9:' }))).toBe(false)
    expect(api!.activeSource()).toBeNull()
  })
})
