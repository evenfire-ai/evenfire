// @vitest-environment jsdom
import { useCallback, useMemo, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentChatActionsProvider } from '@contexts/AgentChatActionsContext'
import type { AgentChatActionsContextValue } from '@contexts/AgentChatActionsContext'
import { ChatComposerStateProvider } from '@contexts/ChatComposerStateContext'
import type { ChatComposerStateContextValue } from '@contexts/ChatComposerStateContext'
import { NavigationContext, type NavigationContextValue } from '@contexts/NavigationContext'
import { TabReferenceSuggestionContext } from '@contexts/TabReferenceSuggestionContext'
import type { TabReferenceSuggestionValue } from '@contexts/TabReferenceSuggestionContext.types'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FILE_REFERENCE_MAX_COUNT } from '@clerum/gfs-interaction-policy'
import { DESKTOP_ROUTES } from '@constants/navigation'
import { LOCATION_REFERENCE_LIMIT_REASON } from '@constants/tabReferenceSuggestion'
import { useComposerAttachments } from '@hooks/domain/useComposerAttachments'
import { resetComposerDraftStore } from '@lib/composerDraftStore'
import type { HostRuntimeStatus } from '../../../../../src/types'
import { listAccessiblePage } from '../../../gfs/__fixtures__/gfsProducerFixtures'
import {
  fileView,
  folderView,
  pickerController,
  suggestedFolderCandidate,
} from '../../../hooks/__tests__/__fixtures__/tabReferenceSuggestionFixtures'
import type { SuggestedReference } from '../../../lib/tabReferenceSuggestion.types'
import { ComposerPanel } from '../ComposerPanel'

const hookMock = vi.hoisted(() => ({ useGfsBrowserController: vi.fn() }))
vi.mock('@hooks/domain/useGfsBrowserController', () => hookMock)

// The host's runtime projection; the renderer has no producer of its own for it.
const runtime = vi.hoisted(() => ({ hostRuntimeStatus: null as unknown }))
vi.mock('@contexts/McpRuntimeContext', () => ({
  useMcpRuntimeContext: () => ({
    hostRuntimeStatus: runtime.hostRuntimeStatus,
    activeLlmProvider: null,
  }),
}))
vi.mock('@hooks/domain/useContextsDataController', () => ({
  useContextsDataController: () => ({
    sharedFilesByContext: {
      'ctx-1': { loaded: true, loading: false, items: [{ path: 'notes.md', kind: 'file' }] },
    },
    refreshSharedFiles: vi.fn(),
  }),
}))
vi.mock('@hooks/domain/useMcpServersDataController', () => ({
  useMcpServersDataController: () => ({
    selectedAgentMcpServers: [],
    agentContextByName: { 'agent-1': 'ctx-1' },
    refresh: vi.fn(),
  }),
}))
vi.mock('@hooks/useHostModels', () => ({
  useHostModels: () => ({
    data: null,
    loading: false,
    saving: false,
    error: null,
    state: 'unloaded',
    effectiveModel: null,
    intentModel: null,
    pending: false,
    selectionUnsettled: false,
    conflicted: false,
    confirmedRevision: null,
    imageInput: { state: 'unknown', reason: 'model_unknown' },
    canAttachImages: false,
    imageBlockMessage: null,
    visualSendBlocked: false,
    selectModel: vi.fn(async () => true),
    clearError: vi.fn(),
    refresh: vi.fn(async () => undefined),
  }),
}))
vi.mock('@constants/agentFeatures', async importOriginal => ({
  ...(await importOriginal<typeof import('@constants/agentFeatures')>()),
  SHOW_AGENT_FILES_UI: true,
  SHOW_GLOBAL_FILE_SYSTEM_COMPOSER_ITEM: true,
}))
vi.mock('../ComposerAgentFilesModal', () => ({
  ComposerAgentFilesModal: () => <div role="dialog" aria-label="Agent Files" />,
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const noop = () => undefined
const asyncNoop = async () => undefined

type HarnessProps = {
  candidate: SuggestedReference | null
  selectedAgent?: string | null
  agentSending?: boolean
  initialError?: string | null
  /** `false` renders the panel without a provider, as the full-page chat does. */
  provided?: boolean
}

/**
 * The composer with its real attachment state behind it. The send error is
 * cleared the way the chat controller clears it, so a path that should not
 * clear it shows the difference on screen.
 */
function Harness({
  candidate,
  selectedAgent = 'agent-1',
  agentSending = false,
  initialError = null,
  provided = true,
}: HarnessProps) {
  const [agentError, setAgentError] = useState<string | null>(initialError)
  const clearSendError = useCallback(() => setAgentError(null), [])
  const composer = useComposerAttachments({ selectedAgent, clearSendError })
  const composerState: ChatComposerStateContextValue = {
    activeChatId: 'chat-1',
    workspaceChatTabId: null,
    composerImageAttachments: composer.composerImageAttachments,
    composerFileAttachments: composer.composerFileAttachments,
    composerFileRefusals: composer.composerFileRefusals,
    composerReferenceAttachments: composer.composerReferenceAttachments,
    agentSending,
    agentError,
    failedAgentSend: null,
    activeMessageCount: 1,
    composerFocusRequestId: 0,
    requestComposerFocus: noop,
  }
  const actions = {
    chatEndRef: { current: null },
    scrollChatToBottom: noop,
    handleCreateChat: asyncNoop,
    handleRenameChat: asyncNoop,
    handleRenameChatForAgent: asyncNoop,
    captureChatDeleteFence: vi.fn(),
    handleDeleteChat: asyncNoop,
    handleDeleteChatForAgent: asyncNoop,
    handleSelectChat: asyncNoop,
    clearComposerSendError: clearSendError,
    handleAddComposerImageAttachments: composer.handleAddComposerImageAttachments,
    handleUpdateComposerImageAttachment: composer.handleUpdateComposerImageAttachment,
    handleRemoveComposerImageAttachment: composer.handleRemoveComposerImageAttachment,
    handleAddComposerFiles: composer.handleAddComposerFiles,
    handleRemoveComposerFileAttachment: composer.handleRemoveComposerFileAttachment,
    handleAddComposerReferenceAttachments: composer.handleAddComposerReferenceAttachments,
    handleRemoveComposerReferenceAttachment: composer.handleRemoveComposerReferenceAttachment,
    handleClearComposerAttachments: composer.resetComposerAttachments,
    handleSendAgentMessage: asyncNoop,
    handleRetryFailedAgentSend: asyncNoop,
    handleRecoverFailedAgentSend: noop,
    handleDiscardFailedAgentSend: noop,
  } as unknown as AgentChatActionsContextValue
  const navigation = {
    navItem: DESKTOP_ROUTES.preview,
    selectedAgent,
    selectedAgentRoute: null,
    handleNavSelect: noop,
    handleOpenAgentWorkspace: noop,
    handleSelectChatAgent: noop,
    handleBackToAgents: noop,
  } as unknown as NavigationContextValue
  const { addSuggestedFileReference, addSuggestedLocationReference } = composer
  // Routes by kind, as App does for the drawer.
  const suggestion = useMemo<TabReferenceSuggestionValue>(
    () => ({
      candidate,
      accept: reference =>
        reference.type === 'global_folder'
          ? addSuggestedLocationReference(reference)
          : addSuggestedFileReference(reference),
    }),
    [candidate, addSuggestedFileReference, addSuggestedLocationReference]
  )
  const panel = <ComposerPanel />
  return (
    <NavigationContext.Provider value={navigation}>
      <ChatComposerStateProvider value={composerState}>
        <AgentChatActionsProvider value={actions}>
          {provided ? (
            <TabReferenceSuggestionContext.Provider value={suggestion}>
              {panel}
            </TabReferenceSuggestionContext.Provider>
          ) : (
            panel
          )}
        </AgentChatActionsProvider>
      </ChatComposerStateProvider>
    </NavigationContext.Provider>
  )
}

const chip = (label = 'report.md') =>
  screen.queryByRole('button', { name: `Reference ${label} in this message` })

async function openMenuItem(name: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
  await act(async () => {
    fireEvent.click(screen.getByRole('menuitem', { name }))
  })
}

beforeEach(() => {
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: { workflows: { list: vi.fn(async () => ({ items: [], count: 0 })) } },
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  runtime.hostRuntimeStatus = null
  resetComposerDraftStore()
  delete (window as { clerum?: unknown }).clerum
})

describe('ComposerPanel — suggested folder chip', () => {
  it('attaches the folder on click as a Global Folder chip and hides the suggestion', async () => {
    const candidate = await suggestedFolderCandidate(await folderView(1, 'Reports'))
    render(<Harness candidate={candidate} />)
    expect((chip('Reports') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(chip('Reports')!)
    expect(screen.getByTestId('composer-attachments-count').textContent).toBe('1 attachment')
    const attached = screen.getByRole('button', { name: 'Remove Reports' })
    expect(attached.closest('.composer-attachment-chip')?.getAttribute('title')).toBe(
      'Global Folder'
    )
    expect(chip('Reports')).toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('chat-input'))
  })

  it('S-F2: with another folder attached, the chip stays visible, disabled, and says why', async () => {
    const reports = await suggestedFolderCandidate(await folderView(1, 'Reports'))
    const invoices = await suggestedFolderCandidate(await folderView(2, 'Invoices'))
    const { rerender } = render(<Harness candidate={reports} />)
    fireEvent.click(chip('Reports')!)
    // Navigating to another folder suggests it next to the one attached.
    rerender(<Harness candidate={invoices} />)
    const blocked = chip('Invoices') as HTMLButtonElement
    expect(blocked).toBeTruthy()
    expect(blocked.disabled).toBe(true)
    const reason = screen.getByText(LOCATION_REFERENCE_LIMIT_REASON)
    expect(blocked.getAttribute('aria-describedby')).toBe(reason.id)
    expect(blocked.getAttribute('title')).toBe(LOCATION_REFERENCE_LIMIT_REASON)
    // The attached folder is not replaced.
    expect(screen.getByRole('button', { name: 'Remove Reports' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Remove Invoices' })).toBeNull()
  })

  it('S-F2: removing the attached folder enables the suggestion again', async () => {
    const reports = await suggestedFolderCandidate(await folderView(1, 'Reports'))
    const invoices = await suggestedFolderCandidate(await folderView(2, 'Invoices'))
    const { rerender } = render(<Harness candidate={reports} />)
    fireEvent.click(chip('Reports')!)
    rerender(<Harness candidate={invoices} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove Reports' }))
    expect((chip('Invoices') as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByText(LOCATION_REFERENCE_LIMIT_REASON)).toBeNull()
  })

  it('hides the chip once the same folder is attached', async () => {
    const reports = await suggestedFolderCandidate(await folderView(1, 'Reports'))
    const { rerender } = render(<Harness candidate={reports} />)
    fireEvent.click(chip('Reports')!)
    // The revalidated suggestion of the same folder offers nothing more.
    rerender(<Harness candidate={{ ...reports }} />)
    expect(chip('Reports')).toBeNull()
  })

  it('S-F11: ten attached files leave the folder chip enabled', async () => {
    const views = await Promise.all(
      Array.from({ length: FILE_REFERENCE_MAX_COUNT }, (_, index) => fileView(10 + index))
    )
    const candidate = await suggestedFolderCandidate(await folderView(3, 'Reports'))
    hookMock.useGfsBrowserController.mockReturnValue(
      pickerController((await listAccessiblePage(views)).items)
    )
    render(<Harness candidate={candidate} />)
    await openMenuItem('EvenDrive')
    for (const checkbox of screen.getAllByRole('checkbox')) fireEvent.click(checkbox)
    fireEvent.click(screen.getByRole('button', { name: `Attach ${FILE_REFERENCE_MAX_COUNT}` }))
    const folderChip = chip('Reports') as HTMLButtonElement
    expect(folderChip.disabled).toBe(false)
    expect(
      screen.queryByText(`A message can reference at most ${FILE_REFERENCE_MAX_COUNT} files`)
    ).toBeNull()
    fireEvent.click(folderChip)
    expect(screen.getByRole('button', { name: 'Remove Reports' })).toBeTruthy()
    expect(screen.getByTestId('composer-attachments-count').textContent).toBe(
      `${FILE_REFERENCE_MAX_COUNT + 1} attachments`
    )
  })
})
