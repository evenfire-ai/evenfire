// @vitest-environment jsdom
/**
 * BUG-176 — a user-attached image in a SENT message must be viewable. The
 * inert chip (image icon + filename) gains a preview trigger that opens the
 * shared `GfsImagePreview` modal with the attachment's inline base64 bytes
 * (no GFS round-trip). Legacy parsed `[Attached images]` chips (labels only,
 * no bytes) stay inert.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { buildLoadedChatSemanticModels } from '../../../lib/chatMessageSemantics'
import type { AgentChatMessage, TaskProgress } from '../../../uiTypes'
// vi.mock calls are hoisted above this import, so ChatThread binds the mocks.
import { ChatThread } from '../ChatThread'

const navValue = { selectedAgent: 'agent-x', handleSelectChatAgent: vi.fn() }
const notificationsValue = { decideApproval: vi.fn(), pushToast: vi.fn() }
const composerStateValue = {
  composerImageAttachments: [] as never[],
  composerReferenceAttachments: [] as never[],
  requestComposerFocus: vi.fn(),
}
const chatListValue = { chatList: [], chatListLoading: false, sessionStateByChatId: {} }
const actionsValue = {
  chatEndRef: { current: null },
  handleSelectChat: vi.fn(),
  handleRenameChat: vi.fn(),
  handleDeleteChat: vi.fn(),
}
const mcpRuntimeValue = { cancelTask: vi.fn() }
let messages: AgentChatMessage[] = []

vi.mock('@contexts/NavigationContext', () => ({ useNavigationContext: () => navValue }))
vi.mock('@contexts/NotificationsContext', () => ({
  useNotificationsContext: () => notificationsValue,
}))
vi.mock('@contexts/ChatComposerStateContext', () => ({
  useChatComposerStateContext: () => composerStateValue,
}))
vi.mock('@contexts/ChatListContext', () => ({ useChatListContext: () => chatListValue }))
vi.mock('@contexts/AgentChatActionsContext', () => ({
  useAgentChatActionsContext: () => actionsValue,
}))
vi.mock('@contexts/McpRuntimeContext', () => ({ useMcpRuntimeContext: () => mcpRuntimeValue }))
vi.mock('@contexts/ChatThreadStateContext', () => ({
  useChatThreadStateContext: () => ({
    activeMessages: messages,
    groupedMessages: [{ role: 'user', items: messages }],
    chatMessagesLoading: false,
    hasOlderMessages: false,
    olderMessagesLoading: false,
    handleLoadOlderMessages: vi.fn(),
    activeChatId: 'chat-1',
    activityByMessageId: {},
    progressByMessageId: {} as Record<string, TaskProgress>,
    localSearchQuery: '',
    localSearchCurrentMatch: null,
    semanticModelsByMessageId: new Map(
      buildLoadedChatSemanticModels(messages).map(model => [model.messageId, model])
    ),
  }),
}))
vi.mock('../InFlightAssistantPlaceholder', () => ({ InFlightAssistantPlaceholder: () => null }))
vi.mock('../NudgeArea', () => ({ NudgeArea: () => null }))
vi.mock('../ChatStateBadge', () => ({ ChatStateBadge: () => null }))
vi.mock('@components/MessageArtifactActions', () => ({ MessageArtifactActions: () => null }))

const actEnvGlobal = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvGlobal.IS_REACT_ACT_ENVIRONMENT = true

/** base64 of bytes [1, 2, 3] — small enough to decode synchronously. */
const PNG_BASE64 = 'AQID'

beforeEach(() => {
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:attachment-preview'),
  })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
})

afterEach(() => {
  cleanup()
  messages = []
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('ChatThread uploaded-image attachment preview (BUG-176)', () => {
  it('opens the shared GfsImagePreview modal when the sent-image chip is clicked', async () => {
    messages = [
      {
        id: 'msg-1',
        role: 'user',
        content: 'What is in this screenshot?',
        timestamp: 1,
        attachments: [
          {
            id: 'image-1',
            type: 'uploaded_file',
            label: 'Screenshot 2026-09-21 at 13.32.30.png',
            tooltip: 'Uploaded File - 1 KB',
            filename: 'Screenshot 2026-09-21 at 13.32.30.png',
            mimeType: 'image/png',
            encoding: 'base64',
            dataBase64: PNG_BASE64,
            sizeBytes: 3,
          },
        ],
      },
    ]
    render(<ChatThread />)

    // The chip body is a real button (same trigger contract as the composer).
    const trigger = screen.getByRole('button', { name: /Screenshot 2026-09-21/i })
    expect(trigger.classList.contains('message-attachment-preview-trigger')).toBe(true)
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(trigger)

    const dialog = await screen.findByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    const heading = screen.getByRole('heading', { name: /Screenshot 2026-09-21/i, level: 3 })
    expect(heading).toBeTruthy()
    const img = await screen.findByAltText(/Preview of Screenshot 2026-09-21/i)
    expect(img.getAttribute('src')).toBe('blob:attachment-preview')
  })

  it('closes the preview from the modal close button', async () => {
    messages = [
      {
        id: 'msg-2',
        role: 'user',
        content: 'and this one?',
        timestamp: 1,
        attachments: [
          {
            id: 'image-2',
            type: 'uploaded_file',
            label: 'photo.png',
            filename: 'photo.png',
            mimeType: 'image/png',
            encoding: 'base64',
            dataBase64: PNG_BASE64,
            sizeBytes: 3,
          },
        ],
      },
    ]
    render(<ChatThread />)
    fireEvent.click(screen.getByRole('button', { name: /photo\.png/i }))
    expect(await screen.findByRole('dialog')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Close image preview' }))

    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps chips inert when the attachment carries no image bytes (parsed history)', () => {
    messages = [
      {
        id: 'msg-3',
        role: 'user',
        content: 'legacy',
        timestamp: 1,
        attachments: [
          {
            id: 'parsed:uploaded_file:0:old-shot.png',
            type: 'uploaded_file',
            label: 'old-shot.png',
          },
          {
            id: 'pdf-1',
            type: 'uploaded_file',
            label: 'contract.pdf',
            mimeType: 'application/pdf',
          },
        ],
      },
    ]
    const { container } = render(<ChatThread />)

    expect(screen.getByText('old-shot.png')).toBeTruthy()
    expect(screen.getByText('contract.pdf')).toBeTruthy()
    // No trigger button and no preview modal for byte-less chips.
    expect(container.querySelector('.message-attachment-preview-trigger')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('estimates byteLength from base64 at 3/4, not raw length, when sizeBytes is absent (PR #859 review)', async () => {
    // base64 length 10,519,760 exceeds the 10,485,760-byte preview limit, so
    // the old raw-length fallback would early-skip the preview; the accurate
    // 3/4 estimate (7,889,820 bytes) is under the limit and must render.
    // Multiple of 4 so atob accepts it; decodes to 7,889,820 null bytes.
    const base64Length = 10 * 1024 * 1024 + 34_000
    messages = [
      {
        id: 'msg-4',
        role: 'user',
        content: 'big one',
        timestamp: 1,
        attachments: [
          {
            id: 'image-4',
            type: 'uploaded_file',
            label: 'big.png',
            filename: 'big.png',
            mimeType: 'image/png',
            encoding: 'base64',
            dataBase64: 'A'.repeat(base64Length),
          },
        ],
      },
    ]
    render(<ChatThread />)

    fireEvent.click(screen.getByRole('button', { name: /big\.png/i }))

    // Under the accurate estimate the preview opens instead of the size error.
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toBeTruthy()
    expect(await screen.findByAltText(/Preview of big\.png/i)).toBeTruthy()
  })
})
