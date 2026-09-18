// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ComposerImageAttachment } from '../../../uiTypes'
import { ComposerPanel } from '../ComposerPanel'

// Resolve the stylesheet relative to THIS test file (not process.cwd()) so the
// test passes regardless of the directory vitest is launched from. CI runs it
// from desktop-app/ui, where the old cwd-relative 'ui/src/styles.css' resolved
// to desktop-app/ui/ui/src/styles.css and failed with ENOENT.
const composerStyles = readFileSync(resolve(__dirname, '../../../styles.css'), 'utf8')

const composerState = {
  composerImageAttachments: [] as ComposerImageAttachment[],
  composerReferenceAttachments: [],
  agentSending: false,
  agentError: null,
  failedAgentSend: null,
  activeChatId: null,
  activeMessageCount: 0,
  composerFocusRequestId: 0,
}

const draftState = { value: '', set: vi.fn() }

// Stable spies so the image-budget cases can assert exactly what the panel hands
// to the composer-actions layer.
const composerActions = {
  handleAddComposerImageAttachments: vi.fn(),
  handleUpdateComposerImageAttachment: vi.fn(),
  handleRemoveComposerImageAttachment: vi.fn(),
  handleAddComposerReferenceAttachments: vi.fn(),
  handleRemoveComposerReferenceAttachment: vi.fn(),
  handleSendAgentMessage: vi.fn(),
  handleRetryFailedAgentSend: vi.fn(),
}

vi.mock('@contexts/AgentChatActionsContext', () => ({
  useAgentChatActionsContext: () => ({
    clearComposerSendError: vi.fn(),
    ...composerActions,
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
// The annotation-budget cases drive the panel's own save handler. The canvas is
// a heavyweight sibling that needs a real 2D context, so it stays a test double
// (as it always was here) that simply exposes the `onSave` the panel supplies.
const annotationStub = vi.hoisted(() => ({
  next: null as null | {
    id: string
    addedOrder?: number
    name: string
    mimeType: 'image/png' | 'image/jpeg'
    dataBase64: string
    sizeBytes: number
    previewDataUrl: string
  },
  /** Message AnnotationCanvas would render from a thrown `onSave`. */
  threw: null as string | null,
}))

vi.mock('../AnnotationCanvas', () => ({
  AnnotationCanvas: ({ onSave }: { onSave: (updated: ComposerImageAttachment) => void }) => (
    <button
      type="button"
      onClick={() => {
        if (!annotationStub.next) return
        // AnnotationCanvas awaits `onSave` inside its own try/catch and renders a
        // thrown message in `.composer-image-preview-error` inside its dialog.
        annotationStub.threw = null
        try {
          onSave(annotationStub.next)
        } catch (error) {
          annotationStub.threw = error instanceof Error ? error.message : String(error)
        }
      }}
    >
      Apply annotation
    </button>
  ),
}))

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
  composerState.composerFocusRequestId = 0
  composerState.composerImageAttachments = []
  annotationStub.next = null
  annotationStub.threw = null
  for (const spy of Object.values(composerActions)) spy.mockReset()
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

  it('focuses on a trusted request and preserves selection when already focused', () => {
    const otherInput = document.createElement('input')
    document.body.append(otherInput)
    otherInput.focus()
    const { rerender } = render(<ComposerPanel inline={inline} />)
    const textarea = screen.getByTestId('chat-input') as HTMLTextAreaElement

    composerState.composerFocusRequestId = 1
    rerender(<ComposerPanel inline={inline} />)
    expect(document.activeElement).toBe(textarea)

    draftState.value = 'preserve this draft'
    rerender(<ComposerPanel inline={inline} />)
    textarea.setSelectionRange(4, 8)
    composerState.composerFocusRequestId = 2
    rerender(<ComposerPanel inline={inline} />)
    expect(textarea.selectionStart).toBe(4)
    expect(textarea.selectionEnd).toBe(8)
    otherInput.remove()
  })
})

const MIB = 1024 * 1024

/**
 * A picked image whose reported size is `sizeBytes`. The guard decides on
 * `File.size` — what the browser reports for the chosen file — so binding the
 * size drives the real code path without allocating and base64-encoding 10MiB
 * blobs per case.
 */
function pngIhdrFile(name: string, width: number, height: number): File {
  const bytes = new Uint8Array(8 + 8 + 13)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return new File([bytes], name, { type: 'image/png' })
}

function imageFile(name: string, sizeBytes: number, type = 'image/png'): File {
  const file = new File([new Uint8Array([0x41])], name, { type })
  Object.defineProperty(file, 'size', { configurable: true, value: sizeBytes })
  return file
}

function existingAttachment(name: string, sizeBytes: number): ComposerImageAttachment {
  return {
    id: `existing-${name}`,
    name,
    mimeType: 'image/png',
    dataBase64: 'QQ==',
    sizeBytes,
    previewDataUrl: '',
    addedOrder: 0,
  }
}

function pickFiles(container: HTMLElement, files: File[]) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  Object.defineProperty(input, 'files', { configurable: true, value: files })
  fireEvent.change(input)
}

/** Every image the panel handed to the composer-actions layer, in order. */
function attachedImages(): ComposerImageAttachment[] {
  return composerActions.handleAddComposerImageAttachments.mock.calls.flatMap(
    call => call[0] as ComposerImageAttachment[]
  )
}

describe('ComposerPanel image budget', () => {
  it('accepts an image at the 10MiB per-image limit', async () => {
    const { container } = render(<ComposerPanel inline={false} />)
    pickFiles(container, [imageFile('at-limit.png', 10 * MIB)])
    await waitFor(() => expect(attachedImages()).toHaveLength(1))
    expect(attachedImages()[0]?.sizeBytes).toBe(10 * MIB)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('accepts 10MiB + 5MiB, the 15MiB per-message total', async () => {
    const { container } = render(<ComposerPanel inline={false} />)
    pickFiles(container, [imageFile('ten.png', 10 * MIB), imageFile('five.png', 5 * MIB)])
    await waitFor(() => expect(attachedImages()).toHaveLength(2))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('accepts three 5MiB images', async () => {
    const { container } = render(<ComposerPanel inline={false} />)
    pickFiles(container, [
      imageFile('a.png', 5 * MIB),
      imageFile('b.png', 5 * MIB),
      imageFile('c.png', 5 * MIB),
    ])
    await waitFor(() => expect(attachedImages()).toHaveLength(3))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('accepts a 5MiB JPEG at the same budget as PNG', async () => {
    const { container } = render(<ComposerPanel inline={false} />)
    pickFiles(container, [imageFile('photo.jpg', 5 * MIB, 'image/jpeg')])
    await waitFor(() => expect(attachedImages()).toHaveLength(1))
    expect(attachedImages()[0]?.mimeType).toBe('image/jpeg')
    expect(attachedImages()[0]?.sizeBytes).toBe(5 * MIB)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('accepts a 12MiB image above the usual 10MiB target', async () => {
    const { container } = render(<ComposerPanel inline={false} />)
    pickFiles(container, [imageFile('large.png', 12 * MIB)])
    await waitFor(() => expect(attachedImages()).toHaveLength(1))
    expect(attachedImages()[0]?.sizeBytes).toBe(12 * MIB)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('refuses an image over the 16MiB limit and names the limit in MiB', async () => {
    const { container } = render(<ComposerPanel inline={false} />)
    pickFiles(container, [imageFile('over.png', 17 * MIB)])
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        'over.png is too large. Max size is 16 MiB.'
      )
    )
    expect(composerActions.handleAddComposerImageAttachments).not.toHaveBeenCalled()
  })

  it('refuses the over-total file in a selection and keeps the one that fits', async () => {
    const { container } = render(<ComposerPanel inline={false} />)
    pickFiles(container, [imageFile('fits.png', 10 * MIB), imageFile('over-total.png', 7 * MIB)])
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        'over-total.png was not added. Attachments can total at most 16 MiB per message.'
      )
    )
    expect(attachedImages().map(attachment => attachment.name)).toEqual(['fits.png'])
  })

  it('refuses an added image that would pass the total with 10MiB already attached', async () => {
    composerState.composerImageAttachments = [existingAttachment('kept.png', 10 * MIB)]
    const { container } = render(<ComposerPanel inline={false} />)
    pickFiles(container, [imageFile('over-total.png', 7 * MIB)])
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        'can total at most 16 MiB per message'
      )
    )
    expect(composerActions.handleAddComposerImageAttachments).not.toHaveBeenCalled()
  })

  it('accepts a 5MiB image when 10MiB is already attached', async () => {
    composerState.composerImageAttachments = [existingAttachment('kept.png', 10 * MIB)]
    const { container } = render(<ComposerPanel inline={false} />)
    pickFiles(container, [imageFile('five.png', 5 * MIB)])
    await waitFor(() => expect(attachedImages()).toHaveLength(1))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('refuses a 2049 px image before send and names the pixel bound', async () => {
    const { container } = render(<ComposerPanel inline={false} />)
    pickFiles(container, [pngIhdrFile('over-res.png', 2049, 128)])
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        'over-res.png is too large. Max resolution is 2048 px.'
      )
    )
    expect(composerActions.handleAddComposerImageAttachments).not.toHaveBeenCalled()
    expect(attachedImages()).toHaveLength(0)
  })

  it('explains files beyond the 3-image cap instead of dropping them silently', async () => {
    composerState.composerImageAttachments = [
      existingAttachment('a.png', MIB),
      existingAttachment('b.png', MIB),
    ]
    const { container } = render(<ComposerPanel inline={false} />)
    pickFiles(container, [imageFile('c.png', MIB), imageFile('d.png', MIB)])
    await waitFor(() => expect(attachedImages()).toHaveLength(1))
    expect(screen.getByRole('alert').textContent).toContain(
      'You can attach up to 3 images per message.'
    )
  })
})

/** Open the annotation canvas for the attached image named `name`. */
function openAnnotation(container: HTMLElement, name: string) {
  const triggers = Array.from(container.querySelectorAll('.composer-attachment-preview-trigger'))
  const trigger = triggers.find(node => node.textContent?.includes(name))
  if (!trigger) throw new Error(`annotation trigger for ${name} not found`)
  fireEvent.click(trigger)
}

function applyAnnotation() {
  fireEvent.click(screen.getByRole('button', { name: 'Apply annotation' }))
}

describe('ComposerPanel annotation budget', () => {
  it('applies an annotation that stays inside both limits', () => {
    const original = existingAttachment('photo.png', 8 * MIB)
    composerState.composerImageAttachments = [original]
    const { container } = render(<ComposerPanel inline={false} />)
    openAnnotation(container, 'photo.png')

    annotationStub.next = { ...original, sizeBytes: 9 * MIB }
    applyAnnotation()

    expect(annotationStub.threw).toBeNull()
    expect(composerActions.handleUpdateComposerImageAttachment).toHaveBeenCalledTimes(1)
    expect(composerActions.handleUpdateComposerImageAttachment.mock.calls[0]?.[0]).toMatchObject({
      id: original.id,
      sizeBytes: 9 * MIB,
    })
  })

  it('refuses an annotation over the 16MiB per-image limit and keeps the original', () => {
    const original = existingAttachment('photo.png', 4 * MIB)
    composerState.composerImageAttachments = [original]
    const { container } = render(<ComposerPanel inline={false} />)
    openAnnotation(container, 'photo.png')

    annotationStub.next = { ...original, sizeBytes: 17 * MIB }
    applyAnnotation()

    expect(composerActions.handleUpdateComposerImageAttachment).not.toHaveBeenCalled()
    // The message the annotation dialog renders above its overlay; the original
    // attachment is never replaced.
    expect(annotationStub.threw).toContain(
      'photo.png was kept unchanged. Max size is 16 MiB per image.'
    )
  })

  it('refuses an annotation that would push the message past the 16MiB total', () => {
    const original = existingAttachment('photo.png', 4 * MIB)
    composerState.composerImageAttachments = [original, existingAttachment('other.png', 10 * MIB)]
    const { container } = render(<ComposerPanel inline={false} />)
    openAnnotation(container, 'photo.png')

    // 10MiB sibling + 7MiB annotation = 17MiB. The annotated image alone is under
    // the per-image limit, so only the per-message total can refuse this.
    annotationStub.next = { ...original, sizeBytes: 7 * MIB }
    applyAnnotation()

    expect(composerActions.handleUpdateComposerImageAttachment).not.toHaveBeenCalled()
    expect(annotationStub.threw).toContain(
      'photo.png was kept unchanged. Attachments can total at most 16 MiB per message.'
    )
  })

  it('applies an annotation that exactly reaches the 16MiB total', () => {
    const original = existingAttachment('photo.png', 4 * MIB)
    composerState.composerImageAttachments = [original, existingAttachment('other.png', 10 * MIB)]
    const { container } = render(<ComposerPanel inline={false} />)
    openAnnotation(container, 'photo.png')

    annotationStub.next = { ...original, sizeBytes: 6 * MIB }
    applyAnnotation()

    expect(annotationStub.threw).toBeNull()
    expect(composerActions.handleUpdateComposerImageAttachment).toHaveBeenCalledTimes(1)
    expect(composerActions.handleUpdateComposerImageAttachment.mock.calls[0]?.[0]).toMatchObject({
      id: original.id,
      sizeBytes: 6 * MIB,
    })
  })
})
