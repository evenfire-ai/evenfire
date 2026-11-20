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
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FILE_REFERENCE_MAX_COUNT } from '@clerum/gfs-interaction-policy'
import { DESKTOP_ROUTES } from '@constants/navigation'
import { useComposerAttachments } from '@hooks/domain/useComposerAttachments'
import { resetComposerDraftStore } from '@lib/composerDraftStore'
import type { HostRuntimeStatus } from '../../../../../src/types'
import { listAccessiblePage } from '../../../gfs/__fixtures__/gfsProducerFixtures'
import {
  fileView,
  pickerController,
  suggestedCandidate,
} from '../../../hooks/__tests__/__fixtures__/tabReferenceSuggestionFixtures'
import type { ComposerGlobalFileReference } from '../../../uiTypes'
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
  candidate: ComposerGlobalFileReference | null
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
  const suggestion = useMemo<TabReferenceSuggestionValue>(
    () => ({ candidate, accept: composer.addSuggestedFileReference }),
    [candidate, composer.addSuggestedFileReference]
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

function liveRegion(container: HTMLElement): HTMLElement {
  const region = Array.from(container.querySelectorAll<HTMLElement>('[aria-live="polite"]')).find(
    element => element.className === 'visually-hidden'
  )
  if (!region) throw new Error('the composer has no polite live region')
  return region
}

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

describe('ComposerPanel — suggested reference chip', () => {
  it('shows the chip with no attachments at all, outside the attachment count', async () => {
    const candidate = await suggestedCandidate(await fileView(1, 'report.md'))
    render(<Harness candidate={candidate} />)
    expect(chip()).toBeTruthy()
    expect(screen.queryByTestId('composer-attachments-count')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Clear all attachments' })).toBeNull()
  })

  it('stays outside the attachment row: not counted and not cleared by Clear all', async () => {
    const candidate = await suggestedCandidate(await fileView(1, 'report.md'))
    // The picker lists another file; attaching it fills the row next to the chip.
    hookMock.useGfsBrowserController.mockReturnValue(
      pickerController((await listAccessiblePage([await fileView(2, 'notes.md')])).items)
    )
    render(<Harness candidate={candidate} />)
    await openMenuItem('EvenDrive')
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Attach 1' }))
    expect(screen.getByTestId('composer-attachments-count').textContent).toBe('1 attachment')
    expect(chip()).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clear all attachments' }))
    expect(chip()).toBeTruthy()
  })

  it('attaches the file on click, hides the chip and leaves the focus in the message box', async () => {
    const candidate = await suggestedCandidate(await fileView(1, 'report.md'))
    render(<Harness candidate={candidate} />)
    fireEvent.click(chip()!)
    expect(screen.getByTestId('composer-attachments-count').textContent).toBe('1 attachment')
    expect(screen.getByRole('button', { name: 'Remove report.md' })).toBeTruthy()
    expect(chip()).toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('chat-input'))
  })

  it('keeps a visible send error on screen after the chip attaches its file', async () => {
    const candidate = await suggestedCandidate(await fileView(1, 'report.md'))
    render(<Harness candidate={candidate} initialError="The agent could not be reached." />)
    expect(screen.getByRole('alert').textContent).toContain('The agent could not be reached.')
    fireEvent.click(chip()!)
    expect(screen.getByRole('button', { name: 'Remove report.md' })).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('The agent could not be reached.')
  })

  it('offers nothing once the picker attached the same file', async () => {
    const view = await fileView(1, 'report.md')
    const candidate = await suggestedCandidate(view)
    render(<Harness candidate={candidate} />)
    expect(chip()).toBeTruthy()
    hookMock.useGfsBrowserController.mockReturnValue(
      pickerController((await listAccessiblePage([view])).items)
    )
    await openMenuItem('EvenDrive')
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Attach 1' }))
    expect(screen.getByRole('button', { name: 'Remove report.md' })).toBeTruthy()
    expect(chip()).toBeNull()
  })

  it('hides the chip while the Global Files picker is open', async () => {
    const candidate = await suggestedCandidate(await fileView(1, 'report.md'))
    hookMock.useGfsBrowserController.mockReturnValue(pickerController([]))
    render(<Harness candidate={candidate} />)
    expect(chip()).toBeTruthy()
    await openMenuItem('EvenDrive')
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(chip()).toBeNull()
  })

  it('hides the chip while the Agent Files modal is open', async () => {
    const candidate = await suggestedCandidate(await fileView(1, 'report.md'))
    render(<Harness candidate={candidate} />)
    expect(chip()).toBeTruthy()
    await openMenuItem('Agent Files')
    expect(screen.getByRole('dialog', { name: 'Agent Files' })).toBeTruthy()
    expect(chip()).toBeNull()
  })

  it('offers nothing without a selected agent', async () => {
    const candidate = await suggestedCandidate(await fileView(1, 'report.md'))
    const { rerender } = render(<Harness candidate={candidate} />)
    expect(chip()).toBeTruthy()
    rerender(<Harness candidate={candidate} selectedAgent={null} />)
    expect(chip()).toBeNull()
  })

  it('offers nothing outside the drawer, where no provider is mounted', async () => {
    const candidate = await suggestedCandidate(await fileView(1, 'report.md'))
    render(<Harness candidate={candidate} provided={false} />)
    expect(screen.getByTestId('chat-input')).toBeTruthy()
    expect(chip()).toBeNull()
  })

  it('disables the chip while a message is sending, and says why', async () => {
    const candidate = await suggestedCandidate(await fileView(1, 'report.md'))
    const { rerender } = render(<Harness candidate={candidate} />)
    expect((chip() as HTMLButtonElement).disabled).toBe(false)
    rerender(<Harness candidate={candidate} agentSending />)
    expect((chip() as HTMLButtonElement).disabled).toBe(true)
    expect(chip()!.getAttribute('title')).toBe('Available once the message is sent')
  })

  it('disables the chip while the agent is degraded, and says why', async () => {
    const candidate = await suggestedCandidate(await fileView(1, 'report.md'))
    runtime.hostRuntimeStatus = {
      degraded: { reason: 'llm_key_missing', message: 'The LLM key is missing.' },
    } satisfies Partial<HostRuntimeStatus>
    render(<Harness candidate={candidate} />)
    expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).disabled).toBe(true)
    expect((chip() as HTMLButtonElement).disabled).toBe(true)
    expect(chip()!.getAttribute('title')).toBe('Unavailable while the agent is degraded')
  })

  it('disables the chip at the file cap and shows the reason', async () => {
    const views = await Promise.all(
      Array.from({ length: FILE_REFERENCE_MAX_COUNT }, (_, index) => fileView(10 + index))
    )
    const candidate = await suggestedCandidate(await fileView(1, 'report.md'))
    hookMock.useGfsBrowserController.mockReturnValue(
      pickerController((await listAccessiblePage(views)).items)
    )
    render(<Harness candidate={candidate} />)
    await openMenuItem('EvenDrive')
    for (const checkbox of screen.getAllByRole('checkbox')) fireEvent.click(checkbox)
    fireEvent.click(screen.getByRole('button', { name: `Attach ${FILE_REFERENCE_MAX_COUNT}` }))
    const reason = `A message can reference at most ${FILE_REFERENCE_MAX_COUNT} files`
    expect((chip() as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(reason)).toBeTruthy()
    expect(chip()!.getAttribute('aria-describedby')).toBe(screen.getByText(reason).id)
  })
})

describe('ComposerPanel — suggested reference announcement', () => {
  it('announces the chip when it appears and not again when the same file revalidates', async () => {
    const view = await fileView(1, 'report.md')
    const candidate = await suggestedCandidate(view)
    const { container, rerender } = render(<Harness candidate={null} />)
    const region = liveRegion(container)
    const mutations: MutationRecord[] = []
    const observer = new MutationObserver(records => mutations.push(...records))
    observer.observe(region, { childList: true, subtree: true, characterData: true })

    rerender(<Harness candidate={candidate} />)
    await waitFor(() => expect(region.textContent).toBe('Suggested reference: report.md'))
    expect(mutations.length).toBeGreaterThan(0)

    // The same file, re-resolved after a change, arrives as a new candidate.
    const revalidated = await suggestedCandidate(await fileView(1, 'report.md', 4))
    expect(revalidated).not.toBe(candidate)
    expect(revalidated.id).toBe(candidate.id)
    mutations.length = 0
    rerender(<Harness candidate={revalidated} />)
    await act(async () => {})
    observer.takeRecords().forEach(record => mutations.push(record))
    observer.disconnect()
    expect(chip()).toBeTruthy()
    expect(region.textContent).toBe('Suggested reference: report.md')
    expect(mutations).toEqual([])
  })

  it('does not announce again when the same file revalidates under a new name', async () => {
    const candidate = await suggestedCandidate(await fileView(1, 'report.md'))
    const { container, rerender } = render(<Harness candidate={candidate} />)
    const region = liveRegion(container)
    await waitFor(() => expect(region.textContent).toBe('Suggested reference: report.md'))
    const mutations: MutationRecord[] = []
    const observer = new MutationObserver(records => mutations.push(...records))
    observer.observe(region, { childList: true, subtree: true, characterData: true })

    // The file was renamed: re-resolved, it keeps its id and carries the new name.
    const renamed = await suggestedCandidate(await fileView(1, 'report-final.md', 4))
    expect(renamed.id).toBe(candidate.id)
    rerender(<Harness candidate={renamed} />)
    await act(async () => {})
    observer.takeRecords().forEach(record => mutations.push(record))
    observer.disconnect()
    expect(chip('report-final.md')).toBeTruthy()
    expect(mutations).toEqual([])
  })

  it('announces a different file when the suggestion moves to it', async () => {
    const report = await suggestedCandidate(await fileView(1, 'report.md'))
    const notes = await suggestedCandidate(await fileView(2, 'notes.md'))
    const { container, rerender } = render(<Harness candidate={report} />)
    const region = liveRegion(container)
    await waitFor(() => expect(region.textContent).toBe('Suggested reference: report.md'))
    rerender(<Harness candidate={notes} />)
    await waitFor(() => expect(region.textContent).toBe('Suggested reference: notes.md'))
  })
})
