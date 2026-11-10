// @vitest-environment jsdom
import React, { useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext } from '@contexts/AuthContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { FileExplorerTree } from '@components/SidebarNav/FileExplorerTree'
import { ComposerPanel } from '@components/agents/ComposerPanel'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { useGfsBrowserController } from '@hooks/domain/useGfsBrowserController'
import type { HostModelsResult } from '@hooks/useChatStore'
import type { ComposerDraftWriteResult } from '@hooks/useComposerDraft'
import { resetComposerDraftStore } from '@lib/composerDraftStore'
import { rendererEntityChangeRegistry } from '@lib/entityChangeRegistry'
import {
  accessibleResource,
  childView,
  listAccessiblePage,
  listChildrenPage,
  resolvedDirectory,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { delegationAffordances } from '../../../../../src/gfs/delegation.js'
import type { WorkflowRecipeListResult } from '../../../../../src/types'

const folderA = accessibleResource('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Folder A', 'directory')
const pageOneRow = childView('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'Page one.md', 'file', {
  parentResourceId: folderA.resourceId,
})
const pageTwoRow = childView('cccccccccccccccccccccccccccccccc', 'Page two.md', 'file', {
  parentResourceId: folderA.resourceId,
})
const pageThreeRow = childView('dddddddddddddddddddddddddddddddd', 'Page three.md', 'file', {
  parentResourceId: folderA.resourceId,
})

const composerState = {
  composerImageAttachments: [] as never[],
  composerFileAttachments: [] as never[],
  composerFileRefusals: [] as never[],
  composerReferenceAttachments: [] as never[],
  agentSending: false,
  agentError: null,
  failedAgentSend: null,
  activeChatId: 'chat-r36' as string | null,
  workspaceChatTabId: null as string | null,
  activeMessageCount: 0,
  composerFocusRequestId: 0,
  requestComposerFocus: vi.fn(),
}
const actionsMock = vi.hoisted(() => ({
  clearComposerSendError: vi.fn(),
  handleAddComposerImageAttachments: vi.fn(),
  handleUpdateComposerImageAttachment: vi.fn(),
  handleRemoveComposerImageAttachment: vi.fn(),
  handleAddComposerFiles: vi.fn(),
  handleRemoveComposerFileAttachment: vi.fn(),
  handleAddComposerReferenceAttachments: vi.fn(),
  handleRemoveComposerReferenceAttachment: vi.fn(),
  handleClearComposerAttachments: vi.fn(),
  handleSendAgentMessage: vi.fn(),
  handleRetryFailedAgentSend: vi.fn(),
  handleRecoverFailedAgentSend: vi.fn(),
  handleDiscardFailedAgentSend: vi.fn(),
}))
const draftState = {
  value: '',
  set: vi.fn<(value: string) => ComposerDraftWriteResult>(() => ({ accepted: true })),
}
const modelState = {
  data: {
    provider: 'claude',
    hostDefault: 'claude-haiku-4-5',
    sessionModel: null,
    degraded: false,
    models: [{ name: 'claude-haiku-4-5', displayName: 'Haiku 4.5' }],
  } as HostModelsResult,
  loading: false,
  saving: false,
  error: null,
  state: 'ready' as const,
  effectiveModel: 'claude-haiku-4-5',
  intentModel: null,
  pending: false,
  selectionUnsettled: false,
  conflicted: false,
  confirmedRevision: null,
  imageInput: { state: 'unknown' as const, reason: 'model_unknown' },
  canAttachImages: false,
  imageBlockMessage: null,
  visualSendBlocked: false,
  selectModel: vi.fn(async () => true),
  clearError: vi.fn(),
  refresh: vi.fn(async () => undefined),
}

vi.mock('@contexts/AgentChatActionsContext', () => ({
  useAgentChatActionsContext: () => actionsMock,
}))
vi.mock('@contexts/ChatComposerStateContext', () => ({
  useChatComposerStateContext: () => composerState,
}))
vi.mock('@contexts/McpRuntimeContext', () => ({
  useMcpRuntimeContext: () => ({ hostRuntimeStatus: null, activeLlmProvider: null }),
}))
vi.mock('@contexts/NavigationContext', () => ({
  useNavigationContext: () => ({ selectedAgent: 'agent-r36' }),
}))
vi.mock('@hooks/domain/useAgentsDataController', () => ({
  useAgentsDataController: () => ({
    accessCatalog: { userId: 'user-1', teamId: null },
    agentNames: ['agent-r36'],
    loading: false,
    error: null,
  }),
}))
vi.mock('@hooks/domain/useContextsDataController', () => ({
  useContextsDataController: () => ({ sharedFilesByContext: {}, refreshSharedFiles: vi.fn() }),
}))
vi.mock('@hooks/domain/useMcpServersDataController', () => ({
  useMcpServersDataController: () => ({
    selectedAgentMcpServers: [],
    agentContextByName: {},
    refresh: vi.fn(),
  }),
}))
vi.mock('@hooks/useComposerDraft', () => ({
  useComposerDraft: () => [draftState.value, draftState.set, null],
}))
vi.mock('@hooks/useHostModels', () => ({ useHostModels: () => modelState }))
vi.mock('../ComposerAgentFilesModal', () => ({ ComposerAgentFilesModal: () => null }))
vi.mock('../ComposerGlobalFilesModal', () => ({ ComposerGlobalFilesModal: () => null }))
vi.mock('../AnnotationCanvas', () => ({ AnnotationCanvas: () => null }))
vi.mock('@constants/agentFeatures', async importOriginal => ({
  ...(await importOriginal<typeof import('@constants/agentFeatures')>()),
  SHOW_GLOBAL_FILE_SYSTEM_COMPOSER_ITEM: false,
}))

const auth = {
  isAuthenticated: true,
  sessionGeneration: 1,
  me: { id: 'user-1', email: 'user@example.test', teamId: null },
  authTransitioning: false,
  runtimeConfigState: { envKey: 'test' },
}

type Controller = ReturnType<typeof useGfsBrowserController>
let mutationController: Controller | undefined
function MutationProbe() {
  const controller = useGfsBrowserController({ pickerAuthorityManaged: true })
  useEffect(() => {
    mutationController = controller
  }, [controller])
  return null
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function installWindow(producers: Record<string, unknown>) {
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      workflows: {
        list: vi.fn(async (): Promise<WorkflowRecipeListResult> => ({ items: [], count: 0 })),
      },
      auth: { getSessionGeneration: vi.fn(async () => 1) },
      gfs: producers,
    },
  })
}

async function renderSurface(options: { sidebar?: boolean; mutationProbe?: boolean } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  })
  function Surface() {
    return (
      <AuthContext.Provider value={auth as never}>
        <QueryClientProvider client={queryClient}>
          {options.sidebar ? (
            <FileExplorerTree onOpenFolder={vi.fn()} onOpenPreview={vi.fn()} pushToast={vi.fn()} />
          ) : null}
          <ComposerPanel inline={false} />
          {options.mutationProbe ? <MutationProbe /> : null}
        </QueryClientProvider>
      </AuthContext.Provider>
    )
  }
  render(<Surface />)
  return queryClient
}

async function openPickerFolder() {
  fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
  fireEvent.mouseEnter(await screen.findByRole('menuitem', { name: 'EvenDrive' }))
  fireEvent.mouseEnter(await screen.findByRole('menuitem', { name: 'Insert folder Folder A' }))
}

function normalPagesAndCalls() {
  const log: Array<string | undefined> = []
  let initialCount = 0
  let pageTwoCount = 0
  const listChildren = vi.fn(async (_id: string, _drive: string, cursor?: string) => {
    log.push(cursor)
    if (cursor === 'p2') {
      pageTwoCount += 1
      return listChildrenPage([pageTwoRow], pageTwoCount === 1 ? 'p3' : 'p3')
    }
    if (cursor === 'p3') return listChildrenPage([pageThreeRow])
    initialCount += 1
    return listChildrenPage([pageOneRow], 'p2')
  })
  return { listChildren, log, getInitialCount: () => initialCount }
}

function commonProducers(listChildren: ReturnType<typeof normalPagesAndCalls>['listChildren']) {
  return {
    listAccessible: vi.fn(async () => listAccessiblePage([folderA])),
    listChildren,
    affordances: vi.fn(async (resourceId: string) =>
      delegationAffordances(new Set(['read']), false)
    ),
    createFolder: vi.fn(async () =>
      resolvedDirectory('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 'New folder')
    ),
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  resetComposerDraftStore()
  mutationController = undefined
  Object.assign(composerState, {
    composerImageAttachments: [],
    composerFileAttachments: [],
    composerFileRefusals: [],
    composerReferenceAttachments: [],
    activeChatId: 'chat-r36',
    workspaceChatTabId: null,
    activeMessageCount: 0,
    composerFocusRequestId: 0,
  })
  for (const action of Object.values(actionsMock)) action.mockReset()
  delete (window as Partial<typeof window>).clerum
})

describe('R36 held-full recovery on mounted Composer callers', () => {
  it('rejects a child IPC dispatch when its parent snapshot invalidates first', async () => {
    const listChildren = vi.fn(async () => listChildrenPage([pageOneRow]))
    installWindow(commonProducers(listChildren))
    const queryClient = await renderSurface()
    let invalidatedParent = false
    const unsubscribe = queryClient.getQueryCache().subscribe(event => {
      if (
        invalidatedParent ||
        event.type !== 'added' ||
        event.query.queryKey[0] !== 'desktop-app' ||
        event.query.queryKey[1] !== 'gfs' ||
        event.query.queryKey[3] !== 'children'
      )
        return
      invalidatedParent = true
      void queryClient.invalidateQueries({
        queryKey: desktopQueryKeys.gfsAccessible(String(event.query.queryKey[2]), 'main', 1),
        exact: true,
        refetchType: 'none',
      })
    })

    fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
    fireEvent.mouseEnter(await screen.findByRole('menuitem', { name: 'EvenDrive' }))
    fireEvent.mouseEnter(await screen.findByRole('menuitem', { name: 'Insert folder Folder A' }))
    await waitFor(() => expect(invalidatedParent).toBe(true))
    await act(async () => Promise.resolve())

    expect(listChildren).not.toHaveBeenCalled()
    expect(screen.queryByRole('menuitem', { name: 'Insert link to Page one.md' })).toBeNull()
    unsubscribe()
  })

  it('opens a focused folder lazily without inserting its link', async () => {
    const listChildren = vi.fn(async () => listChildrenPage([pageOneRow]))
    installWindow(commonProducers(listChildren))
    await renderSurface()

    fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
    fireEvent.mouseEnter(await screen.findByRole('menuitem', { name: 'EvenDrive' }))
    const folder = await screen.findByRole('menuitem', { name: 'Insert folder Folder A' })
    draftState.set.mockClear()
    folder.focus()

    const nested = await screen.findByRole('menu', { name: 'Folder A contents' })
    expect(
      await within(nested).findByRole('menuitem', { name: 'Insert link to Page one.md' })
    ).toBeTruthy()
    expect(listChildren).toHaveBeenCalledTimes(1)
    expect(draftState.set).not.toHaveBeenCalled()

    const child = within(nested).getByRole('menuitem', { name: 'Insert link to Page one.md' })
    child.focus()
    fireEvent.keyDown(child, { key: 'ArrowLeft' })
    await waitFor(() =>
      expect(screen.queryByRole('menu', { name: 'Folder A contents' })).toBeNull()
    )
    await waitFor(() => expect(document.activeElement).toBe(folder))
    expect(screen.queryByRole('menu', { name: 'Folder A contents' })).toBeNull()
  })

  it('returns ArrowLeft from the root submenu to the EvenDrive trigger', async () => {
    installWindow(commonProducers(vi.fn(async () => listChildrenPage([pageOneRow]))))
    await renderSurface()

    fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
    const trigger = await screen.findByRole('menuitem', { name: 'EvenDrive' })
    fireEvent.mouseEnter(trigger)
    const folder = await screen.findByRole('menuitem', { name: 'Insert folder Folder A' })
    folder.focus()
    fireEvent.keyDown(folder, { key: 'ArrowLeft' })

    await waitFor(() => expect(screen.queryByRole('menu', { name: 'EvenDrive links' })).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('reuses validated child rows while a reopened folder refresh is pending', async () => {
    const reopened = deferred<Awaited<ReturnType<typeof listChildrenPage>>>()
    let calls = 0
    const listChildren = vi.fn(async () => {
      calls += 1
      return calls === 1 ? listChildrenPage([pageOneRow]) : reopened.promise
    })
    installWindow(commonProducers(listChildren))
    const queryClient = await renderSurface()
    await openPickerFolder()

    const nested = await screen.findByRole('menu', { name: 'Folder A contents' })
    expect(
      await within(nested).findByRole('menuitem', { name: 'Insert link to Page one.md' })
    ).toBeTruthy()
    expect(listChildren).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('menuitem', { name: 'Collapse folder Folder A' }))
    await waitFor(() =>
      expect(screen.queryByRole('menu', { name: 'Folder A contents' })).toBeNull()
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Expand folder Folder A' }))

    const reopenedPanel = await screen.findByRole('menu', { name: 'Folder A contents' })
    expect(listChildren).toHaveBeenCalledTimes(2)
    expect(
      within(reopenedPanel).getByRole('menuitem', { name: 'Insert link to Page one.md' })
    ).toBeTruthy()

    await act(async () => reopened.resolve(await listChildrenPage([pageOneRow])))
    expect(
      await within(reopenedPanel).findByRole('menuitem', { name: 'Insert link to Page one.md' })
    ).toBeTruthy()
  })

  it('moves keyboard focus into a folder and restores it after Escape', async () => {
    installWindow(commonProducers(vi.fn(async () => listChildrenPage([pageOneRow]))))
    await renderSurface()

    fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
    fireEvent.mouseEnter(await screen.findByRole('menuitem', { name: 'EvenDrive' }))
    const folder = await screen.findByRole('menuitem', { name: 'Insert folder Folder A' })
    folder.focus()
    fireEvent.keyDown(folder, { key: 'ArrowRight' })

    const nested = await screen.findByRole('menu', { name: 'Folder A contents' })
    const child = await within(nested).findByRole('menuitem', {
      name: 'Insert link to Page one.md',
    })
    await waitFor(() => expect(nested.contains(document.activeElement)).toBe(true))
    expect(document.activeElement).toBe(child)

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() =>
      expect(screen.queryByRole('menu', { name: 'Folder A contents' })).toBeNull()
    )
    await waitFor(() => expect(document.activeElement).toBe(folder))
    expect(screen.queryByRole('menu', { name: 'Folder A contents' })).toBeNull()
  })

  it('R104: a collapsed sidebar P3 join receives one full check and reaches Retry on failure', async () => {
    const pendingP3 = deferred<Awaited<ReturnType<typeof listChildrenPage>>>()
    const failedFull = deferred<Awaited<ReturnType<typeof listChildrenPage>>>()
    const cursors: Array<string | undefined> = []
    let initialPages = 0
    let fullStarted = false
    const listChildren = vi.fn(async (_id: string, _drive: string, cursor?: string) => {
      cursors.push(cursor)
      if (cursor === 'p3') return pendingP3.promise
      if (cursor === 'p2') return listChildrenPage([pageTwoRow], 'p3')
      initialPages += 1
      if (initialPages === 1) return listChildrenPage([pageOneRow], 'p2')
      if (initialPages === 2) {
        fullStarted = true
        return failedFull.promise
      }
      if (initialPages === 3) return listChildrenPage([pageOneRow])
      throw new Error('unexpected automatic full retry')
    })
    installWindow(commonProducers(listChildren))
    await renderSurface({ sidebar: true })

    const tree = await screen.findByRole('tree', { name: 'Shared files' })
    fireEvent.click(await within(tree).findByRole('button', { name: 'Expand Folder A' }))
    await within(tree).findByRole('button', { name: 'Page one.md' })
    fireEvent.click(await within(tree).findByRole('button', { name: 'Load more' }))
    await within(tree).findByRole('button', { name: 'Page two.md' })
    fireEvent.click(await within(tree).findByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(cursors).toEqual([undefined, 'p2', 'p3']))

    fireEvent.click(within(tree).getByRole('button', { name: 'Collapse Folder A' }))
    await openPickerFolder()
    expect(cursors).toEqual([undefined, 'p2', 'p3'])

    await act(async () => pendingP3.reject(new Error('503 joined P3 failed')))
    await waitFor(() => expect(fullStarted).toBe(true))
    expect(cursors).toEqual([undefined, 'p2', 'p3', undefined])
    await act(async () => failedFull.reject(new Error('503 automatic full failed')))

    expect(await screen.findByRole('button', { name: 'Retry file listing' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: 'Insert link to Page one.md' })).toBeNull()
    await act(async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve()
    })
    expect(cursors).toEqual([undefined, 'p2', 'p3', undefined])
  })

  it('R106: Composer Load more waits behind a held full, then advances its current cursor', async () => {
    const heldFull = deferred<Awaited<ReturnType<typeof listChildrenPage>>>()
    const heldForward = deferred<Awaited<ReturnType<typeof listChildrenPage>>>()
    const cursors: Array<string | undefined> = []
    let undefinedCalls = 0
    let p2Calls = 0
    const listChildren = vi.fn(async (_id: string, _drive: string, cursor?: string) => {
      cursors.push(cursor)
      if (cursor === 'p2') {
        p2Calls += 1
        return p2Calls === 1 ? heldForward.promise : listChildrenPage([pageTwoRow], 'p3')
      }
      if (cursor === 'p3') return listChildrenPage([pageThreeRow])
      undefinedCalls += 1
      if (undefinedCalls === 2) return heldFull.promise
      return listChildrenPage([pageOneRow], 'p2')
    })
    const producers = commonProducers(listChildren)
    installWindow(producers)
    await renderSurface({ mutationProbe: true })
    await waitFor(() => expect(mutationController).toBeDefined())
    await openPickerFolder()
    await screen.findByRole('menuitem', { name: 'Insert link to Page one.md' })
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(cursors).toEqual([undefined, 'p2']))

    await act(async () => {
      void mutationController!.createFolder(folderA.resourceId, 'Refresh trigger')
    })
    await waitFor(() => expect(undefinedCalls).toBe(2))
    await act(async () => heldFull.resolve(await listChildrenPage([pageOneRow], 'p2')))
    await screen.findByRole('menuitem', { name: 'Insert link to Page one.md' })
    await act(async () => heldForward.resolve(await listChildrenPage([pageTwoRow], 'p3')))
    expect(screen.queryByRole('menuitem', { name: 'Insert link to Page two.md' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy()
    expect(cursors).toEqual([undefined, 'p2', undefined])

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await screen.findByRole('menuitem', { name: 'Insert link to Page two.md' })
    expect(cursors).toEqual([undefined, 'p2', undefined, 'p2'])
    expect(p2Calls).toBe(2)
  })

  it('R106: late old page is discarded when it settles before the replacement full list', async () => {
    const heldFull = deferred<Awaited<ReturnType<typeof listChildrenPage>>>()
    const heldForward = deferred<Awaited<ReturnType<typeof listChildrenPage>>>()
    const cursors: Array<string | undefined> = []
    let undefinedCalls = 0
    const listChildren = vi.fn(async (_id: string, _drive: string, cursor?: string) => {
      cursors.push(cursor)
      if (cursor === 'p2') return heldForward.promise
      undefinedCalls += 1
      if (undefinedCalls === 2) return heldFull.promise
      return listChildrenPage([pageOneRow], 'p2')
    })
    installWindow(commonProducers(listChildren))
    await renderSurface({ mutationProbe: true })
    await waitFor(() => expect(mutationController).toBeDefined())
    await openPickerFolder()
    await screen.findByRole('menuitem', { name: 'Insert link to Page one.md' })
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(cursors).toEqual([undefined, 'p2']))

    await act(async () => {
      void mutationController!.createFolder(folderA.resourceId, 'Refresh trigger')
    })
    await waitFor(() => expect(undefinedCalls).toBe(2))

    await act(async () => heldForward.resolve(await listChildrenPage([pageTwoRow], 'p3')))
    expect(screen.queryByRole('menuitem', { name: 'Insert link to Page two.md' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()

    await act(async () => heldFull.resolve(await listChildrenPage([pageOneRow], 'p2')))
    await screen.findByRole('menuitem', { name: 'Insert link to Page one.md' })
    expect(screen.queryByRole('menuitem', { name: 'Insert link to Page two.md' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy()
    expect(cursors).toEqual([undefined, 'p2', undefined])

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await screen.findByRole('menuitem', { name: 'Insert link to Page two.md' })
    expect(cursors).toEqual([undefined, 'p2', undefined, 'p2'])
  })

  it('R106: a completed page is withheld after invalidation until the current full list settles', async () => {
    const heldFull = deferred<Awaited<ReturnType<typeof listChildrenPage>>>()
    const cursors: Array<string | undefined> = []
    let undefinedCalls = 0
    let p2Calls = 0
    const listChildren = vi.fn(async (_id: string, _drive: string, cursor?: string) => {
      cursors.push(cursor)
      if (cursor === 'p2') {
        p2Calls += 1
        return p2Calls === 1
          ? listChildrenPage([pageTwoRow], 'p3')
          : listChildrenPage([pageThreeRow], 'p4')
      }
      if (cursor === 'p4')
        return listChildrenPage([
          childView('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 'Page four.md', 'file', {
            parentResourceId: folderA.resourceId,
          }),
        ])
      undefinedCalls += 1
      if (undefinedCalls === 2) return heldFull.promise
      return listChildrenPage([pageOneRow], 'p2')
    })
    installWindow(commonProducers(listChildren))
    const queryClient = await renderSurface({ mutationProbe: true })
    await waitFor(() => expect(mutationController).toBeDefined())
    await openPickerFolder()
    await screen.findByRole('menuitem', { name: 'Insert link to Page one.md' })
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
    await screen.findByRole('menuitem', { name: 'Insert link to Page two.md' })

    await act(async () => {
      void mutationController!.createFolder(folderA.resourceId, 'Refresh after completed page')
    })
    await waitFor(() => expect(undefinedCalls).toBe(2))
    const childQuery = queryClient
      .getQueryCache()
      .getAll()
      .find(query => query.queryKey.includes(folderA.resourceId))
    expect(childQuery?.state.isInvalidated).toBe(true)
    expect(screen.queryByRole('menuitem', { name: 'Insert link to Page two.md' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()

    await act(async () => heldFull.resolve(await listChildrenPage([pageOneRow], 'p2')))
    await screen.findByRole('menuitem', { name: 'Insert link to Page one.md' })
    expect(screen.queryByRole('menuitem', { name: 'Insert link to Page two.md' })).toBeNull()
    await screen.findByRole('menuitem', { name: 'Insert link to Page three.md' })
    expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy()
    expect(cursors).toEqual([undefined, 'p2', undefined, 'p2'])

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await screen.findByRole('menuitem', { name: 'Insert link to Page four.md' })
    expect(cursors).toEqual([undefined, 'p2', undefined, 'p2', 'p4'])
  })

  it('R106 failure: held full rejection discards pagination and leaves Retry available', async () => {
    const heldFull = deferred<Awaited<ReturnType<typeof listChildrenPage>>>()
    const cursors: Array<string | undefined> = []
    let undefinedCalls = 0
    const listChildren = vi.fn(async (_id: string, _drive: string, cursor?: string) => {
      cursors.push(cursor)
      if (cursor === 'p2') return listChildrenPage([pageTwoRow], 'p3')
      if (cursor === 'p3') return listChildrenPage([pageThreeRow])
      undefinedCalls += 1
      if (undefinedCalls === 2) return heldFull.promise
      return listChildrenPage([pageOneRow], 'p2')
    })
    installWindow(commonProducers(listChildren))
    await renderSurface({ mutationProbe: true })
    await waitFor(() => expect(mutationController).toBeDefined())
    await openPickerFolder()
    await screen.findByRole('menuitem', { name: 'Insert link to Page one.md' })
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
    await screen.findByRole('menuitem', { name: 'Insert link to Page two.md' })

    await act(async () => {
      void mutationController!.createFolder(folderA.resourceId, 'Failure trigger')
    })
    await waitFor(() => expect(undefinedCalls).toBe(2))
    expect(screen.queryByRole('menuitem', { name: 'Insert link to Page two.md' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
    expect(cursors).toEqual([undefined, 'p2', undefined])
    expect(screen.queryByRole('menuitem', { name: 'Insert link to Page three.md' })).toBeNull()

    await act(async () => heldFull.reject(new Error('503 held full failure')))
    const retry = await screen.findByRole('button', { name: 'Retry file listing' })
    expect(retry.getAttribute('disabled')).toBeNull()
    expect(cursors).toEqual([undefined, 'p2', undefined])
    expect(screen.queryByRole('menuitem', { name: 'Insert link to Page three.md' })).toBeNull()
  })

  it('explicit Retry is operable on the mounted Composer and a successful request replaces the error', async () => {
    let childCalls = 0
    const listChildren = vi.fn(async () => {
      childCalls += 1
      if (childCalls === 1) throw new Error('503 ordinary listing failure')
      return listChildrenPage([pageOneRow])
    })
    installWindow(commonProducers(listChildren))
    await renderSurface()
    await openPickerFolder()
    expect(await screen.findByRole('status')).toBeTruthy()
    const retry = await screen.findByRole('button', { name: 'Retry file listing' })
    retry.focus()
    expect(retry.getAttribute('disabled')).toBeNull()
    fireEvent.click(retry)
    await screen.findByRole('menuitem', { name: 'Insert link to Page one.md' })
    expect(childCalls).toBe(2)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry file listing' })).toBeNull()
  })

  it('explicit Retry failure returns to an actionable error state without an automatic second retry', async () => {
    let childCalls = 0
    const listChildren = vi.fn(async () => {
      childCalls += 1
      throw new Error(`503 listing failure ${childCalls}`)
    })
    installWindow(commonProducers(listChildren))
    await renderSurface()
    await openPickerFolder()
    const firstRetry = await screen.findByRole('button', { name: 'Retry file listing' })
    fireEvent.click(firstRetry)
    const secondRetry = await screen.findByRole('button', { name: 'Retry file listing' })
    expect(secondRetry.getAttribute('disabled')).toBeNull()
    expect(childCalls).toBe(2)
    await act(async () => Promise.resolve())
    expect(childCalls).toBe(2)
    expect(screen.getByRole('status')).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Retry file listing' }).getAttribute('disabled')
    ).toBeNull()
  })

  it('does not admit child Retry after its exact folder read authority is synchronously revoked', async () => {
    let childCalls = 0
    let permissionCalls = 0
    const listChildren = vi.fn(async () => {
      childCalls += 1
      if (childCalls === 1) throw new Error('503 listing failure')
      return listChildrenPage([pageOneRow])
    })
    const producers = commonProducers(listChildren)
    producers.affordances = vi.fn(async () => {
      permissionCalls += 1
      return delegationAffordances(permissionCalls === 1 ? new Set(['read']) : new Set(), false)
    })
    installWindow(producers)
    await renderSurface()
    await openPickerFolder()
    const retry = await screen.findByRole('button', { name: 'Retry file listing' })
    let callsAfterEvent = 0
    let callsAfterRetryActivation = 0

    act(() => {
      rendererEntityChangeRegistry.dispatch({
        type: 'scope.invalidated',
        schemaVersion: 1,
        cursor: 'r36-revoked-folder-before-react-commit',
        scopes: ['gfs', 'authorization'],
      })
      callsAfterEvent = childCalls
      retry.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      callsAfterRetryActivation = childCalls
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    expect(callsAfterRetryActivation).toBe(callsAfterEvent)
    expect(screen.queryByRole('menuitem', { name: 'Insert link to Page one.md' })).toBeNull()
  })
})
