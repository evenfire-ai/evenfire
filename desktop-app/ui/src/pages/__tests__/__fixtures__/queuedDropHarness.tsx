import { useMemo, useState } from 'react'
import { expect, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@contexts/AuthContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { readGfsAccessState } from '@lib/gfsSessionAuthority'
import { desktopQueryDefaults } from '@lib/queryClient'
import {
  affordancesFailureMessage,
  affordancesResult,
  childView,
  gfsRouteFailureMessage,
  heldAffordances,
  listAccessiblePage,
  listChildrenPage,
  resolveResource,
  resolvedDirectory,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import type { Tone } from '@/uiTypes'
import { delegationAffordances } from '../../../../../src/gfs/delegation'
import { FilesPage } from '../../FilesPage'

/**
 * FilesPage opened on "Team folder" inside a mountable harness: the user can
 * leave Files (the page unmounts while its queued runs keep going), come back
 * (a new page instance mounts next to them) and switch session. Only the
 * `window.clerum` boundary is faked; the server-side behaviour of each IPC is
 * supplied by the test.
 */
export const FOLDER_ID = 'folder-1'
export const FOLDER_NAME = 'Team folder'
export const FOLDER_URI = `gfs://main/${FOLDER_ID}`
export const AUTHORITY_FRESH_MS = 15_000

export type UploadReceipt = Awaited<ReturnType<typeof window.clerum.gfs.createFileFromPath>>
type Authority = Awaited<ReturnType<typeof window.clerum.gfs.affordances>>

/**
 * The renderer never reads the upload receipt (the upload runner awaits it
 * and the controller's commit reaction ignores `createFileFromPath`), so no
 * value stands for main's output here.
 */
export const IGNORED_UPLOAD_RECEIPT: UploadReceipt = undefined as never

export interface QueuedDropSession {
  env: number
  teamId: string
  generation: number
}
export interface QueuedDropHarnessState extends QueuedDropSession {
  mounted: boolean
  instance: number
}

export function queuedDropScope({ env, teamId }: Pick<QueuedDropSession, 'env' | 'teamId'>) {
  return `${env === 0 ? '' : `env-${env}`}:user-a:${teamId}`
}

/**
 * What `gfs:affordances` resolves with: main reads the held bits through the
 * real `GfsClient` and projects them with `delegationAffordances`.
 */
async function affordancesIpcResult(bits: string[]): Promise<Authority> {
  const held = await affordancesResult(heldAffordances(bits))
  return structuredClone(delegationAffordances(new Set(held.held), held.isOperator))
}

/** Producer-derived wire values (T1). */
export async function queuedDropFixtures() {
  const createFailure = (status: number, body: { code: string; message: string }) =>
    gfsRouteFailureMessage(
      client =>
        client.createResource(
          { parentResourceId: FOLDER_ID, drive: 'main', name: 'a.txt', kind: 'file' },
          'fixture-session-token'
        ),
      status,
      body
    )
  const unauthorized = { code: 'unauthorized', message: 'session expired' }
  return {
    folder: await resolveResource(resolvedDirectory(FOLDER_ID, FOLDER_NAME)),
    writable: await affordancesIpcResult(['read', 'write']),
    readOnly: await affordancesIpcResult(['read']),
    readFailure: await affordancesFailureMessage(500),
    readUnauthorized: await affordancesFailureMessage(401, unauthorized),
    uploadUnauthorized: await createFailure(401, unauthorized),
    conflict: await createFailure(409, {
      code: 'name_conflict',
      message: 'an item with this name already exists',
    }),
  }
}
export type QueuedDropFixtures = Awaited<ReturnType<typeof queuedDropFixtures>>

export interface QueuedDropIpc {
  affordances: (resourceId: string, drive?: string) => Promise<Authority>
  createFileFromPath: (
    parentResourceId: string,
    name: string,
    filePath: string,
    drive?: string
  ) => Promise<UploadReceipt>
  getSessionGeneration: () => Promise<number>
  createFolder?: typeof window.clerum.gfs.createFolder
  /** Names the folder listing shows (the server's current children). */
  listedNames: () => string[]
  pathForFile?: (file: File) => string | undefined
  onToast?: (message: string, tone: Tone, published: QueuedDropSession) => void
}

export async function settle(rounds = 12) {
  await act(async () => {
    for (let round = 0; round < rounds; round += 1) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  })
}

export async function mountQueuedDropPage(fixtures: QueuedDropFixtures, ipc: QueuedDropIpc) {
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      auth: { getSessionGeneration: ipc.getSessionGeneration },
      gfs: {
        listAccessible: vi.fn(async () => listAccessiblePage([])),
        listChildren: vi.fn(async () =>
          listChildrenPage(
            ipc
              .listedNames()
              .map((name, index) =>
                childView(`listed-${index}`, name, 'file', { parentResourceId: FOLDER_ID })
              )
          )
        ),
        resolve: vi.fn(async (uri: string) => {
          if (uri === FOLDER_URI) return fixtures.folder
          throw new Error(`unexpected resolve ${uri}`)
        }),
        affordances: ipc.affordances,
        listGrants: vi.fn(async () => []),
        listShares: vi.fn(async () => []),
        createFileFromPath: ipc.createFileFromPath,
        createFolder: ipc.createFolder,
        getPathForFile: vi.fn((file: File) => ipc.pathForFile?.(file) ?? `/fixture/${file.name}`),
      },
    },
  })

  const realNow = Date.now.bind(Date)
  let clockOffset = 0
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset)

  const queryClient = new QueryClient({ defaultOptions: desktopQueryDefaults })
  const toasts: Array<[string, Tone]> = []
  let harness: QueuedDropHarnessState = {
    mounted: true,
    instance: 0,
    env: 0,
    teamId: 'team-a',
    generation: 1,
  }
  const pushToast = (message: string, tone: Tone) => {
    toasts.push([message, tone])
    ipc.onToast?.(message, tone, harness)
  }
  let setHarness!: (patch: Partial<QueuedDropHarnessState>) => void
  function Harness() {
    const [state, setState] = useState(harness)
    harness = state
    setHarness = patch => setState(previous => ({ ...previous, ...patch }))
    const auth = useMemo(
      () =>
        ({
          isAuthenticated: true,
          sessionGeneration: state.generation,
          me: {
            id: 'user-a',
            email: 'a@example.test',
            name: 'User A',
            picture: null,
            teamId: state.teamId,
            teamName: state.teamId,
            role: 'member' as const,
          },
          runtimeConfigState: state.env === 0 ? null : { envKey: `env-${state.env}` },
        }) as unknown as AuthContextValue,
      [state.env, state.generation, state.teamId]
    )
    return (
      <AuthContext.Provider value={auth}>
        <QueryClientProvider client={queryClient}>
          {state.mounted ? (
            <FilesPage key={state.instance} pushToast={pushToast} pendingGfsUri={FOLDER_URI} />
          ) : null}
        </QueryClientProvider>
      </AuthContext.Provider>
    )
  }

  const region = () => screen.queryByRole('region', { name: 'EvenDrive browser' })
  const waitReady = async () => {
    const browser = await screen.findByRole('region', { name: 'EvenDrive browser' })
    await waitFor(() =>
      expect(
        queryClient.getQueryData(
          desktopQueryKeys.gfsAffordances(
            queuedDropScope(harness),
            FOLDER_ID,
            'main',
            harness.generation
          )
        )
      ).toBeDefined()
    )
    await waitFor(() => expect(browser.getAttribute('aria-busy')).toBe('false'))
    await settle(6)
  }

  render(<Harness />)
  await waitReady()

  return {
    queryClient,
    toasts,
    harness: () => harness,
    region,
    waitReady,
    drop: (files: File[]) =>
      fireEvent.drop(region()!, {
        dataTransfer: { dropEffect: 'none', files, types: ['Files'] },
      }),
    /** The user leaves Files (sidebar navigation): this FilesPage unmounts. */
    leave: async () => {
      await act(async () => setHarness({ mounted: false }))
    },
    /** Unmount without flushing, to land inside the current task. */
    leaveSync: () => setHarness({ mounted: false }),
    /** The user comes back: a new FilesPage instance mounts next to the orphan runs. */
    enter: async () => {
      await act(async () => setHarness({ mounted: true, instance: harness.instance + 1 }))
    },
    /** The renderer publishes another session (team or environment switch). */
    publishSession: async (patch: Partial<QueuedDropSession>) => {
      await act(async () => setHarness(patch))
    },
    advanceClock: (ms: number) => {
      clockOffset += ms
    },
    accessState: (session: QueuedDropSession) =>
      readGfsAccessState(queryClient, queuedDropScope(session), session.generation),
  }
}

export type QueuedDropPage = Awaited<ReturnType<typeof mountQueuedDropPage>>
