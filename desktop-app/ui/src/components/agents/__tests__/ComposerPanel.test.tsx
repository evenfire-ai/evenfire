// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ComposerPanel } from '../ComposerPanel'

const composerState = {
  composerImageAttachments: [],
  composerReferenceAttachments: [],
  agentSending: false,
  agentError: null,
  failedAgentSend: null,
  activeChatId: null,
  activeMessageCount: 0,
}

const draftState = { value: '', set: vi.fn() }

vi.mock('@contexts/AgentChatActionsContext', () => ({
  useAgentChatActionsContext: () => ({
    clearComposerSendError: vi.fn(),
    handleAddComposerImageAttachments: vi.fn(),
    handleUpdateComposerImageAttachment: vi.fn(),
    handleRemoveComposerImageAttachment: vi.fn(),
    handleAddComposerReferenceAttachments: vi.fn(),
    handleRemoveComposerReferenceAttachment: vi.fn(),
    handleSendAgentMessage: vi.fn(),
    handleRetryFailedAgentSend: vi.fn(),
  }),
}))

vi.mock('@contexts/ChatComposerStateContext', () => ({
  useChatComposerStateContext: () => composerState,
}))

vi.mock('@contexts/McpRuntimeContext', () => ({
  useMcpRuntimeContext: () => ({ hostRuntimeStatus: null, activeLlmProvider: null }),
}))

vi.mock('@contexts/NavigationContext', () => ({
  useNavigationContext: () => ({ selectedAgent: null }),
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
  useComposerDraft: () => [draftState.value, draftState.set],
}))

vi.mock('../ModelSelector', () => ({ ModelSelector: () => null }))
vi.mock('../ComposerAgentFilesModal', () => ({ ComposerAgentFilesModal: () => null }))
vi.mock('../ComposerGlobalFilesModal', () => ({ ComposerGlobalFilesModal: () => null }))
vi.mock('../AnnotationCanvas', () => ({ AnnotationCanvas: () => null }))

function setScrollHeight(textarea: HTMLTextAreaElement, value: number) {
  Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value })
}

afterEach(() => {
  cleanup()
  draftState.value = ''
  draftState.set.mockReset()
})

describe.each([
  ['inline new-chat', true],
  ['docked conversation', false],
])('ComposerPanel %s', (_name, inline) => {
  it('grows, caps scrolling, and shrinks its text viewport without covering it with actions', () => {
    const { container, rerender } = render(<ComposerPanel inline={inline} />)
    const textarea = screen.getByTestId('chat-input') as HTMLTextAreaElement
    const shell = container.querySelector('.composer-input-shell')
    const viewport = container.querySelector('.composer-textarea-viewport')
    const toolbar = container.querySelector('.composer-input-actions')

    expect(shell).toBeTruthy()
    expect(viewport).toBeTruthy()
    expect(toolbar).toBeTruthy()
    expect(shell?.contains(viewport)).toBe(true)
    expect(shell?.contains(toolbar)).toBe(true)
    expect(viewport?.contains(toolbar)).toBe(false)

    setScrollHeight(textarea, 96)
    fireEvent.change(textarea, { target: { value: 'first\nsecond\nthird' } })
    expect(textarea.style.height).toBe('96px')
    expect(textarea.style.overflowY).toBe('hidden')

    setScrollHeight(textarea, 1000)
    fireEvent.change(textarea, { target: { value: 'a very long draft' } })
    expect(textarea.style.height).toBe('240px')
    expect(textarea.style.overflowY).toBe('auto')

    draftState.value = 'a very long draft'
    rerender(<ComposerPanel inline={inline} />)
    draftState.value = ''
    setScrollHeight(textarea, inline ? 48 : 56)
    rerender(<ComposerPanel inline={inline} />)
    expect(textarea.style.height).toBe(inline ? '48px' : '56px')
    expect(textarea.style.overflowY).toBe('hidden')
  })
})
