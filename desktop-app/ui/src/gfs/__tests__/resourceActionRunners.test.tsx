// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@contexts/AuthContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from '@testing-library/react'
import { createGfsUploadNameReservationBook } from '@clerum/gfs-interaction-policy'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { useGfsResourceOperations } from '@hooks/domain/useGfsResourceOperations'
import { fetchGfsAuthority, requireFreshGfsPermissions } from '@lib/gfsFreshPermissions'
import type { GfsFreshPermissionsContext } from '@lib/gfsFreshPermissions.types'
import {
  handleGfsAuthorityFailure,
  readGfsAccessState,
  revokeGfsSessionAccess,
} from '@lib/gfsSessionAuthority'
import {
  affordancesFailureMessage,
  childView,
  createFolderResult,
  gfsRouteFailureMessage,
  renameResourceResult,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { delegationAffordances } from '../../../../src/gfs/delegation.js'
import {
  runGfsCreateFolder,
  runGfsDelete,
  runGfsRename,
  runGfsUpload,
} from '../resourceActionRunners'
import type { GfsActionRunnerDeps } from '../resourceActionRunners.types'

const SCOPE = ':user-a:team-a'
const me = {
  id: 'user-a',
  email: 'a@example.test',
  name: 'User A',
  picture: null,
  teamId: 'team-a',
  teamName: 'Team A',
  role: 'member',
}
const auth = {
  isAuthenticated: true,
  me,
  runtimeConfigState: null,
  sessionGeneration: 1,
} as unknown as AuthContextValue

type Affordances = Awaited<ReturnType<typeof delegationAffordances>>

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const writable = () => delegationAffordances(new Set(['read', 'write', 'delete']), false)

interface Harness {
  client: QueryClient
  ops: ReturnType<typeof useGfsResourceOperations>
  bridge: {
    affordances: ReturnType<typeof vi.fn>
    getSessionGeneration: ReturnType<typeof vi.fn>
    createFolder: ReturnType<typeof vi.fn>
    renameResource: ReturnType<typeof vi.fn>
    deleteResource: ReturnType<typeof vi.fn>
    createFileFromPath: ReturnType<typeof vi.fn>
  }
  toasts: string[]
  /** What the renderer has published; a team switch moves main first. */
  published: { generation: number }
  /** The owner's token for this action (the host's active action). */
  owner: { current: boolean }
  deps: () => GfsActionRunnerDeps
  libContext: (gen: number) => GfsFreshPermissionsContext
}

async function harness(
  affordances: (resourceId: string) => Promise<Affordances> = async () => writable()
): Promise<Harness> {
  const created = await createFolderResult('folder-d', childView('new-1', 'Reports', 'directory'))
  const renamed = await renameResourceResult('file-t', 'renamed.txt', 4)
  const bridge = {
    affordances: vi.fn(affordances),
    getSessionGeneration: vi.fn(async () => 1),
    createFolder: vi.fn(async () => created),
    renameResource: vi.fn(async () => renamed),
    deleteResource: vi.fn(async () => undefined),
    createFileFromPath: vi.fn(async () => created),
  }
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      auth: { getSessionGeneration: bridge.getSessionGeneration },
      gfs: {
        affordances: bridge.affordances,
        createFolder: bridge.createFolder,
        renameResource: bridge.renameResource,
        deleteResource: bridge.deleteResource,
        createFileFromPath: bridge.createFileFromPath,
        getPathForFile: (file: File) => `/local/${file.name}`,
      },
    },
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(desktopQueryKeys.gfsAccessState(SCOPE, 1), 'active')
  let ops!: ReturnType<typeof useGfsResourceOperations>
  function Probe() {
    ops = useGfsResourceOperations()
    return null
  }
  render(
    <AuthContext.Provider value={auth}>
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>
    </AuthContext.Provider>
  )
  const toasts: string[] = []
  const published = { generation: 1 }
  const owner = { current: true }
  // The library judges only the published session here, never the access
  // flag or the owner's token, so the runner's own checks are what stand
  // between those events and the mutation.
  const libContext = (gen: number): GfsFreshPermissionsContext => ({
    queryClient: client,
    handleAuthorityFailure: (error, scope, generation) =>
      handleGfsAuthorityFailure(
        client,
        scope,
        generation,
        error instanceof Error ? error.message : String(error),
        'operation',
        { scope: SCOPE, generation: published.generation }
      ) !== 'not-authority',
    pushToast: message => toasts.push(message),
    isCurrent: () => published.generation === gen,
  })
  const deps = (): GfsActionRunnerDeps => {
    const gen = published.generation
    return {
      ops,
      freshPermissions: (resourceId, resourceName, bits) =>
        requireFreshGfsPermissions(
          { scope: SCOPE, gen, resourceId, resourceName, bits },
          libContext(gen)
        ),
      readAccessState: () => readGfsAccessState(client, SCOPE, published.generation),
      publishedGeneration: () => published.generation,
      isCurrent: () => owner.current,
    }
  }
  return { client, ops, bridge, toasts, published, owner, deps, libContext }
}

const target = { resourceId: 'file-t', name: 'notes.txt', version: 3 }
const folder = { resourceId: 'folder-d', name: 'Docs' }
const revoke = (h: Harness) => revokeGfsSessionAccess(h.client, SCOPE, 1)
const mutationCalls = (h: Harness) =>
  h.bridge.createFolder.mock.calls.length +
  h.bridge.renameResource.mock.calls.length +
  h.bridge.deleteResource.mock.calls.length +
  h.bridge.createFileFromPath.mock.calls.length

afterEach(() => {
  cleanup()
  delete (window as { clerum?: unknown }).clerum
})

describe('requireFreshGfsPermissions', () => {
  it('revokes the session when the affordances read answers 401', async () => {
    const message = await affordancesFailureMessage(401, {
      code: 'unauthorized',
      message: 'session expired',
    })
    const h = await harness(async () => {
      throw new Error(message)
    })

    const authority = await requireFreshGfsPermissions(
      { scope: SCOPE, gen: 1, resourceId: 'file-t', resourceName: 'notes.txt', bits: ['write'] },
      h.libContext(1)
    )

    expect(h.bridge.affordances).toHaveBeenCalledTimes(1)
    expect(authority).toBeNull()
    expect(readGfsAccessState(h.client, SCOPE, 1)).toBe('revoked')
    expect(h.toasts).toEqual([])
  })

  it('toasts no permission verdict into the session that replaced the request', async () => {
    const read = deferred<Affordances>()
    const h = await harness(() => read.promise)

    const pending = requireFreshGfsPermissions(
      { scope: SCOPE, gen: 1, resourceId: 'file-t', resourceName: 'notes.txt', bits: ['write'] },
      h.libContext(1)
    )
    h.published.generation = 2
    read.resolve(await delegationAffordances(new Set(['read']), false))

    expect(await pending).toBeNull()
    expect(h.bridge.affordances).toHaveBeenCalledTimes(1)
    expect(h.toasts).toEqual([])
  })

  it('hands no authority read to a caller whose session was replaced', async () => {
    const read = deferred<Affordances>()
    const h = await harness(() => read.promise)

    const pending = fetchGfsAuthority(
      { scope: SCOPE, gen: 1, resourceId: 'file-t', resourceName: 'notes.txt' },
      h.libContext(1)
    )
    h.published.generation = 2
    read.resolve(await writable())

    expect(await pending).toBeNull()
    expect(h.bridge.affordances).toHaveBeenCalledTimes(1)
  })

  it('toasts no read failure into the session that replaced the request', async () => {
    const message = await affordancesFailureMessage(500)
    const read = deferred<Affordances>()
    const h = await harness(() => read.promise)

    const pending = fetchGfsAuthority(
      { scope: SCOPE, gen: 1, resourceId: 'file-t', resourceName: 'notes.txt' },
      h.libContext(1)
    )
    h.published.generation = 2
    read.reject(new Error(message))

    expect(await pending).toBeNull()
    expect(h.bridge.affordances).toHaveBeenCalledTimes(1)
    expect(h.toasts).toEqual([])
  })

  it('stays quiet on a cached denial once the request is no longer current', async () => {
    const h = await harness(async () => delegationAffordances(new Set(['read']), false))
    const request = {
      scope: SCOPE,
      gen: 1,
      resourceId: 'file-t',
      resourceName: 'notes.txt',
      bits: ['write'],
    }
    expect(await requireFreshGfsPermissions(request, h.libContext(1))).toBeNull()
    expect(h.toasts).toEqual(['You do not have write access to notes.txt.'])

    h.published.generation = 2
    expect(await requireFreshGfsPermissions(request, h.libContext(1))).toBeNull()
    expect(h.bridge.affordances).toHaveBeenCalledTimes(1)
    expect(h.toasts).toEqual(['You do not have write access to notes.txt.'])
  })
})

describe('GFS action runners', () => {
  const runners = {
    rename: (deps: GfsActionRunnerDeps) => runGfsRename(deps, target, 'renamed.txt'),
    'create folder': (deps: GfsActionRunnerDeps) => runGfsCreateFolder(deps, folder, 'Reports'),
    delete: (deps: GfsActionRunnerDeps) => runGfsDelete(deps, target),
    upload: (deps: GfsActionRunnerDeps) =>
      runGfsUpload(
        deps,
        folder,
        new File(['x'], 'report.txt'),
        new Set(),
        createGfsUploadNameReservationBook()
      ),
  }

  for (const [label, run] of Object.entries(runners)) {
    it(`${label}: commits once when the session stays current`, async () => {
      const h = await harness()
      const result = await run(h.deps())
      expect(result.status).toBe('done')
      expect(mutationCalls(h)).toBe(1)
    })

    it(`${label}: sends no mutation when the owner moves on during the permission read`, async () => {
      const read = deferred<Affordances>()
      const h = await harness(() => read.promise)
      const pending = run(h.deps())
      await vi.waitFor(() => expect(h.bridge.affordances).toHaveBeenCalledTimes(1))
      // The library only judges the session, so it still answers: the
      // runner's own guard is what stops the mutation.
      h.owner.current = false
      read.resolve(await writable())

      expect((await pending).status).toBe('aborted')
      expect(mutationCalls(h)).toBe(0)
    })

    it(`${label}: sends no mutation after a same-generation revocation with no render in between`, async () => {
      const h = await harness()
      await requireFreshGfsPermissions(
        { scope: SCOPE, gen: 1, resourceId: 'file-t', resourceName: 'notes.txt', bits: [] },
        h.libContext(1)
      )
      await requireFreshGfsPermissions(
        { scope: SCOPE, gen: 1, resourceId: 'folder-d', resourceName: 'Docs', bits: [] },
        h.libContext(1)
      )
      revoke(h)
      const result = await run(h.deps())

      expect(result.status).toBe('aborted')
      expect(mutationCalls(h)).toBe(0)
    })

    it(`${label}: sends no mutation when main already runs the next session`, async () => {
      const h = await harness()
      h.bridge.getSessionGeneration.mockResolvedValue(2)
      const result = await run(h.deps())

      expect(result.status).toBe('aborted')
      expect(h.bridge.affordances).toHaveBeenCalled()
      expect(h.bridge.getSessionGeneration).toHaveBeenCalled()
      expect(mutationCalls(h)).toBe(0)
    })

    it(`${label}: sends no mutation after a logout clears the cache mid-check`, async () => {
      const read = deferred<Affordances>()
      const h = await harness(() => read.promise)
      const pending = run(h.deps())
      await vi.waitFor(() => expect(h.bridge.affordances).toHaveBeenCalledTimes(1))
      h.client.clear()
      read.resolve(await writable())

      expect((await pending).status).toBe('aborted')
      expect(mutationCalls(h)).toBe(0)
    })
  }

  it('create folder: reports the confirmed permission only when it was granted', async () => {
    const granted = await harness()
    const onGranted = vi.fn()
    await runGfsCreateFolder(granted.deps(), folder, 'Reports', { onPermitted: onGranted })
    expect(onGranted).toHaveBeenCalledTimes(1)
    cleanup()

    const denied = await harness(async () => delegationAffordances(new Set(['read']), false))
    const onDenied = vi.fn()
    const result = await runGfsCreateFolder(denied.deps(), folder, 'Reports', {
      onPermitted: onDenied,
    })
    expect(result.status).toBe('aborted')
    expect(denied.toasts).toEqual(['You do not have write access to Docs.'])
    expect(onDenied).not.toHaveBeenCalled()
  })

  it('upload: a revocation between name retries stops the next create', async () => {
    const conflict = await gfsRouteFailureMessage(
      client =>
        client.createResource(
          { parentResourceId: 'folder-d', drive: 'main', name: 'report.txt', kind: 'file' },
          'fixture-session-token'
        ),
      409,
      { code: 'name_conflict', message: 'an item with this name already exists' }
    )
    const h = await harness()
    h.bridge.createFileFromPath.mockImplementation(async () => {
      revoke(h)
      throw new Error(conflict)
    })

    const result = await runners.upload(h.deps())

    expect(h.bridge.createFileFromPath).toHaveBeenCalledTimes(1)
    expect(h.bridge.createFileFromPath).toHaveBeenCalledWith(
      'folder-d',
      'report.txt',
      '/local/report.txt',
      'main'
    )
    expect(result.status).toBe('aborted')
  })

  it('upload: a name conflict retries under the next free name while current', async () => {
    const conflict = await gfsRouteFailureMessage(
      client =>
        client.createResource(
          { parentResourceId: 'folder-d', drive: 'main', name: 'report.txt', kind: 'file' },
          'fixture-session-token'
        ),
      409,
      { code: 'name_conflict', message: 'an item with this name already exists' }
    )
    const h = await harness()
    h.bridge.createFileFromPath.mockRejectedValueOnce(new Error(conflict))

    const result = await runners.upload(h.deps())

    expect(h.bridge.createFileFromPath).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ status: 'done', value: { name: 'report (1).txt' } })
  })
})
