// @vitest-environment jsdom
import React, { useLayoutEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext } from '@contexts/AuthContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import type { HostModelsResult } from '@hooks/useChatStore'
import * as composerDraftStore from '@lib/composerDraftStore'
import {
  getComposerDraft,
  resetComposerDraftStore,
  setComposerDraft,
} from '@lib/composerDraftStore'
import {
  accessibleResource,
  childView,
  listAccessiblePage,
  listChildrenPage,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
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
  SHOW_GLOBAL_FILE_SYSTEM_COMPOSER_ITEM: true,
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

function installProducers() {
  const listAccessible = vi.fn(async () => listAccessiblePage([folderA]))
  const listChildren = vi.fn(async (resourceId: string) =>
    listChildrenPage(resourceId === folderA.resourceId ? [folderB] : [note])
  )
  const affordances = vi.fn(async () => ({
    resourceId: folderA.resourceId,
    drive: 'main',
    read: true,
    write: true,
    delete: false,
    manageAcl: false,
    share: false,
  }))
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      workflows: {
        list: vi.fn(async (): Promise<WorkflowRecipeListResult> => ({ items: [], count: 0 })),
      },
      gfs: { listAccessible, listChildren, affordances },
    } as unknown as Window['clerum'],
  })
  return { listAccessible, listChildren }
}

async function renderComposer(onCommit?: () => void) {
  const auth = {
    isAuthenticated: true,
    sessionGeneration: 1,
    me: { id: 'user-1', email: 'user@example.test', teamId: null },
    authTransitioning: false,
    runtimeConfigState: { envKey: 'test' },
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(
    desktopQueryKeys.accessCatalog,
    await accessCatalogFromWire([{ name: 'agent-1', contextRef: null }])
  )
  function Harness() {
    useLayoutEffect(() => onCommit?.())
    return (
      <AuthContext.Provider value={auth as never}>
        <QueryClientProvider client={queryClient}>
          <ComposerPanel inline={false} />
        </QueryClientProvider>
      </AuthContext.Provider>
    )
  }
  const view = render(<Harness />)
  return { rerenderComposer: () => view.rerender(<Harness />) }
}

async function openNestedResource() {
  fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Insert EvenDrive link' }))
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

      await act(async () => {
        fireEvent.click(screen.getByRole('menuitem', { name: 'Insert link to Release notes.md' }))
      })
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
    view.rerenderComposer()
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
    installProducers()
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
    fireEvent.click(screen.getByRole('menuitem', { name: 'Insert link to Release notes.md' }))
    await waitFor(() =>
      expect(getComposerDraft(null, 'agent-1', 'tab-a')).toBe(`keep this${note.gfsUri}  text`)
    )
  })
})
