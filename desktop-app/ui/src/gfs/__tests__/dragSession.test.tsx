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
  it('supersedes a stale same-session source with the next trusted gesture', () => {
    // A lost dragend (detached-node dragend after a listing refresh) leaves
    // the old source active. The next same-session gesture must OWN the
    // session — refusing it would leave the stale source adjudicating the
    // new gesture's drop (wrong-resource move).
    const store = new GfsDragSessionStore()
    expect(store.beginDrag(source())).toBe(true)
    const stale = store.activeSource()
    expect(store.beginDrag(source({ resourceId: 'r-2', name: 'b.txt' }))).toBe(true)
    const active = store.activeSource()
    expect(active?.resourceId).toBe('r-2')
    expect(active?.generation).toBeGreaterThan(stale?.generation ?? 0)
    store.endDrag()
    expect(store.activeSource()).toBeNull()
    // After clearing, a new drag can start with a fresh generation.
    expect(store.beginDrag(source({ resourceId: 'r-3' }))).toBe(true)
    expect(store.activeSource()?.generation).toBeGreaterThan(active?.generation ?? 0)
  })

  it('refuses a foreign-session gesture and keeps the active source', () => {
    const store = new GfsDragSessionStore()
    store.beginDrag(source())
    expect(store.beginDrag(source({ scope: 'other:user-9:team-9' }))).toBe(false)
    expect(store.activeSource()?.resourceId).toBe('r-1')
    // The refused gesture did not consume a generation.
    expect(store.beginDrag(source({ resourceId: 'r-2' }))).toBe(true)
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

  for (const [dimension, nextScope] of [
    ['team', 'test:user-1:team-2'],
    ['user', 'test:user-2:team-1'],
    ['environment', 'other:user-1:team-1'],
  ] as const) {
    for (const nativeEnded of [false, true]) {
      it(`invalidates ${dimension} scope changes with native end ${nativeEnded}`, () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        let api: ReturnType<typeof useGfsDragSession> | null = null
        const view = () => (
          <QueryClientProvider client={queryClient}>
            <GfsDragSessionProvider>
              <Probe onApi={captured => (api = captured)} />
            </GfsDragSessionProvider>
          </QueryClientProvider>
        )
        const mounted = render(view())
        expect(api!.beginDrag(source())).toBe(true)
        const admittedGeneration = api!.currentGeneration()
        if (nativeEnded) {
          api!.endDrag()
          expect(api!.activeSource()).toBeNull()
          // Native end preserves an admitted drop until authority changes.
          expect(api!.currentGeneration()).toBe(admittedGeneration)
        }
        authState = {
          ...authState,
          me: {
            ...authState.me,
            ...(dimension === 'team' ? { teamId: 'team-2' } : {}),
            ...(dimension === 'user' ? { id: 'user-2' } : {}),
          },
          runtimeConfigState: { envKey: dimension === 'environment' ? 'other' : 'test' },
        }
        mounted.rerender(view())
        expect(api!.activeSource()).toBeNull()
        expect(api!.currentGeneration()).toBeGreaterThan(admittedGeneration)
        expect(api!.beginDrag(source({ resourceId: 'r-2', scope: nextScope }))).toBe(true)
        expect(api!.activeSource()?.resourceId).toBe('r-2')
        const newGeneration = api!.currentGeneration()
        expect(api!.beginDrag(source())).toBe(false)
        expect(api!.currentGeneration()).toBe(newGeneration)
        expect(api!.activeSource()?.resourceId).toBe('r-2')
      })
    }
  }

  it('invalidates on logout and unmount while refusing further drags', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let api: ReturnType<typeof useGfsDragSession> | null = null
    const view = () => (
      <QueryClientProvider client={queryClient}>
        <GfsDragSessionProvider>
          <Probe onApi={captured => (api = captured)} />
        </GfsDragSessionProvider>
      </QueryClientProvider>
    )
    const mounted = render(view())
    expect(api!.beginDrag(source())).toBe(true)
    const generation = api!.currentGeneration()
    authState = { ...authState, isAuthenticated: false }
    mounted.rerender(view())
    expect(api!.activeSource()).toBeNull()
    expect(api!.currentGeneration()).toBeGreaterThan(generation)
    expect(api!.beginDrag(source())).toBe(false)
    const loggedOutGeneration = api!.currentGeneration()
    mounted.unmount()
    expect(api!.currentGeneration()).toBeGreaterThan(loggedOutGeneration)
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

  it('supersedes a stale same-session drag through the provider guards', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let api: ReturnType<typeof useGfsDragSession> | null = null
    render(
      <QueryClientProvider client={queryClient}>
        <GfsDragSessionProvider>
          <Probe onApi={captured => (api = captured)} />
        </GfsDragSessionProvider>
      </QueryClientProvider>
    )
    expect(api!.beginDrag(source())).toBe(true)
    // Lost dragend: the stale source lingers. The next trusted same-session
    // gesture passes the provider guards and takes ownership of the session.
    expect(api!.beginDrag(source({ resourceId: 'r-2' }))).toBe(true)
    expect(api!.activeSource()?.resourceId).toBe('r-2')
  })
})
