import { useEffect, useMemo, useState } from 'react'
import { expect, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@contexts/AuthContext'
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { GfsActionHost } from '@components/GfsActionHost'
import { useGfsActionHost } from '@components/GfsActionHost/context'
import type {
  GfsActionHostContextValue,
  GfsHostActionTarget,
} from '@components/GfsActionHost/types'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { useGfsBrowserController } from '@hooks/domain/useGfsBrowserController'
import { readGfsAccessState, revokeGfsSessionAccess } from '@lib/gfsSessionAuthority'
import { purgeGfsSessionCache } from '@lib/gfsWatchReaction'
import { desktopQueryDefaults } from '@lib/queryClient'
import {
  accessibleResource,
  affordancesFailureMessage,
  affordancesResult,
  gfsRouteFailureMessage,
  grantsListPage,
  heldAffordances,
  listAccessiblePage,
  listChildrenPage,
  resolveResource,
  resolvedDirectory,
  sharesListPage,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import type { Tone } from '@/uiTypes'
import { delegationAffordances } from '../../../../../src/gfs/delegation'
import type { TeamDirectoryResult } from '../../../../../src/types'
import { FilesPage } from '../../FilesPage'

/**
 * Share dialog on "Folder A", whose member user-2 inherits Editor from two
 * ancestor folders ("Team folder" → "Root share") and also holds a direct
 * Read grant on Folder A. A confirmed removal writes three revokes (two
 * ancestors, then the direct grant); a confirmed downgrade to Read writes three
 * grants (two ancestors, then the direct alignment).
 */
export const SESSION_SCOPE = ':user-a:team-a'
export const SESSION_GENERATION = 1
export const TARGET_ID = 'folder-a'
export const PARENT_ONE = 'parent-1'
export const PARENT_TWO = 'parent-2'
export const PARENT_ONE_NAME = 'Team folder'
export const PARENT_TWO_NAME = 'Root share'
export const MEMBER_ID = 'user-2'
export const MEMBER = 'Test Two'
export const AGENT = 'chatllm'
export const PARENT_ONE_GRANT = '51515151-5151-4151-8151-515151515151'
export const PARENT_TWO_GRANT = '52525252-5252-4252-8252-525252525252'
export const DIRECT_GRANT = '53535353-5353-4353-8353-535353535353'
export const AGENT_GRANT = '54545454-5454-4454-8454-545454545454'
export const REMOVE_SUCCESS = 'Access removed on 2 folders and everything inside them'
export const DOWNGRADE_SUCCESS = `${MEMBER} is now Read-only on ${PARENT_ONE_NAME} and ${PARENT_TWO_NAME} and everything inside them`

function ridOf(resourceId: string): string {
  return resourceId.replace(/-/g, '').toLowerCase()
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

/** An IPC whose calls resolve at once unless held; held calls queue a deferred. */
export function heldIpc<T>(settled: () => T) {
  let holding = false
  const pending: Array<ReturnType<typeof deferred<T>>> = []
  const fn = vi.fn((..._args: unknown[]) => {
    if (!holding) return Promise.resolve(settled())
    const call = deferred<T>()
    pending.push(call)
    return call.promise
  })
  return {
    fn,
    pending,
    hold: (value = true) => {
      holding = value
    },
  }
}

export type WriteName = 'revokeGrant' | 'revokeShare' | 'grant'

export interface RecordedWrite {
  name: WriteName
  args: unknown[]
}

export async function waitSettled(rounds = 6) {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  })
}

/** Which seam an intercepted IPC call crosses. */
export type InterceptedIpc = 'write' | 'preflight' | 'session'

/**
 * Who mounts the Share dialog: the Files page, or the sidebar's action host
 * (opened on the same row, as the resource menu does).
 */
export type ParentUpdateOwner = 'files' | 'host'

export interface ParentUpdateHarnessOptions {
  agentGrant?: boolean
  owner?: ParentUpdateOwner
  /**
   * Takes over when an intercepted call settles. `settle` produces the value
   * the default mock would have returned, read at the moment it runs.
   */
  intercept?: (
    kind: InterceptedIpc,
    args: unknown[],
    settle: () => Promise<unknown>
  ) => Promise<unknown>
}

export async function mountParentUpdatePage(options: ParentUpdateHarnessOptions = {}) {
  const rootPage = await listAccessiblePage([
    accessibleResource(TARGET_ID, 'Folder A', 'directory', {
      sources: ['grant'],
      permissions: ['read', 'manage_acl'],
      coversDescendants: true,
    }),
  ])
  const emptyChildrenPage = await listChildrenPage([])
  const resolved = new Map([
    [
      `gfs://main/${ridOf(TARGET_ID)}`,
      await resolveResource(
        resolvedDirectory(TARGET_ID, 'Folder A', { parentResourceId: PARENT_ONE })
      ),
    ],
    [
      `gfs://main/${ridOf(PARENT_ONE)}`,
      await resolveResource(
        resolvedDirectory(PARENT_ONE, PARENT_ONE_NAME, { parentResourceId: PARENT_TWO })
      ),
    ],
    [
      `gfs://main/${ridOf(PARENT_TWO)}`,
      await resolveResource(resolvedDirectory(PARENT_TWO, PARENT_TWO_NAME)),
    ],
  ])
  const member = { type: 'user', id: MEMBER_ID }
  const grantsByResource = new Map([
    [
      PARENT_ONE,
      await grantsListPage([
        {
          id: PARENT_ONE_GRANT,
          drive: 'main',
          resourceId: PARENT_ONE,
          subject: member,
          permissions: ['read', 'write'],
          inherit: true,
        },
      ]),
    ],
    [
      PARENT_TWO,
      await grantsListPage([
        {
          id: PARENT_TWO_GRANT,
          drive: 'main',
          resourceId: PARENT_TWO,
          subject: member,
          permissions: ['read', 'write'],
          inherit: true,
        },
      ]),
    ],
    [
      TARGET_ID,
      await grantsListPage([
        {
          id: DIRECT_GRANT,
          drive: 'main',
          resourceId: TARGET_ID,
          subject: member,
          permissions: ['read'],
          inherit: true,
        },
        ...(options.agentGrant
          ? [
              {
                id: AGENT_GRANT,
                drive: 'main',
                resourceId: TARGET_ID,
                subject: { type: 'host', id: '1st:mcp-host/chatllm' },
                permissions: ['read'],
                inherit: true,
              },
            ]
          : []),
      ]),
    ],
  ])
  // No producer fixture exists for the team directory; the type binds the
  // literal to the IPC contract so drift fails the typecheck.
  const teamDirectory: TeamDirectoryResult = {
    currentTeamId: 'team-a',
    items: [
      {
        team: { id: 'team-a', name: 'Team A', role: 'admin' },
        members: [
          {
            id: MEMBER_ID,
            email: 'two@example.test',
            name: MEMBER,
            role: 'member',
            status: 'active',
          },
        ],
        contextIds: [],
        agentNames: [],
      },
    ],
  }
  const noShares = await sharesListPage([])
  const heldPositive = await affordancesResult(
    heldAffordances(['read', 'write', 'manage_acl', 'share'])
  )
  const heldDenied = await affordancesResult(heldAffordances(['read']))
  const freshPositive = delegationAffordances(new Set(heldPositive.held), heldPositive.isOperator)
  const freshDenied = delegationAffordances(new Set(heldDenied.held), heldDenied.isOperator)

  // Per-resource affordances: a held resource queues its next read.
  const heldAffordanceReads = new Map<
    string,
    Array<ReturnType<typeof deferred<typeof freshPositive>>>
  >()
  const holdAffordances = new Set<string>()
  const affordances = vi.fn((resourceId: string): Promise<typeof freshPositive> => {
    if (options.intercept && (resourceId === PARENT_ONE || resourceId === PARENT_TWO)) {
      return options.intercept('preflight', [resourceId], async () => freshPositive) as Promise<
        typeof freshPositive
      >
    }
    if (!holdAffordances.has(resourceId)) return Promise.resolve(freshPositive)
    holdAffordances.delete(resourceId)
    const read = deferred<typeof freshPositive>()
    heldAffordanceReads.set(resourceId, [...(heldAffordanceReads.get(resourceId) ?? []), read])
    return read.promise
  })

  const writes: RecordedWrite[] = []
  const revokeGrant = heldIpc(() => undefined)
  const revokeShare = heldIpc(() => undefined)
  const grant = heldIpc(() => undefined)
  const record = (name: WriteName, ipc: ReturnType<typeof heldIpc<undefined>>) => {
    const inner = ipc.fn.getMockImplementation()!
    ipc.fn.mockImplementation((...args: unknown[]) => {
      writes.push({ name, args })
      if (options.intercept) {
        return options.intercept('write', [name, ...args], () =>
          inner(...args)
        ) as Promise<undefined>
      }
      return inner(...args)
    })
  }
  record('revokeGrant', revokeGrant)
  record('revokeShare', revokeShare)
  record('grant', grant)

  const listGrants = vi.fn(
    async (resourceId: string) => grantsByResource.get(resourceId) ?? (await grantsListPage([]))
  )
  const pushToast = vi.fn<(message: string, tone: Tone) => void>()
  let mainGeneration = SESSION_GENERATION
  const getSessionGeneration = vi.fn(
    (): Promise<number> =>
      options.intercept
        ? (options.intercept('session', [], async () => mainGeneration) as Promise<number>)
        : Promise.resolve(mainGeneration)
  )

  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      gfs: {
        listAccessible: vi.fn(async () => rootPage),
        listChildren: vi.fn(async () => emptyChildrenPage),
        affordances,
        grant: grant.fn,
        revokeGrant: revokeGrant.fn,
        revokeShare: revokeShare.fn,
        resolve: vi.fn(async (uri: string) => {
          const hit = resolved.get(uri)
          if (!hit) throw new Error(`unexpected resolve ${uri}`)
          return hit
        }),
        listGrants,
        listShares: vi.fn(async () => noShares),
      },
      auth: { getSessionGeneration },
      agents: {
        listMine: vi.fn(async () => [
          {
            name: AGENT,
            contextRef: 'ctx-1',
            mcpServers: [],
            gfsSubject: { type: 'host' as const, id: '1st:mcp-host/chatllm' },
          },
        ]),
      },
      team: { directory: vi.fn(async () => teamDirectory) },
    },
  })

  const queryClient = new QueryClient({ defaultOptions: desktopQueryDefaults })
  const baseAuth = {
    isAuthenticated: true,
    sessionGeneration: SESSION_GENERATION,
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

  const owner: ParentUpdateOwner = options.owner ?? 'files'
  let host: GfsActionHostContextValue | null = null
  // The row as the sidebar's tree holds it: the browser controller's listing.
  let hostTarget: GfsHostActionTarget | null = null
  // Set when another host action replaced Share; it covers the window from
  // its permission check on, before its dialog renders.
  let hostAway = false
  const hostActionOpen = vi.fn<(open: boolean) => void>()
  const refreshFilesLocation = vi.fn()

  interface HarnessState {
    generation: number
    mounted: boolean
    signedIn: boolean
  }
  const initialState: HarnessState = {
    generation: SESSION_GENERATION,
    mounted: true,
    signedIn: true,
  }
  let harnessState = initialState
  let setHarness!: (patch: Partial<HarnessState>) => void
  /**
   * Stands in for the sidebar's resource menu on the listed row, and for the
   * Files surface's revoked state elsewhere in the app with its real retry.
   */
  function HostMenu() {
    const value = useGfsActionHost()
    const ctrl = useGfsBrowserController()
    const row = ctrl.accessibleResources.find(item => item.resourceId === TARGET_ID) ?? null
    useEffect(() => {
      host = value
      if (row) hostTarget = row
    })
    return (
      <>
        {row ? (
          <button
            type="button"
            onClick={() => {
              hostAway = false
              value?.openGfsAction(row, 'share')
            }}
          >
            Share Folder A
          </button>
        ) : null}
        {ctrl.accessState === 'revoked' ? (
          <button type="button" onClick={() => ctrl.retryAccess()}>
            Retry file access
          </button>
        ) : null}
      </>
    )
  }
  function Harness() {
    const [state, setState] = useState(initialState)
    harnessState = state
    setHarness = patch => setState(previous => ({ ...previous, ...patch }))
    const auth = useMemo(
      () =>
        (state.signedIn
          ? { ...baseAuth, sessionGeneration: state.generation }
          : {
              ...baseAuth,
              isAuthenticated: false,
              me: null,
              sessionGeneration: null,
            }) as AuthContextValue,
      [state.generation, state.signedIn]
    )
    return (
      <AuthContext.Provider value={auth}>
        <QueryClientProvider client={queryClient}>
          {owner === 'files' ? (
            state.mounted ? (
              <FilesPage pushToast={pushToast} />
            ) : null
          ) : (
            <GfsActionHost
              pushToast={pushToast}
              refreshFilesLocation={refreshFilesLocation}
              onActionOpenChange={hostActionOpen}
            >
              <HostMenu />
            </GfsActionHost>
          )}
        </QueryClientProvider>
      </AuthContext.Provider>
    )
  }
  const view = render(<Harness />)
  await screen.findByRole('button', { name: 'Share Folder A' })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Share Folder A' })))
  await screen.findByRole('dialog', { name: 'Share folder Folder A' })
  await screen.findByTestId(`gfs-access-row-inherited-user:${MEMBER_ID}`)
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: `Access role for ${MEMBER}` }) as HTMLButtonElement)
        .disabled
    ).toBe(false)
  )
  await waitSettled()

  const shareDialog = () => screen.queryByRole('dialog', { name: 'Share folder Folder A' })
  const closeButton = () =>
    screen.getByRole('button', { name: 'Close share dialog' }) as HTMLButtonElement
  const confirmation = () => screen.queryByRole('alertdialog')
  const otherHostAction = () => screen.queryByRole('dialog', { name: 'Rename folder' })

  return {
    ...view,
    owner,
    queryClient,
    refreshFilesLocation,
    pushToast,
    writes,
    revokeGrant,
    revokeShare,
    grant,
    affordances,
    listGrants,
    getSessionGeneration,
    freshPositive,
    freshDenied,
    shareDialog,
    closeButton,
    confirmation,
    holdAffordancesOf: (resourceId: string) => holdAffordances.add(resourceId),
    heldAffordances: (resourceId: string) => heldAffordanceReads.get(resourceId) ?? [],
    mainGeneration: () => mainGeneration,
    rendererGeneration: () => harnessState.generation,
    /**
     * Whether the user is where the Share dialog was opened: the Files section
     * for FilesPage; for the host, no other action opened over Share since
     * (counted from the moment it opens, not from when its dialog renders).
     */
    filesMounted: () => (owner === 'files' ? harnessState.mounted : !hostAway),
    returnToFiles: async () => {
      if (owner === 'files') {
        await act(async () => setHarness({ mounted: true }))
        return
      }
      // A Rename still checking its permissions opens its dialog first.
      await waitSettled(3)
      const other = otherHostAction()
      if (other) {
        await act(async () =>
          fireEvent.click(within(other).getByRole('button', { name: 'Cancel' }))
        )
      }
      hostAway = false
    },
    openShare: async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Share Folder A' }))
      await screen.findByRole('dialog', { name: 'Share folder Folder A' })
    },
    /** Main switches first: the renderer has not published the new session yet. */
    switchMain: (generation = mainGeneration + 1) => {
      mainGeneration = generation
    },
    publishGeneration: async (generation = mainGeneration) => {
      await act(async () => setHarness({ generation }))
    },
    /**
     * The user leaves the dialog's surface without closing it: FilesPage
     * unmounts (sidebar/titlebar navigation); the host replaces Share with
     * another action on the same row.
     */
    navigateAway: async () => {
      if (owner === 'files') {
        await act(async () => setHarness({ mounted: false }))
        return
      }
      const target = hostTarget
      expect(target, 'the listed row the host acts on').not.toBeNull()
      hostAway = true
      await act(async () => host?.openGfsAction(target!, 'rename'))
      await waitSettled(3)
    },
    /** Sign-out: the cache is cleared and the session is no longer published. */
    logout: async () => {
      await act(async () => {
        queryClient.clear()
        setHarness({ signedIn: false, mounted: false })
      })
    },
    hostActionOpen,
    revoke: () =>
      act(() => revokeGfsSessionAccess(queryClient, SESSION_SCOPE, harnessState.generation)),
    purge: () =>
      act(() =>
        purgeGfsSessionCache(queryClient, {
          scope: SESSION_SCOPE,
          generation: harnessState.generation,
        })
      ),
    retryAccess: async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Retry file access' }))
      await waitFor(() =>
        expect(readGfsAccessState(queryClient, SESSION_SCOPE, harnessState.generation)).toBe(
          'active'
        )
      )
    },
    accessState: () => readGfsAccessState(queryClient, SESSION_SCOPE, harnessState.generation),
    goOffline: () => act(() => onlineManager.setOnline(false)),
    goOnline: () => act(() => onlineManager.setOnline(true)),
    openRemovePlan: async () => {
      fireEvent.click(screen.getByRole('button', { name: `Actions for ${MEMBER}` }))
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove access' }))
    },
    /** Picks Read on the inherited row: opens the downgrade pre-flight. */
    startDowngrade: async () => {
      fireEvent.click(screen.getByRole('button', { name: `Access role for ${MEMBER}` }))
      fireEvent.click(await screen.findByRole('option', { name: 'Read' }))
    },
    /**
     * The agent's direct grant row: a role change that is not a parent update.
     * Its authority read joins the target's affordances refetch, so holding
     * that resource holds the role change before it marks itself busy.
     */
    startAgentRoleChange: async () => {
      await act(async () => {
        void queryClient.invalidateQueries({
          exact: true,
          queryKey: desktopQueryKeys.gfsAffordances(
            SESSION_SCOPE,
            TARGET_ID,
            'main',
            SESSION_GENERATION
          ),
        })
      })
      fireEvent.click(screen.getByRole('button', { name: `Access role for ${AGENT}` }))
      fireEvent.click(await screen.findByRole('option', { name: 'Editor' }))
    },
    confirmPlan: async () => {
      const dialog = await screen.findByRole('alertdialog')
      const button = within(dialog).getByRole('button', { name: /^(Remove|Update role)$/ })
      fireEvent.click(button)
    },
    failureMessage: (status: number) =>
      gfsRouteFailureMessage(
        client => client.revokeGrant(PARENT_TWO_GRANT, 'fixture-token'),
        status,
        {
          code: status === 401 ? 'unauthorized' : 'internal',
          message: status === 401 ? 'session expired' : 'upstream failed',
        }
      ),
    /** What the direct `gfs.grant` IPC rejects with, from the real grant route. */
    grantFailureMessage: (status: number) =>
      gfsRouteFailureMessage(
        client =>
          client.grant(
            {
              resourceId: PARENT_ONE,
              subjects: [{ type: 'user', id: MEMBER_ID }],
              permissions: ['read'],
            },
            'fixture-token'
          ),
        status,
        {
          code: status === 401 ? 'unauthorized' : 'internal',
          message: status === 401 ? 'session expired' : 'upstream failed',
        }
      ),
    affordancesFailure: (status: number) =>
      affordancesFailureMessage(status, {
        code: status === 401 ? 'unauthorized' : 'internal',
        message: status === 401 ? 'session expired' : 'gfs controller failed',
      }),
  }
}

export type ParentUpdatePage = Awaited<ReturnType<typeof mountParentUpdatePage>>

export function writeTargets(writes: RecordedWrite[]): string[] {
  return writes.map(write => `${write.name}:${String(write.args[0])}`)
}
