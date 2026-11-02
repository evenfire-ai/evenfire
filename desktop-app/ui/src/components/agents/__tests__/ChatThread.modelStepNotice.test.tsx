// @vitest-environment jsdom
/**
 * #1044 — `ChatThread` mounts the model-step notice from the context state of
 * the ACTIVE chat. The gate is
 * `activeChatId && selectedAgent && (modelStepCheckpoint || modelStepRetry?.unavailable)`
 * (`ChatThread.tsx:999`); these cases mount the real `ChatThread`, the real
 * `ModelStepRetryNotice` and the real wire reader (views come from the C0
 * contract fixtures), and pin each term of the gate with its own witness.
 *
 * The composer's "Retry last send" banner is NOT asserted here: it lives in
 * `ComposerPanel` and this mount does not render it, so a "no banner" query
 * would be true by construction. That negative is proven where it can fail:
 * `useAgentChatController.modelStep.test.tsx` (`failedAgentSend`/`agentError`
 * null) and the E2E `expectResumable` of C1/C3.
 *
 * The two context fields come from the controller return
 * (`useAgentChatController.ts:5003-5004`) through `useAppController.ts:1620-1621`
 * into `App.tsx:2689-2690`. They are required on
 * `ChatThreadStateContextValue`, so omitting them is a `tsc` error; hardcoding
 * `null` in `App.tsx` would compile and this file would not notice it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseModelStepCheckpointView } from '../../../../../src/modelStepCheckpointWire'
import type { ModelStepCheckpointView } from '../../../../../src/types'
import { buildLoadedChatSemanticModels } from '../../../lib/chatMessageSemantics'
import type { AgentChatMessage, ModelStepRetryState } from '../../../uiTypes'
import { ChatThread } from '../ChatThread'

const navigationValue = {
  selectedAgent: 'agent-x' as string | null,
  handleSelectChatAgent: vi.fn(),
}
const notificationsValue = { decideApproval: vi.fn(), pushToast: vi.fn() }
const chatListValue = {
  chatList: [],
  chatListLoading: false,
  sessionStateByChatId: {},
}
const actionsValue = {
  chatEndRef: { current: null },
  handleSelectChat: vi.fn(),
  handleRenameChat: vi.fn(),
  handleDeleteChat: vi.fn(),
  handleRetryModelStep: vi.fn(),
}
const runtimeValue = { cancelTask: vi.fn() }
const requestComposerFocus = vi.fn()
const composerStateValue = {
  composerImageAttachments: [] as never[],
  composerReferenceAttachments: [] as never[],
}
let messages: AgentChatMessage[] = []
let groupedMessages: Array<{ role: 'user' | 'assistant' | 'system'; items: AgentChatMessage[] }> =
  []
let checkpoint: ModelStepCheckpointView | null = null
let retry: ModelStepRetryState | null = null
let activeChatId: string | null = 'chat-1'

vi.mock('@contexts/NavigationContext', () => ({
  useNavigationContext: () => navigationValue,
}))
vi.mock('@contexts/NotificationsContext', () => ({
  useNotificationsContext: () => notificationsValue,
}))
vi.mock('@contexts/ChatComposerStateContext', () => ({
  useChatComposerStateContext: () => ({
    composerImageAttachments: composerStateValue.composerImageAttachments,
    composerReferenceAttachments: composerStateValue.composerReferenceAttachments,
    requestComposerFocus,
  }),
}))
vi.mock('@contexts/ChatListContext', () => ({
  useChatListContext: () => chatListValue,
}))
vi.mock('@contexts/AgentChatActionsContext', () => ({
  useAgentChatActionsContext: () => actionsValue,
}))
vi.mock('@contexts/McpRuntimeContext', () => ({
  useMcpRuntimeContext: () => runtimeValue,
}))
vi.mock('@contexts/ChatThreadStateContext', () => ({
  useChatThreadStateContext: () => ({
    activeMessages: messages,
    groupedMessages,
    chatMessagesLoading: false,
    hasOlderMessages: false,
    olderMessagesLoading: false,
    handleLoadOlderMessages: vi.fn(),
    activeChatId,
    activityByMessageId: {},
    progressByMessageId: {},
    localSearchQuery: '',
    localSearchCurrentMatch: null,
    semanticModelsByMessageId: new Map(
      buildLoadedChatSemanticModels(messages).map(model => [model.messageId, model])
    ),
    modelStepCheckpoint: checkpoint,
    modelStepRetry: retry,
  }),
}))
vi.mock('../InFlightAssistantPlaceholder', () => ({ InFlightAssistantPlaceholder: () => null }))
vi.mock('../NudgeArea', () => ({ NudgeArea: () => null }))
vi.mock('../ChatStateBadge', () => ({ ChatStateBadge: () => null }))
vi.mock('@components/MessageArtifactActions', () => ({ MessageArtifactActions: () => null }))

function view(name: string): ModelStepCheckpointView {
  return parseModelStepCheckpointView(
    JSON.parse(
      readFileSync(
        resolve(__dirname, '../../../../../../tests/fixtures/model-step-checkpoint', name),
        'utf8'
      )
    )
  )
}

/** The failed turn the notice belongs to: a user prompt plus its error bubble. */
function failedTurn() {
  const user: AgentChatMessage = {
    id: 'user-1',
    role: 'user',
    content: 'run the 21 tool calls',
    timestamp: 1,
  }
  const error: AgentChatMessage = {
    id: 'assistant-error',
    role: 'assistant',
    content: 'The provider is unavailable.',
    timestamp: 2,
    isError: true,
    errorCode: 'LLM_MODEL_OVERLOADED',
  }
  messages = [user, error]
  groupedMessages = [
    { role: 'user', items: [user] },
    { role: 'assistant', items: [error] },
  ]
}

afterEach(() => {
  cleanup()
  messages = []
  groupedMessages = []
  checkpoint = null
  retry = null
  activeChatId = 'chat-1'
  navigationValue.selectedAgent = 'agent-x'
  composerStateValue.composerImageAttachments = []
  composerStateValue.composerReferenceAttachments = []
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ChatThread model-step notice (#1044)', () => {
  it('mounts the resumable notice for the active chat and wires Retry', () => {
    failedTurn()
    checkpoint = view('session-view.resumable.json')
    retry = { pending: false, error: null }
    activeChatId = 'chat-1'

    render(<ChatThread />)

    const notice = screen.getByTestId('model-step-retry-notice')
    expect(notice.dataset.status).toBe('resumable')
    expect(notice.textContent).toContain('The provider was unavailable before this turn finished.')
    expect(notice.textContent).toContain('21 tool calls already completed and will not run again.')
    const btn = screen.getByTestId('model-step-retry-btn') as HTMLButtonElement
    // Plain DOM property: the copied harness does not use jest-dom matchers.
    expect(btn.disabled).toBe(false)
    expect(btn.textContent).toContain('Retry model step')

    fireEvent.click(btn)
    expect(actionsValue.handleRetryModelStep).toHaveBeenCalledTimes(1)

    // The notice is the ONLY model-step action; the copy never sends the user to
    // Resend.
    expect(screen.getAllByTestId('model-step-retry-btn')).toHaveLength(1)
    expect(notice.textContent).not.toContain('Send the message again')

    // Different affordance, must survive: the error bubble's inline Resend icon
    // does not depend on the checkpoint.
    expect(screen.getByRole('button', { name: 'Resend prompt' })).toBeTruthy()
  })

  it('renders the blocked reason with no Retry button', () => {
    failedTurn()
    checkpoint = view('session-view.blocked.json')
    retry = { pending: false, error: null }

    render(<ChatThread />)

    const notice = screen.getByTestId('model-step-retry-notice')
    expect(notice.dataset.status).toBe('blocked')
    expect(notice.textContent).toContain('The model this turn used is no longer available.')
    expect(notice.textContent).toContain('Send the message again to start a new turn.')
    expect(screen.queryByTestId('model-step-retry-btn')).toBeNull()
  })

  it('renders nothing for a claimed checkpoint (the stepper is the surface)', () => {
    failedTurn()
    checkpoint = view('session-view.claimed.json')

    const { rerender } = render(<ChatThread />)
    expect(screen.queryByTestId('model-step-retry-notice')).toBeNull()

    // Witness: the same tree DOES render the notice for a resumable view, so the
    // absence above is the claimed status and not a broken mount.
    checkpoint = view('session-view.resumable.json')
    rerender(<ChatThread />)
    expect(screen.getByTestId('model-step-retry-notice').dataset.status).toBe('resumable')
  })

  it('keeps the unavailable notice after a not_found answer', () => {
    failedTurn()
    checkpoint = view('session-view.resumable.json')
    retry = { pending: false, error: null }

    const { rerender } = render(<ChatThread />)
    expect(screen.queryByTestId('model-step-retry-notice')?.dataset.status).toBe('resumable')

    // The controller cleared the checkpoint and recorded the not_found answer.
    checkpoint = null
    retry = { pending: false, error: null, unavailable: true }
    rerender(<ChatThread />)

    const notice = screen.getByTestId('model-step-retry-notice')
    expect(notice.dataset.status).toBe('unavailable')
    expect(notice.textContent).toContain('This model step can no longer be retried.')
    expect(screen.queryByTestId('model-step-retry-btn')).toBeNull()
  })

  it('does not mount the notice without an active chat', () => {
    failedTurn()
    checkpoint = view('session-view.resumable.json')
    activeChatId = null

    const { rerender } = render(<ChatThread />)
    expect(screen.queryByTestId('model-step-retry-notice')).toBeNull()

    // Witness: the same fixture mounts once the chat is active again.
    activeChatId = 'chat-1'
    rerender(<ChatThread />)
    expect(screen.getByTestId('model-step-retry-notice')).toBeTruthy()
  })

  it('does not mount the notice without a selected agent', () => {
    failedTurn()
    checkpoint = view('session-view.resumable.json')
    navigationValue.selectedAgent = null

    const { rerender } = render(<ChatThread />)
    expect(screen.queryByTestId('model-step-retry-notice')).toBeNull()

    // Witness: the same fixture mounts once an agent is selected again.
    navigationValue.selectedAgent = 'agent-x'
    rerender(<ChatThread />)
    expect(screen.getByTestId('model-step-retry-notice')).toBeTruthy()
  })
})
