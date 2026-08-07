// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ComposerPanel } from '../ComposerPanel'

// Resolve the stylesheet relative to THIS test file (not process.cwd()) so the
// test passes regardless of the directory vitest is launched from. CI runs it
// from desktop-app/ui, where the old cwd-relative 'ui/src/styles.css' resolved
// to desktop-app/ui/ui/src/styles.css and failed with ENOENT.
const composerStyles = readFileSync(resolve(__dirname, '../../../styles.css'), 'utf8')

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

vi.mock('@hooks/useComposerDraft', () => ({
  useComposerDraft: () => [draftState.value, draftState.set],
}))

vi.mock('@hooks/useHostModels', () => ({
  useHostModels: () => ({
    data: {
      provider: 'claude',
      hostDefault: 'claude-haiku-4-5',
      sessionModel: null,
      degraded: false,
      models: [{ name: 'claude-haiku-4-5', displayName: 'Haiku 4.5' }],
    },
    loading: false,
    saving: false,
    error: null,
    selectModel: vi.fn(async () => true),
    clearError: vi.fn(),
  }),
}))
vi.mock('../ComposerAgentFilesModal', () => ({ ComposerAgentFilesModal: () => null }))
vi.mock('../ComposerGlobalFilesModal', () => ({ ComposerGlobalFilesModal: () => null }))
vi.mock('../AnnotationCanvas', () => ({ AnnotationCanvas: () => null }))

function setScrollHeight(textarea: HTMLTextAreaElement, value: number) {
  Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value })
}

beforeEach(() => {
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: { workflows: { list: vi.fn(async () => ({ items: [] })) } },
  })
})

afterEach(() => {
  cleanup()
  draftState.value = ''
  draftState.set.mockReset()
  delete (window as Partial<typeof window>).clerum
})

function cssRule(selector: string) {
  const match = composerStyles.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`))
  return match?.[1] ?? ''
}

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

  it('keeps context and model popovers outside the clipped text viewport', () => {
    const { container } = render(<ComposerPanel inline={inline} />)
    const shell = container.querySelector('.composer-input-shell')
    const viewport = container.querySelector('.composer-textarea-viewport')

    fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: /Plugins/ }))
    fireEvent.click(screen.getByRole('button', { name: /Model — Haiku 4.5/ }))

    const contextMenu = container.querySelector('.composer-reference-menu-panel')
    const submenu = container.querySelector('.composer-reference-submenu')
    const modelMenu = container.querySelector('.model-selector-popover')

    expect(contextMenu).toBeTruthy()
    expect(submenu).toBeTruthy()
    expect(modelMenu).toBeTruthy()
    expect(viewport?.contains(contextMenu)).toBe(false)
    expect(viewport?.contains(submenu)).toBe(false)
    expect(viewport?.contains(modelMenu)).toBe(false)
    expect(shell?.contains(contextMenu)).toBe(true)
    expect(shell?.contains(submenu)).toBe(true)
    expect(shell?.contains(modelMenu)).toBe(true)
    expect(cssRule('\\.composer-input-shell')).not.toMatch(/overflow\s*:/)
    expect(cssRule('\\.composer-textarea-viewport')).toMatch(/overflow\s*:\s*hidden/)
  })
})
