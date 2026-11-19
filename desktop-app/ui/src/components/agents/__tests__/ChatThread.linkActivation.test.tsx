// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatLinkActivationContext } from '@contexts/ChatLinkActivationContext'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { useNavigationController } from '@hooks/domain/useNavigationController'
import { createChatLinkActivation } from '@lib/chatLinkActivation'
import { activeWorkspaceTab } from '@lib/workspaceTabs'
import { resolveResource, resolvedDirectory } from '@/gfs/__fixtures__/gfsProducerFixtures'
import { buildLoadedChatSemanticModels } from '../../../lib/chatMessageSemantics'
import type { AgentChatMessage } from '../../../uiTypes'
import { ChatThread } from '../ChatThread'

const navigationValue = { selectedAgent: 'agent-x', handleSelectChatAgent: vi.fn() }
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
  captureChatDeleteFence: vi.fn(async () => {
    throw new Error('no delete target')
  }),
  handleDeleteChat: vi.fn(),
}
const runtimeValue = { cancelTask: vi.fn() }
let messages: AgentChatMessage[] = []
let groupedMessages: Array<{ role: 'user' | 'assistant'; items: AgentChatMessage[] }> = []

vi.mock('@contexts/NavigationContext', () => ({
  useNavigationContext: () => navigationValue,
}))
vi.mock('@contexts/NotificationsContext', () => ({
  useNotificationsContext: () => notificationsValue,
}))
vi.mock('@contexts/ChatComposerStateContext', () => ({
  useChatComposerStateContext: () => composerStateValue,
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
    activeChatId: 'chat-1',
    activityByMessageId: {},
    progressByMessageId: {},
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
// The artifact surfaces render inside the same `.markdown-content` block; an
// anchor there must stay outside the chat link policy.
vi.mock('@components/MessageArtifactActions', () => ({
  MessageArtifactActions: () => <a href="gfs://main/artifact0">artifact link</a>,
}))

const REPORTED_GFS_HREF = 'gfs://main/859df99de46b407bb0ec4b0f7cb424a5'

function renderThread(thread: Array<{ role: 'user' | 'assistant'; content: string }>) {
  messages = thread.map((entry, index) => ({
    id: `${entry.role}-${index}`,
    role: entry.role,
    content: entry.content,
    timestamp: index + 1,
  }))
  groupedMessages = messages.map(message => ({
    role: message.role as 'user' | 'assistant',
    items: [message],
  }))
  const activate = vi.fn(async (_href: string) => {})
  const view = render(
    <ChatLinkActivationContext.Provider value={activate}>
      <ChatThread />
    </ChatLinkActivationContext.Provider>
  )
  return { activate, view }
}

afterEach(() => {
  cleanup()
  messages = []
  groupedMessages = []
  vi.clearAllMocks()
})

describe('ChatThread assistant link activation', () => {
  it('hands the raw href of a clicked gfs link to the activation and prevents navigation', () => {
    const { activate } = renderThread([
      { role: 'assistant', content: `Carpeta creada: [test-subscription](${REPORTED_GFS_HREF}).` },
    ])
    const link = screen.getByRole('link', { name: 'test-subscription' })
    const notPrevented = fireEvent.click(link)
    expect(notPrevented).toBe(false)
    expect(activate.mock.calls).toEqual([[REPORTED_GFS_HREF]])
  })

  it('resolves the anchor from a click on a nested element and treats modifier clicks the same', () => {
    const { activate } = renderThread([
      { role: 'assistant', content: 'See [the **docs**](https://evenfire.ai/docs).' },
    ])
    const bold = screen.getByText('docs')
    expect(fireEvent.click(bold)).toBe(false)
    expect(fireEvent.click(bold, { metaKey: true })).toBe(false)
    expect(fireEvent.click(bold, { ctrlKey: true, shiftKey: true })).toBe(false)
    expect(activate.mock.calls).toEqual([
      ['https://evenfire.ai/docs'],
      ['https://evenfire.ai/docs'],
      ['https://evenfire.ai/docs'],
    ])
  })

  it('does not activate on a click outside any anchor', () => {
    const { activate } = renderThread([
      { role: 'assistant', content: `Plain text and [a link](${REPORTED_GFS_HREF}).` },
    ])
    expect(fireEvent.click(screen.getByText(/Plain text/))).toBe(true)
    expect(activate).not.toHaveBeenCalled()
    // Liveness witness: the handler is attached to this message.
    expect(fireEvent.click(screen.getByRole('link', { name: 'a link' }))).toBe(false)
    expect(activate.mock.calls).toEqual([[REPORTED_GFS_HREF]])
  })

  it('S-12: leaves an anchor in the artifact actions alone', () => {
    const { activate } = renderThread([
      { role: 'assistant', content: `Here: [folder](${REPORTED_GFS_HREF})` },
    ])
    const artifact = screen.getByRole('link', { name: 'artifact link' })
    expect(artifact.closest('.markdown-content')).not.toBeNull()
    expect(fireEvent.click(artifact)).toBe(true)
    expect(activate).not.toHaveBeenCalled()
    // The same message's own markdown link is still handled.
    expect(fireEvent.click(screen.getByRole('link', { name: 'folder' }))).toBe(false)
    expect(activate.mock.calls).toEqual([[REPORTED_GFS_HREF]])
  })

  it('ignores an anchor that encloses the container rather than sitting inside it', () => {
    const activate = vi.fn(async (_href: string) => {})
    messages = [
      {
        id: 'a-0',
        role: 'assistant',
        content: `Plain words and [inner](${REPORTED_GFS_HREF})`,
        timestamp: 1,
      },
    ]
    groupedMessages = [{ role: 'assistant', items: messages }]
    render(
      <ChatLinkActivationContext.Provider value={activate}>
        <a href="gfs://main/outer0">
          <ChatThread />
        </a>
      </ChatLinkActivationContext.Provider>
    )
    expect(fireEvent.click(screen.getByText(/Plain words/))).toBe(true)
    expect(activate).not.toHaveBeenCalled()
    // Liveness witness: inside the same tree the handler still routes the
    // message's own link, and with its href rather than the outer anchor's.
    expect(fireEvent.click(screen.getByRole('link', { name: 'inner' }))).toBe(false)
    expect(activate.mock.calls).toEqual([[REPORTED_GFS_HREF]])
  })

  it('gives the user message no link container', () => {
    const { activate, view } = renderThread([
      { role: 'user', content: `Open [mine](${REPORTED_GFS_HREF})` },
      { role: 'assistant', content: `Opening [yours](${REPORTED_GFS_HREF})` },
    ])
    const userBubble = screen.getByTestId('user-message')
    expect(userBubble.querySelector('.chat-md-root')).toBeNull()
    expect(view.container.querySelectorAll('.chat-md-root')).toHaveLength(1)
    // User text is rendered verbatim: no anchor exists to activate.
    expect(userBubble.querySelector('a')).toBeNull()
    fireEvent.click(screen.getByText(/Open \[mine\]/))
    expect(activate).not.toHaveBeenCalled()
    expect(fireEvent.click(screen.getByRole('link', { name: 'yours' }))).toBe(false)
    expect(activate.mock.calls).toEqual([[REPORTED_GFS_HREF]])
  })

  it('resolves the anchor when the native click targets the link text node itself', () => {
    const { activate } = renderThread([
      { role: 'assistant', content: `Open [folder](${REPORTED_GFS_HREF}).` },
    ])
    const textNode = screen.getByRole('link', { name: 'folder' }).firstChild!
    expect(textNode.nodeType).toBe(Node.TEXT_NODE)
    expect(fireEvent.click(textNode)).toBe(false)
    expect(activate.mock.calls).toEqual([[REPORTED_GFS_HREF]])
  })

  it('prevents the second click of a double click without activating again; keyboard Enter (detail 0) activates', () => {
    const { activate } = renderThread([
      { role: 'assistant', content: 'See [docs](https://evenfire.ai/docs).' },
    ])
    const link = screen.getByRole('link', { name: 'docs' })
    expect(fireEvent.click(link, { detail: 1 })).toBe(false)
    expect(fireEvent.click(link, { detail: 2 })).toBe(false)
    expect(activate.mock.calls).toEqual([['https://evenfire.ai/docs']])
    expect(fireEvent.click(link, { detail: 0 })).toBe(false)
    expect(activate.mock.calls).toEqual([
      ['https://evenfire.ai/docs'],
      ['https://evenfire.ai/docs'],
    ])
  })

  it('keeps markdown links non-navigating with no provider mounted', () => {
    messages = [
      { id: 'a-0', role: 'assistant', content: `[go](${REPORTED_GFS_HREF})`, timestamp: 1 },
    ]
    groupedMessages = [{ role: 'assistant', items: messages }]
    render(<ChatThread />)
    expect(fireEvent.click(screen.getByRole('link', { name: 'go' }))).toBe(false)
  })
})

describe('ChatThread link activation with the real core (S-4)', () => {
  afterEach(() => {
    delete (window as { clerum?: unknown }).clerum
  })

  it('opens the resolved folder in Files even when the chat unmounts before the resolve settles', async () => {
    const resource = await resolveResource(resolvedDirectory('dir0', 'Folder 0'))
    let settleResolve!: () => void
    const resolveForNavigation = vi.fn(
      (_uri: string) =>
        new Promise(resolve => {
          settleResolve = () => resolve({ status: 'resolved', resource })
        })
    )
    let userNavigationGeneration = 0
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          advanceUserNavigationGeneration: () => ++userNavigationGeneration,
          getUserNavigationGeneration: () => userNavigationGeneration,
          resolveForNavigation,
        },
        app: { openUrl: vi.fn(async () => {}) },
        sandboxUi: { setVisible: vi.fn() },
      } as unknown as Window['clerum'],
    })
    const nav = renderHook(() => useNavigationController())
    const pushToast = vi.fn()
    const activate = createChatLinkActivation({
      beginUserNavigationIntent: nav.result.current.beginUserNavigationIntent,
      isNavigationIntentCurrent: nav.result.current.isNavigationIntentCurrent,
      openPreviewSection: nav.result.current.openPreviewSection,
      openFilesSection: nav.result.current.openFilesSection,
      pushToast,
      resolveForNavigation: uri => window.clerum.gfs.resolveForNavigation(uri),
      openUrl: url => window.clerum.app.openUrl(url),
    })
    messages = [
      { id: 'a-0', role: 'assistant', content: `[folder](${REPORTED_GFS_HREF})`, timestamp: 1 },
    ]
    groupedMessages = [{ role: 'assistant', items: messages }]
    const thread = render(
      <ChatLinkActivationContext.Provider value={activate}>
        <ChatThread />
      </ChatLinkActivationContext.Provider>
    )

    expect(fireEvent.click(screen.getByRole('link', { name: 'folder' }))).toBe(false)
    expect(resolveForNavigation.mock.calls).toEqual([[REPORTED_GFS_HREF]])
    thread.unmount()
    expect(screen.queryByRole('link', { name: 'folder' })).toBeNull()

    await act(async () => settleResolve())

    const active = activeWorkspaceTab(nav.result.current.workspaceTabs)
    expect(active?.kind).toBe('files')
    expect(active?.files?.path).toBe(resource.gfsUri)
    expect(pushToast).not.toHaveBeenCalled()
  })
})
