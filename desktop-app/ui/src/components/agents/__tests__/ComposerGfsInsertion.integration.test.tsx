// @vitest-environment jsdom
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext } from '@contexts/AuthContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { HostModelsResult } from '@hooks/useChatStore'
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

const composerState = {
  composerImageAttachments: [] as never[],
  composerFileAttachments: [] as never[],
  composerFileRefusals: [] as never[],
  composerReferenceAttachments: [] as never[],
  agentSending: false,
  agentError: null,
  failedAgentSend: null,
  activeChatId: 'chat-1',
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

afterEach(() => {
  cleanup()
  resetComposerDraftStore()
  Object.assign(composerState, {
    composerImageAttachments: [],
    composerFileAttachments: [],
    composerFileRefusals: [],
    composerReferenceAttachments: [],
    activeChatId: 'chat-1',
    activeMessageCount: 0,
    composerFocusRequestId: 0,
  })
  for (const action of Object.values(actionsMock)) action.mockReset()
  delete (window as Partial<typeof window>).clerum
})

describe('ComposerPanel producer-backed EvenDrive insertion', () => {
  it('inserts a browsed exact resource through the real picker and retains its session', async () => {
    const producers = installProducers()
    const initialDraft = 'keep this text'
    setComposerDraft('chat-1', initialDraft, 'agent-1')
    const auth = {
      isAuthenticated: true,
      me: { id: 'user-1', email: 'user@example.test', teamId: 'team-1' },
      authTransitioning: false,
      runtimeConfigState: { envKey: 'test' },
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(
      <AuthContext.Provider value={auth as never}>
        <QueryClientProvider client={queryClient}>
          <ComposerPanel inline={false} />
        </QueryClientProvider>
      </AuthContext.Provider>
    )

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

    const inserted = `keep this[Release notes.md](${note.gfsUri})  text`
    await waitFor(() => expect(getComposerDraft('chat-1', 'agent-1')).toBe(inserted))
    view.rerender(
      <AuthContext.Provider value={auth as never}>
        <QueryClientProvider client={queryClient}>
          <ComposerPanel inline={false} />
        </QueryClientProvider>
      </AuthContext.Provider>
    )
    await waitFor(() => expect(textarea.value).toBe(inserted))
    await waitFor(() => expect(document.activeElement).toBe(textarea))
    const caretAfterLink = inserted.indexOf('  text') + 1
    expect(textarea.selectionStart).toBe(caretAfterLink)
    expect(textarea.selectionEnd).toBe(caretAfterLink)

    expect(producers.listAccessible).toHaveBeenCalledOnce()
    expect(producers.listChildren).toHaveBeenCalledWith(folderA.resourceId, 'main', undefined)
    expect(producers.listChildren).toHaveBeenCalledWith(folderB.resourceId, 'main', undefined)
    expect(screen.getByRole('menuitem', { name: 'Insert link to Release notes.md' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    expect(actionsMock.handleSendAgentMessage).toHaveBeenCalledWith(inserted)

    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Insert link to Release notes.md' }))
    })
    const twiceInserted = `keep this[Release notes.md](${note.gfsUri}) [Release notes.md](${note.gfsUri})  text`
    await waitFor(() => expect(getComposerDraft('chat-1', 'agent-1')).toBe(twiceInserted))
    expect(producers.listChildren).toHaveBeenCalledTimes(2)
  })
})
