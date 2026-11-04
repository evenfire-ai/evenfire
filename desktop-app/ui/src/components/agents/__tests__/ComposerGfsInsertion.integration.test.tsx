// @vitest-environment jsdom
import React, { useLayoutEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext } from '@contexts/AuthContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import fc, { type AsyncCommand } from 'fast-check'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import type { HostModelsResult } from '@hooks/useChatStore'
import * as composerDraftStore from '@lib/composerDraftStore'
import {
  getComposerDraft,
  getComposerDraftRevision,
  resetComposerDraftStore,
  setComposerDraft,
} from '@lib/composerDraftStore'
import { rendererEntityChangeRegistry } from '@lib/entityChangeRegistry'
import { desktopQueryDefaults } from '@lib/queryClient'
import { FilesPage } from '@pages/FilesPage'
import {
  accessibleResource,
  childView,
  listAccessiblePage,
  listChildrenPage,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { delegationAffordances } from '../../../../../src/gfs/delegation.js'
import type { WorkflowRecipeListResult } from '../../../../../src/types'
import { ComposerPanel } from '../ComposerPanel'
import { accessCatalogFromWire } from './__fixtures__/accessCatalog'

const composerState = {
  composerImageAttachments: [] as never[],
  composerFileAttachments: [] as never[],
  composerFileRefusals: [] as never[],
  composerReferenceAttachments: [] as never[],
  agentSending: false,
  agentError: null,
  failedAgentSend: null,
  activeChatId: 'chat-1' as string | null,
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
  handleSendAgentMessage: vi.fn(),
  handleRetryFailedAgentSend: vi.fn(),
  handleRecoverFailedAgentSend: vi.fn(),
  handleDiscardFailedAgentSend: vi.fn(),
}))
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
  useNavigationContext: () => ({ selectedAgent: 'agent-1' }),
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
vi.mock('@hooks/useHostModels', () => ({ useHostModels: () => modelState }))
vi.mock('../ComposerAgentFilesModal', () => ({ ComposerAgentFilesModal: () => null }))
vi.mock('../ComposerGlobalFilesModal', () => ({ ComposerGlobalFilesModal: () => null }))
vi.mock('../AnnotationCanvas', () => ({ AnnotationCanvas: () => null }))
vi.mock('@constants/agentFeatures', async importOriginal => ({
  ...(await importOriginal<typeof import('@constants/agentFeatures')>()),
  // The link picker must be visible even when the legacy attachment opt-in is off.
  SHOW_GLOBAL_FILE_SYSTEM_COMPOSER_ITEM: false,
}))

const folderA = accessibleResource('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Folder A', 'directory')
const folderB = childView('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'Nested B', 'directory', {
  parentResourceId: folderA.resourceId,
  path: '/Folder A/Nested B',
})
const note = childView('cccccccccccccccccccccccccccccccc', 'Release notes.md', 'file', {
  parentResourceId: folderB.resourceId,
  path: '/Folder A/Nested B/Release notes.md',
})

const exactReadAffordance = (held: string[]) => delegationAffordances(new Set(held), false)

function installProducers() {
  const listAccessible = vi.fn(async () => listAccessiblePage([folderA]))
  const listChildren = vi.fn(async (resourceId: string) =>
    listChildrenPage(resourceId === folderA.resourceId ? [folderB] : [note])
  )
  const affordances = vi.fn(async () => ({
    held: ['read'],
    isOperator: false,
    resourceId: folderA.resourceId,
    drive: 'main',
    canDelegate: false,
    grantableBits: [],
    canCreateShare: false,
  }))
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      workflows: {
        list: vi.fn(async (): Promise<WorkflowRecipeListResult> => ({ items: [], count: 0 })),
      },
      gfs: { listAccessible, listChildren, affordances },
      auth: { getSessionGeneration: vi.fn(async () => 1) },
    } as unknown as Window['clerum'],
  })
  return { listAccessible, listChildren, affordances }
}

async function renderComposer(
  options: { authenticated?: boolean } | (() => void) = {},
  onCommit?: () => void
) {
  const authenticated = typeof options === 'function' ? true : (options.authenticated ?? true)
  const onComposerCommit = typeof options === 'function' ? options : onCommit
  const auth = {
    isAuthenticated: authenticated,
    sessionGeneration: 1,
    me: authenticated ? { id: 'user-1', email: 'user@example.test', teamId: null } : null,
    authTransitioning: false,
    runtimeConfigState: { envKey: 'test' },
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(
    desktopQueryKeys.accessCatalog,
    await accessCatalogFromWire([{ name: 'agent-1', contextRef: null }])
  )
  function Harness() {
    useLayoutEffect(() => onComposerCommit?.())
    return (
      <AuthContext.Provider value={auth as never}>
        <QueryClientProvider client={queryClient}>
          <ComposerPanel inline={false} />
        </QueryClientProvider>
      </AuthContext.Provider>
    )
  }
  const view = render(<Harness />)
  return { queryClient, rerenderComposer: () => view.rerender(<Harness />) }
}

async function openNestedResource() {
  const trigger = screen.getByRole('button', { name: 'Add context' })
  if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger)
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Insert EvenDrive link' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Open folder Folder A' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Open folder Nested B' }))
  return screen.findByRole('menuitem', { name: 'Insert link to Release notes.md' })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  resetComposerDraftStore()
  Object.assign(composerState, {
    composerImageAttachments: [],
    composerFileAttachments: [],
    composerFileRefusals: [],
    composerReferenceAttachments: [],
    activeChatId: 'chat-1',
    workspaceChatTabId: null,
    activeMessageCount: 0,
    composerFocusRequestId: 0,
  })
  for (const action of Object.values(actionsMock)) action.mockReset()
  delete (window as Partial<typeof window>).clerum
})

describe('ComposerPanel producer-backed EvenDrive insertion', () => {
  it('shows Insert EvenDrive link in the authenticated composer plus menu', async () => {
    installProducers()
    await renderComposer()

    fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
    expect(screen.getByRole('menuitem', { name: 'Insert EvenDrive link' })).toBeTruthy()
  })

  it('does not expose the protected picker to a logged-out composer', async () => {
    const producers = installProducers()
    await renderComposer({ authenticated: false })

    fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
    expect(screen.queryByRole('menuitem', { name: 'Insert EvenDrive link' })).toBeNull()
    expect(producers.listAccessible).not.toHaveBeenCalled()
  })

  it('keeps FilesPage permission work separate from picker admission and recovery', async () => {
    const sharedNote = accessibleResource(note.resourceId, 'Release notes.md', 'file', {
      path: '/Shared/Release notes.md',
    })
    const childNote = childView(note.resourceId, 'Release notes.md', 'file', {
      parentResourceId: folderA.resourceId,
      path: '/Folder A/Release notes.md',
    })
    const nestedOnly = childView('ffffffffffffffffffffffffffffffff', 'Nested only.md', 'file', {
      parentResourceId: folderA.resourceId,
      path: '/Folder A/Nested only.md',
    })
    const queued = [
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'dddddddddddddddddddddddddddddddd',
      'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    ].map((id, index) => accessibleResource(id, `Queued ${index}`, 'file'))
    const rootPage = await listAccessiblePage([folderA, sharedNote, ...queued])
    const childrenPage = await listChildrenPage([childNote, nestedOnly])
    const permissionRequests: Array<{
      resourceId: string
      resolve: (value: ReturnType<typeof delegationAffordances>) => void
      settled: boolean
    }> = []
    const listAccessible = vi.fn(async () => rootPage)
    const listChildren = vi.fn(async () => childrenPage)
    const affordances = vi.fn((resourceId: string) => {
      return new Promise<ReturnType<typeof delegationAffordances>>(resolve => {
        const request = {
          resourceId,
          settled: false,
          resolve: value => {
            request.settled = true
            resolve(value)
          },
        }
        permissionRequests.push(request)
      })
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        workflows: {
          list: vi.fn(async (): Promise<WorkflowRecipeListResult> => ({ items: [], count: 0 })),
        },
        auth: { getSessionGeneration: vi.fn(async () => 1) },
        gfs: { listAccessible, listChildren, affordances, resolve: vi.fn() },
      } as unknown as Window['clerum'],
    })
    const auth = {
      isAuthenticated: true,
      sessionGeneration: 1,
      me: {
        id: 'user-1',
        email: 'user@example.test',
        name: 'User 1',
        picture: null,
        teamId: null,
        teamName: null,
        role: 'member' as const,
      },
      authTransitioning: false,
      runtimeConfigState: { envKey: 'test' },
    }
    composerState.activeChatId = 'chat-1'
    composerState.workspaceChatTabId = null
    const queryClient = new QueryClient({ defaultOptions: desktopQueryDefaults })
    queryClient.setQueryData(
      desktopQueryKeys.accessCatalog,
      await accessCatalogFromWire([{ name: 'agent-1', contextRef: null }])
    )
    let showComposer = false
    function Consumers() {
      return (
        <AuthContext.Provider value={auth as never}>
          <QueryClientProvider client={queryClient}>
            <FilesPage />
            {showComposer ? <ComposerPanel inline={false} /> : null}
          </QueryClientProvider>
        </AuthContext.Provider>
      )
    }
    const view = render(<Consumers />)

    await screen.findByRole('button', { name: 'Open Folder A' })
    fireEvent.click(screen.getByRole('button', { name: 'Folder A' }))
    await screen.findByRole('button', { name: 'Open Release notes.md' })
    await waitFor(() => {
      expect(permissionRequests.some(request => request.resourceId === note.resourceId)).toBe(true)
    })
    const nonPickerIndex = permissionRequests.findIndex(
      request => request.resourceId === note.resourceId
    )
    expect(nonPickerIndex).toBeGreaterThanOrEqual(0)
    const nonPickerRequest = permissionRequests[nonPickerIndex]!
    expect(nonPickerRequest.settled).toBe(false)

    const breadcrumbs = screen.getByRole('navigation', { name: 'File location' })
    fireEvent.click(within(breadcrumbs).getByRole('button', { name: 'Shared with me' }))
    await waitFor(() => {
      const query = queryClient
        .getQueryCache()
        .findAll()
        .find(candidate => candidate.queryKey.includes(note.resourceId))
      expect(query?.getObserversCount() ?? 0).toBe(0)
    })
    expect(nonPickerRequest.settled).toBe(false)
    const nonPickerRequestCount = permissionRequests.length
    const nonPickerRequests = permissionRequests.slice(0, nonPickerRequestCount)
    expect(nonPickerRequests.every(request => !request.settled)).toBe(true)

    showComposer = true
    view.rerender(<Consumers />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add context' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Insert EvenDrive link' }))
    const pickerMenu = await screen.findByRole('menu', { name: 'EvenDrive links' })
    await waitFor(() => expect(permissionRequests).toHaveLength(nonPickerRequestCount + 4))
    const pickerRequests = permissionRequests.slice(nonPickerRequestCount)
    expect(pickerRequests).toHaveLength(4)
    expect(pickerRequests.map(request => request.resourceId)).toEqual([
      folderA.resourceId,
      note.resourceId,
      ...queued.slice(0, 2).map(resource => resource.resourceId),
    ])
    expect(
      permissionRequests.filter(request => request.resourceId === note.resourceId)
    ).toHaveLength(
      nonPickerRequests.filter(request => request.resourceId === note.resourceId).length + 1
    )
    expect(pickerRequests.filter(request => !request.settled)).toHaveLength(4)
    expect(permissionRequests).toHaveLength(nonPickerRequestCount + 4)

    await act(async () => {
      for (const request of nonPickerRequests) {
        request.resolve(delegationAffordances(new Set(['read']), false))
      }
    })
    expect(
      within(pickerMenu).queryByRole('menuitem', { name: 'Insert link to Release notes.md' })
    ).toBeNull()

    await act(async () =>
      pickerRequests[1]!.resolve(delegationAffordances(new Set(['read']), false))
    )
    await screen.findByRole('menuitem', { name: 'Insert link to Release notes.md' })
    await waitFor(() => expect(permissionRequests).toHaveLength(nonPickerRequestCount + 5))
    expect(permissionRequests.at(-1)?.resourceId).toBe(queued[2]?.resourceId)
    expect(
      permissionRequests.slice(nonPickerRequestCount).filter(request => !request.settled)
    ).toHaveLength(4)

    for (const request of permissionRequests) {
      if (request.settled) continue
      await act(async () => request.resolve(delegationAffordances(new Set(['read']), false)))
    }
    await screen.findByRole('menuitem', { name: 'Open folder Folder A' })
    expect(
      permissionRequests.filter(request => request.resourceId === note.resourceId)
    ).toHaveLength(
      nonPickerRequests.filter(request => request.resourceId === note.resourceId).length + 1
    )
    expect(permissionRequests.every(request => request.settled)).toBe(true)
    expect(
      queryClient
        .getQueryCache()
        .getAll()
        .every(query => query.state.fetchStatus === 'idle')
    ).toBe(true)

    // Re-enter a real picker folder with a cold presentation cache. The picker must
    // dispatch one private authority request; enabling QueryClient row observers for
    // this picker would add separate current-folder/row calls and violate the measured
    // picker ownership/cost boundary.
    queryClient
      .getQueryCache()
      .findAll()
      .forEach(query => {
        if (query.queryKey.includes(nestedOnly.resourceId)) {
          queryClient.removeQueries({ queryKey: query.queryKey, exact: true })
        }
      })
    const childCallsBefore = permissionRequests.length
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open folder Folder A' }))
    await screen.findByRole('menuitem', { name: 'Back to shared files' })
    await waitFor(() => expect(permissionRequests.length).toBeGreaterThan(childCallsBefore))
    expect(permissionRequests).toHaveLength(childCallsBefore + 1)
    expect(permissionRequests.at(-1)?.resourceId).toBe(nestedOnly.resourceId)
    await act(async () =>
      permissionRequests.at(-1)!.resolve(delegationAffordances(new Set(['read']), false))
    )
    await within(pickerMenu).findByRole('menuitem', { name: 'Insert link to Nested only.md' })

    view.unmount()
    queryClient.clear()
  })

  it('generates mounted Composer direct, edit, and RAF orders through the real IPC boundary', async () => {
    type Model = {
      phase: 'ready' | 'direct-pending' | 'written' | 'done'
      selection: number
      capturedSelection: number | null
      editedDuringDirect: boolean
      editedAfter: boolean
      expectedDraft: string
      insertionEnd: number | null
    }
    type PendingPermission = {
      resolve: (value: ReturnType<typeof exactReadAffordance>) => void
      settled: boolean
    }
    type Real = {
      scheduler: ReturnType<typeof fc.scheduler>
      textarea: HTMLTextAreaElement
      insert: HTMLElement
      pending: PendingPermission[]
      raf: FrameRequestCallback[]
      order: string[]
      draftRevision: number
      queryClient: QueryClient
    }

    class MoveSelection implements AsyncCommand<Model, Real> {
      check(model: Readonly<Model>) {
        return model.phase === 'written' && !model.editedAfter
      }
      async run(model: Model, real: Real) {
        model.selection = 0
        model.editedAfter = true
        real.textarea.focus()
        real.textarea.setSelectionRange(0, 0)
        fireEvent.select(real.textarea)
        real.order.push('select-after-write-before-raf')
      }
      toString() {
        return 'change-live-composer-selection'
      }
    }

    class Activate implements AsyncCommand<Model, Real> {
      check(model: Readonly<Model>) {
        return model.phase === 'ready'
      }
      async run(model: Model, real: Real) {
        model.capturedSelection = real.textarea.selectionStart
        fireEvent.click(real.insert)
        await waitFor(() => expect(real.pending).toHaveLength(1))
        model.phase = 'direct-pending'
        real.order.push('direct-activation')
      }
      toString() {
        return 'activate-real-picker-control'
      }
    }

    class ResolveDirect implements AsyncCommand<Model, Real> {
      check(model: Readonly<Model>) {
        return model.phase === 'direct-pending'
      }
      async run(model: Model, real: Real) {
        const request = real.pending[0]!
        const scheduled = real.scheduler
          .schedule(Promise.resolve(), 'direct-permission-response')
          .then(() => {
            request.resolve(exactReadAffordance(['read']))
            request.settled = true
          })
        await act(async () => {
          await real.scheduler.waitNext(1)
          await scheduled
        })
        if (model.editedDuringDirect) {
          model.expectedDraft = 'edited draft'
          model.phase = 'done'
          expect(getComposerDraft('chat-1', 'agent-1')).toBe(model.expectedDraft)
          expect(getComposerDraftRevision('chat-1', 'agent-1')).toBeGreaterThan(real.draftRevision)
          expect(real.textarea.value).toBe(model.expectedDraft)
          real.order.push('direct-allow-rejected-after-draft-edit')
          return
        }
        const insertion = `${note.gfsUri} `
        const start = model.capturedSelection ?? real.textarea.selectionStart
        model.expectedDraft = `abcdefgh`.slice(0, start) + insertion + `abcdefgh`.slice(start)
        model.insertionEnd = start + insertion.length
        model.phase = 'written'
        await waitFor(() => expect(getComposerDraft('chat-1', 'agent-1')).toBe(model.expectedDraft))
        expect(getComposerDraftRevision('chat-1', 'agent-1')).toBe(real.draftRevision + 1)
        real.order.push('direct-allow-and-synchronous-write')
      }
      toString() {
        return 'release-scheduled-direct-allow'
      }
    }

    class EditWhileDirectPending implements AsyncCommand<Model, Real> {
      check(model: Readonly<Model>) {
        return model.phase === 'direct-pending' && !model.editedDuringDirect
      }
      async run(model: Model, real: Real) {
        model.editedDuringDirect = true
        real.textarea.focus()
        fireEvent.change(real.textarea, { target: { value: 'edited draft' } })
        real.textarea.setSelectionRange(3, 3)
        fireEvent.select(real.textarea)
        real.order.push('edit-draft-during-direct-await')
        await waitFor(() => expect(getComposerDraft('chat-1', 'agent-1')).toBe('edited draft'))
      }
      toString() {
        return 'edit-draft-while-direct-authorization-pending'
      }
    }

    class RunRaf implements AsyncCommand<Model, Real> {
      check(model: Readonly<Model>) {
        return model.phase === 'written' || model.phase === 'done'
      }
      async run(model: Model, real: Real) {
        if (model.phase === 'written' && real.raf.length === 0) {
          throw new Error('accepted insertion did not schedule its RAF')
        }
        let callbackIndex = 0
        while (callbackIndex < real.raf.length) {
          const callback = real.raf[callbackIndex++]!
          const scheduled = real.scheduler
            .schedule(Promise.resolve(), `raf-callback-${callbackIndex}`)
            .then(() => callback(0))
          await act(async () => {
            await real.scheduler.waitNext(1)
            await scheduled
          })
        }
        const expectedStart = model.editedAfter ? 0 : model.insertionEnd
        expect(real.textarea.value).toBe(model.expectedDraft)
        if (model.editedDuringDirect) {
          expect(real.textarea.selectionStart).toBe(3)
          expect(real.textarea.selectionEnd).toBe(3)
        } else {
          expect(real.textarea.selectionStart).toBe(expectedStart)
          expect(real.textarea.selectionEnd).toBe(expectedStart)
        }
        expect(document.activeElement).toBe(real.textarea)
        if (model.phase === 'written') model.phase = 'done'
        real.order.push('scheduled-raf-release')
      }
      toString() {
        return 'release-owned-caret-raf'
      }
    }

    const observedOrders = new Set<string>()
    const observedSelections = new Set<string>()
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.commands(
          [
            fc.constant(new MoveSelection()),
            fc.constant(new Activate()),
            fc.constant(new ResolveDirect()),
            fc.constant(new EditWhileDirectPending()),
            fc.constant(new RunRaf()),
          ],
          { maxCommands: 6, size: '+1' }
        ),
        async (scheduler, commands) => {
          cleanup()
          vi.restoreAllMocks()
          resetComposerDraftStore()
          composerState.activeChatId = 'chat-1'
          composerState.workspaceChatTabId = null
          const raf: FrameRequestCallback[] = []
          vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
            raf.push(callback)
            return raf.length
          })
          const producers = installProducers()
          const pending: PendingPermission[] = []
          let noteCalls = 0
          producers.affordances.mockImplementation(async resourceId => {
            if (resourceId !== note.resourceId) return exactReadAffordance(['read'])
            noteCalls += 1
            if (noteCalls === 1) return exactReadAffordance(['read'])
            return new Promise(resolve => pending.push({ resolve, settled: false }))
          })
          setComposerDraft('chat-1', 'abcdefgh', 'agent-1')
          const { queryClient } = await renderComposer()
          const textarea = screen.getByTestId('chat-input') as HTMLTextAreaElement
          textarea.setSelectionRange(4, 4)
          fireEvent.select(textarea)
          const insert = await openNestedResource()
          await waitFor(() => expect(noteCalls).toBe(1))
          const real: Real = {
            scheduler,
            textarea,
            insert,
            pending,
            raf,
            order: [],
            draftRevision: getComposerDraftRevision('chat-1', 'agent-1'),
            queryClient,
          }
          const model: Model = {
            phase: 'ready',
            selection: 4,
            capturedSelection: null,
            editedDuringDirect: false,
            editedAfter: false,
            expectedDraft: 'abcdefgh',
            insertionEnd: null,
          }

          await fc.asyncModelRun(() => ({ model, real }), commands)
          if (model.phase === 'ready') await new Activate().run(model, real)
          if (model.phase === 'direct-pending') await new ResolveDirect().run(model, real)
          if (model.phase === 'written' || model.phase === 'done') {
            await new RunRaf().run(model, real)
          }

          expect(model.phase).toBe('done')
          expect(real.pending.every(request => request.settled)).toBe(true)
          expect(scheduler.count()).toBe(0)
          expect(getComposerDraft('chat-1', 'agent-1')).toBe(model.expectedDraft)
          observedOrders.add(real.order.join('>'))
          observedSelections.add(String(real.textarea.selectionStart))
          real.queryClient.clear()
        }
      ),
      { numRuns: 12, seed: 12931132 }
    )
    process.stdout.write(
      `A6-J3 Composer seed=12931132 runs=12 orders=${JSON.stringify([...observedOrders])} ` +
        `finalSelections=${JSON.stringify([...observedSelections])}\n`
    )
    expect(observedOrders.size).toBeGreaterThan(1)
    expect(observedSelections.size).toBeGreaterThan(1)
  }, 120_000)

  it.each([false, true])(
    'inserts raw links without losing draft text (workspace blank tab: %s)',
    async blankTab => {
      const chatId = blankTab ? null : 'chat-1'
      const tabId = blankTab ? 'blank-chat-tab' : undefined
      composerState.activeChatId = chatId
      composerState.workspaceChatTabId = tabId ?? null
      const producers = installProducers()
      const initialDraft = 'keep this text'
      setComposerDraft(chatId, initialDraft, 'agent-1', tabId)
      const view = await renderComposer()

      const textarea = screen.getByTestId('chat-input') as HTMLTextAreaElement
      textarea.setSelectionRange(4, 9)
      fireEvent.select(textarea)
      fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Insert EvenDrive link' }))
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Open folder Folder A' }))
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Open folder Nested B' }))
      const insertItem = await screen.findByRole('menuitem', {
        name: 'Insert link to Release notes.md',
      })
      fireEvent.click(insertItem)

      const inserted = `keep this${note.gfsUri}  text`
      await waitFor(() => expect(getComposerDraft(chatId, 'agent-1', tabId)).toBe(inserted))
      view.rerenderComposer()
      await waitFor(() => expect(textarea.value).toBe(inserted))
      await waitFor(() => expect(document.activeElement).toBe(textarea))
      const caretAfterUri = inserted.indexOf('  text') + 1
      expect(textarea.selectionStart).toBe(caretAfterUri)
      expect(textarea.selectionEnd).toBe(caretAfterUri)

      expect(producers.listAccessible).toHaveBeenCalledOnce()
      expect(producers.listChildren).toHaveBeenCalledWith(folderA.resourceId, 'main', undefined)
      expect(producers.listChildren).toHaveBeenCalledWith(folderB.resourceId, 'main', undefined)
      expect(screen.getByRole('menuitem', { name: 'Insert link to Release notes.md' })).toBeTruthy()

      fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
      expect(actionsMock.handleSendAgentMessage).toHaveBeenCalledWith(
        ...(tabId ? [inserted, tabId] : [inserted])
      )

      const notePermissionCalls = () =>
        producers.affordances.mock.calls.filter(([resourceId]) => resourceId === note.resourceId)
          .length
      const callsBeforeSecondInsertion = notePermissionCalls()
      await act(async () => {
        fireEvent.click(screen.getByRole('menuitem', { name: 'Insert link to Release notes.md' }))
      })
      await act(async () => {
        await Promise.resolve()
      })
      expect(notePermissionCalls()).toBe(callsBeforeSecondInsertion + 1)
      const twiceInserted = `keep this${note.gfsUri} ${note.gfsUri}  text`
      await waitFor(() => expect(getComposerDraft(chatId, 'agent-1', tabId)).toBe(twiceInserted))
      expect(producers.listChildren).toHaveBeenCalledTimes(2)
    }
  )
  it('keeps two blank tabs for the same agent isolated through picker insertion and send', async () => {
    installProducers()
    composerState.activeChatId = null
    composerState.workspaceChatTabId = 'tab-a'
    setComposerDraft(null, 'first draft', 'agent-1', 'tab-a')
    setComposerDraft(null, 'second draft', 'agent-1', 'tab-b')
    const view = await renderComposer()
    const textarea = screen.getByTestId('chat-input') as HTMLTextAreaElement
    textarea.setSelectionRange(6, 6)
    fireEvent.click(await openNestedResource())
    const firstDraft = `first ${note.gfsUri} draft`
    await waitFor(() => expect(textarea.value).toBe(firstDraft))
    await waitFor(() => expect(textarea.selectionEnd).toBe(6 + note.gfsUri.length + 1))
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    expect(actionsMock.handleSendAgentMessage).toHaveBeenLastCalledWith(firstDraft, 'tab-a')

    composerState.workspaceChatTabId = 'tab-b'
    view.rerenderComposer()
    expect(textarea.value).toBe('second draft')
    expect(screen.queryByRole('menu', { name: 'EvenDrive links' })).toBeNull()
    textarea.setSelectionRange(7, 7)
    // The top-level + menu remains open after only its picker submenu closes.
    fireEvent.click(screen.getByRole('menuitem', { name: 'Insert EvenDrive link' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open folder Folder A' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open folder Nested B' }))
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'Insert link to Release notes.md' })
    )
    const secondDraft = `second ${note.gfsUri} draft`
    await waitFor(() => expect(textarea.value).toBe(secondDraft))
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    expect(actionsMock.handleSendAgentMessage).toHaveBeenLastCalledWith(secondDraft, 'tab-b')
    expect(getComposerDraft(null, 'agent-1', 'tab-a')).toBe(firstDraft)
    expect(getComposerDraft(null, 'agent-1', 'tab-b')).toBe(secondDraft)
    expect(getComposerDraft(null, 'agent-1')).toBe('')
  })

  it('rejects a real picker activation after a same-agent tab changes before passive cleanup', async () => {
    installProducers()
    composerState.activeChatId = null
    composerState.workspaceChatTabId = 'tab-a'
    setComposerDraft(null, 'first draft', 'agent-1', 'tab-a')
    setComposerDraft(null, 'second draft', 'agent-1', 'tab-b')
    let pendingActivation: HTMLElement | null = null
    let activateAfterCommit = false
    const view = await renderComposer(() => {
      if (!activateAfterCommit || !pendingActivation) return
      activateAfterCommit = false
      // Dispatch the already queued DOM activation at the commit boundary, before the
      // passive identity cleanup can close the old picker. No private callback is used.
      fireEvent.click(pendingActivation)
    })
    pendingActivation = await openNestedResource()
    activateAfterCommit = true
    composerState.workspaceChatTabId = 'tab-b'
    act(() => {
      view.rerenderComposer()
    })
    expect(getComposerDraft(null, 'agent-1', 'tab-a')).toBe('first draft')
    expect(getComposerDraft(null, 'agent-1', 'tab-b')).toBe('second draft')
    expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe('second draft')
    expect(screen.queryByRole('menu', { name: 'EvenDrive links' })).toBeNull()
  })

  it('ignores delayed hierarchical results after the picker owner tab changes', async () => {
    const producers = installProducers()
    let finishChildren!: (value: Awaited<ReturnType<typeof listChildrenPage>>) => void
    const pendingChildren = new Promise<Awaited<ReturnType<typeof listChildrenPage>>>(resolve => {
      finishChildren = resolve
    })
    producers.listChildren.mockImplementationOnce(() => pendingChildren)
    composerState.activeChatId = null
    composerState.workspaceChatTabId = 'tab-a'
    setComposerDraft(null, 'first draft', 'agent-1', 'tab-a')
    setComposerDraft(null, 'second draft', 'agent-1', 'tab-b')
    const view = await renderComposer()
    fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Insert EvenDrive link' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open folder Folder A' }))
    await waitFor(() => expect(producers.listChildren).toHaveBeenCalledOnce())
    composerState.workspaceChatTabId = 'tab-b'
    view.rerenderComposer()
    await act(async () => finishChildren(await listChildrenPage([folderB])))
    expect(screen.queryByRole('menu', { name: 'EvenDrive links' })).toBeNull()
    expect(getComposerDraft(null, 'agent-1', 'tab-a')).toBe('first draft')
    expect(getComposerDraft(null, 'agent-1', 'tab-b')).toBe('second draft')
    expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe('second draft')
  })

  it('cancels an insertion when another producer changes the owned draft revision', async () => {
    installProducers()
    composerState.activeChatId = null
    composerState.workspaceChatTabId = 'tab-a'
    setComposerDraft(null, 'first draft', 'agent-1', 'tab-a')
    await renderComposer()
    const insertItem = await openNestedResource()
    act(() => {
      setComposerDraft(null, 'newer draft', 'agent-1', 'tab-a')
    })
    fireEvent.click(insertItem)
    expect(getComposerDraft(null, 'agent-1', 'tab-a')).toBe('newer draft')
    expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe('newer draft')
    expect(screen.queryByRole('menu', { name: 'EvenDrive links' })).toBeNull()
  })

  it('honors a rejected writer result without advancing the picker caret or stored draft', async () => {
    const producers = installProducers()
    composerState.activeChatId = null
    composerState.workspaceChatTabId = 'tab-a'
    setComposerDraft(null, 'keep this text', 'agent-1', 'tab-a')
    await renderComposer()
    const textarea = screen.getByTestId('chat-input') as HTMLTextAreaElement
    textarea.setSelectionRange(4, 9)
    const insertItem = await openNestedResource()
    const setSelection = vi.spyOn(textarea, 'setSelectionRange')
    // Boundary negative control: the current real store always accepts this write,
    // but useComposerDraft exposes refusal as a supported result to its consumers.
    vi.spyOn(composerDraftStore, 'setComposerDraft').mockReturnValueOnce(false)
    fireEvent.click(insertItem)
    await new Promise(resolve => requestAnimationFrame(resolve))
    expect(getComposerDraft(null, 'agent-1', 'tab-a')).toBe('keep this text')
    expect(setSelection).not.toHaveBeenCalled()
    expect(textarea.value).toContain('keep this')
    expect(textarea.value).toContain(' text')
    expect(screen.getByRole('menuitem', { name: 'Insert link to Release notes.md' })).toBeTruthy()
    // A later accepted retry still uses the last accepted draft and original anchor.
    const notePermissionCalls = () =>
      producers.affordances.mock.calls.filter(([resourceId]) => resourceId === note.resourceId)
        .length
    const callsBeforeRetry = notePermissionCalls()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Insert link to Release notes.md' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(notePermissionCalls()).toBe(callsBeforeRetry + 1)
    await waitFor(() =>
      expect(getComposerDraft(null, 'agent-1', 'tab-a')).toBe(`keep this${note.gfsUri}  text`)
    )
  })

  it('requires a fresh direct allow before writing and rejects a denied direct result', async () => {
    const listAccessible = vi.fn(async () => listAccessiblePage([folderA]))
    const listChildren = vi.fn(async (resourceId: string) =>
      listChildrenPage(resourceId === folderA.resourceId ? [folderB] : [note])
    )
    let resolveDirect: ((value: ReturnType<typeof exactReadAffordance>) => void) | null = null
    let noteCalls = 0
    const affordances = vi.fn((resourceId: string) => {
      if (resourceId !== note.resourceId) return Promise.resolve(exactReadAffordance(['read']))
      noteCalls += 1
      if (noteCalls === 1) return Promise.resolve(exactReadAffordance(['read']))
      return new Promise<ReturnType<typeof exactReadAffordance>>(resolve => {
        resolveDirect = resolve
      })
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        workflows: {
          list: vi.fn(async (): Promise<WorkflowRecipeListResult> => ({ items: [], count: 0 })),
        },
        gfs: { listAccessible, listChildren, affordances },
        auth: { getSessionGeneration: vi.fn(async () => 1) },
      } as unknown as Window['clerum'],
    })
    setComposerDraft('chat-1', 'keep this text', 'agent-1')
    await renderComposer()
    const textarea = screen.getByTestId('chat-input') as HTMLTextAreaElement
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    fireEvent.select(textarea)
    const insert = await openNestedResource()
    fireEvent.click(insert)
    await waitFor(() => expect(noteCalls).toBe(2))
    expect(getComposerDraft('chat-1', 'agent-1')).toBe('keep this text')

    await act(async () => {
      resolveDirect?.(exactReadAffordance([]))
    })
    expect(getComposerDraft('chat-1', 'agent-1')).toBe('keep this text')

    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'Insert link to Release notes.md' })
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(noteCalls).toBe(3)
    await act(async () => {
      resolveDirect?.(exactReadAffordance(['read']))
    })
    await waitFor(() =>
      expect(getComposerDraft('chat-1', 'agent-1')).toBe(`keep this text${note.gfsUri} `)
    )
    expect(affordances).toHaveBeenCalledTimes(5)
  })

  it('reports a rejected direct permission request and permits a later deliberate recovery', async () => {
    const producers = installProducers()
    const directCalls = new Map<string, number>()
    producers.affordances.mockImplementation(async resourceId => {
      if (resourceId !== note.resourceId) return exactReadAffordance(['read'])
      const count = (directCalls.get(resourceId) ?? 0) + 1
      directCalls.set(resourceId, count)
      if (count === 2) throw new Error('HTTP 503: permission service unavailable')
      return exactReadAffordance(['read'])
    })
    setComposerDraft('chat-1', 'keep this text', 'agent-1')
    await renderComposer()
    const textarea = screen.getByTestId('chat-input') as HTMLTextAreaElement
    textarea.setSelectionRange(4, 9)
    fireEvent.select(textarea)
    const insertItem = await openNestedResource()
    const selection = [textarea.selectionStart, textarea.selectionEnd]
    const beforeRevision = getComposerDraftRevision('chat-1', 'agent-1')
    const setSelection = vi.spyOn(textarea, 'setSelectionRange')

    fireEvent.click(insertItem)
    expect((await screen.findByRole('alert')).textContent).toContain(
      'permission service unavailable'
    )
    expect(getComposerDraft('chat-1', 'agent-1')).toBe('keep this text')
    expect(getComposerDraftRevision('chat-1', 'agent-1')).toBe(beforeRevision)
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual(selection)
    expect(setSelection).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Insert link to Release notes.md' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(directCalls.get(note.resourceId)).toBe(3)
    await waitFor(() =>
      expect(getComposerDraft('chat-1', 'agent-1')).toBe(`keep this${note.gfsUri}  text`)
    )
  })

  it('revokes picker authority and clears GFS cache after a picker-owned 401', async () => {
    const producers = installProducers()
    const { queryClient } = await renderComposer()
    const insertItem = await openNestedResource()
    expect(insertItem).toBeTruthy()
    producers.affordances.mockRejectedValueOnce(new Error('HTTP 401 Unauthorized'))

    act(() =>
      rendererEntityChangeRegistry.dispatch({
        type: 'scope.invalidated',
        schemaVersion: 1,
        cursor: 'composer-picker-401',
        scopes: ['gfs', 'authorization'],
      })
    )

    await waitFor(() => {
      const accessState = queryClient
        .getQueryCache()
        .findAll({ queryKey: ['desktop-app', 'gfs-access'] })
        .map(query => query.state.data)
      expect(accessState).toContain('revoked')
    })
    expect(screen.queryByRole('menuitem', { name: 'Insert link to Release notes.md' })).toBeNull()
    expect(
      queryClient
        .getQueryCache()
        .findAll({ queryKey: ['desktop-app', 'gfs'] })
        .filter(query => query.queryKey[2] !== 'gfs-open-locations')
        .every(query => query.state.data === undefined)
    ).toBe(true)
    expect(getComposerDraft('chat-1', 'agent-1')).toBe('')
  })

  it('revokes session authority when the fresh direct picker check returns 401', async () => {
    const producers = installProducers()
    const noteCalls = new Map<string, number>()
    producers.affordances.mockImplementation(async resourceId => {
      if (resourceId !== note.resourceId) return exactReadAffordance(['read'])
      const count = (noteCalls.get(resourceId) ?? 0) + 1
      noteCalls.set(resourceId, count)
      if (count === 2) throw new Error('HTTP 401 Unauthorized')
      return exactReadAffordance(['read'])
    })
    const { queryClient } = await renderComposer()
    const insertItem = await openNestedResource()
    const beforeRevision = getComposerDraftRevision('chat-1', 'agent-1')

    fireEvent.click(insertItem)
    await waitFor(() => {
      const accessState = queryClient
        .getQueryCache()
        .findAll({ queryKey: ['desktop-app', 'gfs-access'] })
        .map(query => query.state.data)
      expect(accessState).toContain('revoked')
    })

    expect(getComposerDraft('chat-1', 'agent-1')).toBe('')
    expect(getComposerDraftRevision('chat-1', 'agent-1')).toBe(beforeRevision)
    expect(screen.queryByRole('menuitem', { name: 'Insert link to Release notes.md' })).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('401')
  })

  it('revokes session authority when the fresh direct picker check returns 401', async () => {
    const producers = installProducers()
    const noteCalls = new Map<string, number>()
    producers.affordances.mockImplementation(async resourceId => {
      if (resourceId !== note.resourceId) return exactReadAffordance(['read'])
      const count = (noteCalls.get(resourceId) ?? 0) + 1
      noteCalls.set(resourceId, count)
      if (count === 2) throw new Error('HTTP 401 Unauthorized')
      return exactReadAffordance(['read'])
    })
    const { queryClient } = await renderComposer()
    const insertItem = await openNestedResource()
    const beforeRevision = getComposerDraftRevision('chat-1', 'agent-1')

    fireEvent.click(insertItem)
    await waitFor(() => {
      const accessState = queryClient
        .getQueryCache()
        .findAll({ queryKey: ['desktop-app', 'gfs-access'] })
        .map(query => query.state.data)
      expect(accessState).toContain('revoked')
    })

    expect(getComposerDraft('chat-1', 'agent-1')).toBe('')
    expect(getComposerDraftRevision('chat-1', 'agent-1')).toBe(beforeRevision)
    expect(screen.queryByRole('menuitem', { name: 'Insert link to Release notes.md' })).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('401')
  })

  it('suppresses a duplicate activation while the direct authorization is pending', async () => {
    const producers = installProducers()
    const directResults: Array<(value: ReturnType<typeof exactReadAffordance>) => void> = []
    let noteCalls = 0
    producers.affordances.mockImplementation(async resourceId => {
      if (resourceId !== note.resourceId) return exactReadAffordance(['read'])
      noteCalls += 1
      if (noteCalls === 1) return exactReadAffordance(['read'])
      return new Promise(resolve => directResults.push(resolve))
    })
    setComposerDraft('chat-1', 'keep this text', 'agent-1')
    await renderComposer()
    const textarea = screen.getByTestId('chat-input') as HTMLTextAreaElement
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    fireEvent.select(textarea)
    const insert = await openNestedResource()

    fireEvent.click(insert)
    await waitFor(() => expect(noteCalls).toBe(2))
    fireEvent.click(insert)
    expect(noteCalls).toBe(2)
    expect(getComposerDraft('chat-1', 'agent-1')).toBe('keep this text')

    await act(async () => directResults[0]!(exactReadAffordance(['read'])))
    await waitFor(() =>
      expect(getComposerDraft('chat-1', 'agent-1')).toBe(`keep this text${note.gfsUri} `)
    )
    expect(noteCalls).toBe(2)
  })

  it('isolates pending insertion locks and errors by composer owner', async () => {
    const producers = installProducers()
    setComposerDraft('chat-1', 'draft A', 'agent-1')
    const view = await renderComposer()
    const firstInsert = await openNestedResource()
    let rejectFirst!: (error: Error) => void
    let deferFirst = true
    producers.affordances.mockImplementation(async resourceId => {
      if (resourceId === note.resourceId && deferFirst) {
        deferFirst = false
        return new Promise((_, reject) => {
          rejectFirst = reject
        })
      }
      return exactReadAffordance(['read'])
    })

    fireEvent.click(firstInsert)
    await waitFor(() => expect(rejectFirst).toBeTypeOf('function'))

    composerState.activeChatId = 'chat-2'
    setComposerDraft('chat-2', 'draft B', 'agent-1')
    view.rerenderComposer()
    const secondInsert = await openNestedResource()
    let resolveSecond!: (value: ReturnType<typeof exactReadAffordance>) => void
    let deferSecond = true
    producers.affordances.mockImplementation(async resourceId => {
      if (resourceId === note.resourceId && deferSecond) {
        deferSecond = false
        return new Promise(resolve => {
          resolveSecond = resolve
        })
      }
      return exactReadAffordance(['read'])
    })
    const noteCallsBeforeSecondDirect = producers.affordances.mock.calls.filter(
      ([resourceId]) => resourceId === note.resourceId
    ).length
    fireEvent.click(secondInsert)
    await waitFor(() => expect(resolveSecond).toBeTypeOf('function'))
    expect(
      producers.affordances.mock.calls.filter(([resourceId]) => resourceId === note.resourceId)
    ).toHaveLength(noteCallsBeforeSecondDirect + 1)

    await act(async () => {
      rejectFirst(new Error('HTTP 503: old composer permission failure'))
      await Promise.resolve()
    })
    fireEvent.click(secondInsert)
    expect(
      producers.affordances.mock.calls.filter(([resourceId]) => resourceId === note.resourceId)
    ).toHaveLength(noteCallsBeforeSecondDirect + 1)
    expect(getComposerDraft('chat-2', 'agent-1')).toBe('draft B')

    await waitFor(() => expect(resolveSecond).toBeTypeOf('function'))
    await act(async () => resolveSecond(exactReadAffordance(['read'])))
    await waitFor(() =>
      expect(getComposerDraft('chat-2', 'agent-1')).toBe(`${note.gfsUri} draft B`)
    )
    expect(getComposerDraft('chat-1', 'agent-1')).toBe('draft A')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(getComposerDraft('chat-2', 'agent-1')).toBe(`${note.gfsUri} draft B`)
  })

  it('rejects a real selection-range change even when its insertion anchor is unchanged', async () => {
    const scheduler = fc.sample(fc.scheduler(), { seed: 12931153, numRuns: 1 })[0]!
    const scheduledDirect = scheduler.scheduleFunction(
      async (value: ReturnType<typeof exactReadAffordance>) => value
    )
    const listAccessible = vi.fn(async () => listAccessiblePage([folderA]))
    const listChildren = vi.fn(async (resourceId: string) =>
      listChildrenPage(resourceId === folderA.resourceId ? [folderB] : [note])
    )
    let noteCalls = 0
    let scheduledDecision: Promise<ReturnType<typeof exactReadAffordance>> | null = null
    const affordances = vi.fn((resourceId: string) => {
      if (resourceId !== note.resourceId) return Promise.resolve(exactReadAffordance(['read']))
      noteCalls += 1
      if (noteCalls === 1 || noteCalls > 2) {
        return Promise.resolve(exactReadAffordance(['read']))
      }
      scheduledDecision = scheduledDirect(exactReadAffordance(['read']))
      return scheduledDecision
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        workflows: {
          list: vi.fn(async (): Promise<WorkflowRecipeListResult> => ({ items: [], count: 0 })),
        },
        gfs: { listAccessible, listChildren, affordances },
        auth: { getSessionGeneration: vi.fn(async () => 1) },
      } as unknown as Window['clerum'],
    })
    setComposerDraft('chat-1', 'abcdefgh', 'agent-1')
    await renderComposer()
    const textarea = screen.getByTestId('chat-input') as HTMLTextAreaElement
    textarea.setSelectionRange(4, 4)
    fireEvent.select(textarea)
    const insert = await openNestedResource()
    fireEvent.click(insert)
    await waitFor(() => expect(noteCalls).toBe(2))
    expect(getComposerDraft('chat-1', 'agent-1')).toBe('abcdefgh')

    const delayedDecision = scheduledDecision
    expect(delayedDecision).not.toBeNull()
    // Keep the selection end/anchor stable so only the captured selection guard
    // can reject this changed range before the synchronous draft write.
    textarea.setSelectionRange(2, 4)
    fireEvent.select(textarea)
    await act(async () => scheduler.waitNext(1))
    await delayedDecision
    expect(getComposerDraft('chat-1', 'agent-1')).toBe('abcdefgh')

    fireEvent.click(insert)
    await waitFor(() =>
      expect(getComposerDraft('chat-1', 'agent-1')).toBe(`abcd${note.gfsUri} efgh`)
    )
    expect(affordances).toHaveBeenCalledTimes(5)
  })

  it('fences a stale committed row synchronously on a received authorization event', async () => {
    const producers = installProducers()
    setComposerDraft('chat-1', 'keep this text', 'agent-1')
    await renderComposer()
    const textarea = screen.getByTestId('chat-input') as HTMLTextAreaElement
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    fireEvent.select(textarea)
    const insert = await openNestedResource()
    const directCallsBefore = producers.affordances.mock.calls.length
    act(() => {
      rendererEntityChangeRegistry.dispatch({
        type: 'scope.invalidated',
        schemaVersion: 1,
        cursor: 'event-before-react-commit',
        scopes: ['gfs', 'authorization'],
      })
      fireEvent.click(insert)
    })
    // Let any D3 continuation settle before observing the draft. The control
    // was still committed when the event and click ran in the same act; if D1's
    // synchronous passive-authority guard is absent, D3's valid direct allow
    // can otherwise write before this assertion observes the result.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(getComposerDraft('chat-1', 'agent-1')).toBe('keep this text')
    expect(producers.affordances).toHaveBeenCalledTimes(directCallsBefore + 1)

    await waitFor(() =>
      expect(producers.affordances.mock.calls.length).toBeGreaterThan(directCallsBefore)
    )
    const recoveredInsert = await screen.findByRole('menuitem', {
      name: 'Insert link to Release notes.md',
    })
    fireEvent.click(recoveredInsert)
    await waitFor(() =>
      expect(getComposerDraft('chat-1', 'agent-1')).toBe(`keep this text${note.gfsUri} `)
    )
  })

  it('keeps the newer insertion caret receipt when an obsolete RAF cleanup runs', async () => {
    const rafCallbacks: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      rafCallbacks.push(callback)
      return rafCallbacks.length
    })
    const listAccessible = vi.fn(async () => listAccessiblePage([folderA]))
    const listChildren = vi.fn(async (resourceId: string) =>
      listChildrenPage(resourceId === folderA.resourceId ? [folderB] : [note])
    )
    let noteCalls = 0
    const directResults: Array<(value: ReturnType<typeof exactReadAffordance>) => void> = []
    const affordances = vi.fn((resourceId: string) => {
      if (resourceId !== note.resourceId) return Promise.resolve(exactReadAffordance(['read']))
      noteCalls += 1
      if (noteCalls === 1) return Promise.resolve(exactReadAffordance(['read']))
      return new Promise<ReturnType<typeof exactReadAffordance>>(resolve => {
        directResults.push(resolve)
      })
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        workflows: {
          list: vi.fn(async (): Promise<WorkflowRecipeListResult> => ({ items: [], count: 0 })),
        },
        gfs: { listAccessible, listChildren, affordances },
        auth: { getSessionGeneration: vi.fn(async () => 1) },
      } as unknown as Window['clerum'],
    })
    setComposerDraft('chat-1', 'abcdefgh', 'agent-1')
    await renderComposer()
    const textarea = screen.getByTestId('chat-input') as HTMLTextAreaElement
    await act(async () => rafCallbacks[0]?.(0))
    textarea.setSelectionRange(4, 4)
    fireEvent.select(textarea)

    const insert = await openNestedResource()
    fireEvent.click(insert)
    await waitFor(() => expect(noteCalls).toBe(2))
    await act(async () => directResults[0]!(exactReadAffordance(['read'])))
    await waitFor(() =>
      expect(getComposerDraft('chat-1', 'agent-1')).toBe(`abcd${note.gfsUri} efgh`)
    )
    expect(rafCallbacks).toHaveLength(2)

    textarea.setSelectionRange(1, 1)
    fireEvent.select(textarea)
    fireEvent.click(insert)
    await waitFor(() => expect(noteCalls).toBe(3))
    await act(async () => directResults[1]!(exactReadAffordance(['read'])))
    const expectedDraft = `a${note.gfsUri} bcd${note.gfsUri} efgh`
    await waitFor(() => expect(getComposerDraft('chat-1', 'agent-1')).toBe(expectedDraft))
    expect(rafCallbacks).toHaveLength(3)

    textarea.setSelectionRange(0, 0)
    await act(async () => rafCallbacks[1]!(0))
    await act(async () => rafCallbacks[2]!(0))
    const secondInsertionEnd = 1 + note.gfsUri.length + 1
    expect(textarea.value).toBe(expectedDraft)
    expect(getComposerDraft('chat-1', 'agent-1')).toBe(expectedDraft)
    expect(textarea.selectionStart).toBe(secondInsertionEnd)
    expect(textarea.selectionEnd).toBe(secondInsertionEnd)
    expect(document.activeElement).toBe(textarea)
  })

  it('preserves a newer user selection when the accepted insertion RAF runs', async () => {
    const rafCallbacks: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      rafCallbacks.push(callback)
      return rafCallbacks.length
    })
    const producers = installProducers()
    const directResults: Array<(value: ReturnType<typeof exactReadAffordance>) => void> = []
    let noteCalls = 0
    producers.affordances.mockImplementation(async resourceId => {
      if (resourceId !== note.resourceId) return exactReadAffordance(['read'])
      noteCalls += 1
      if (noteCalls === 1) return exactReadAffordance(['read'])
      return new Promise(resolve => directResults.push(resolve))
    })
    setComposerDraft('chat-1', 'abcdefgh', 'agent-1')
    await renderComposer()
    const textarea = screen.getByTestId('chat-input') as HTMLTextAreaElement
    await act(async () => rafCallbacks[0]?.(0))
    textarea.setSelectionRange(4, 4)
    fireEvent.select(textarea)

    fireEvent.click(await openNestedResource())
    await waitFor(() => expect(noteCalls).toBe(2))
    await act(async () => directResults[0]!(exactReadAffordance(['read'])))
    const inserted = `abcd${note.gfsUri} efgh`
    await waitFor(() => expect(getComposerDraft('chat-1', 'agent-1')).toBe(inserted))
    expect(rafCallbacks).toHaveLength(2)
    const revisionAfterWrite = getComposerDraftRevision('chat-1', 'agent-1')

    textarea.setSelectionRange(2, 2)
    fireEvent.select(textarea)
    await act(async () => rafCallbacks[1]!(0))

    expect(textarea.value).toBe(inserted)
    expect(getComposerDraft('chat-1', 'agent-1')).toBe(inserted)
    expect(getComposerDraftRevision('chat-1', 'agent-1')).toBe(revisionAfterWrite)
    expect(textarea.selectionStart).toBe(2)
    expect(textarea.selectionEnd).toBe(2)
  })
})
