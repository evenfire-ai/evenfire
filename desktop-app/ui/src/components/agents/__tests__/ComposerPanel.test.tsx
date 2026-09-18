// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatComposerStateContextValue } from '@contexts/ChatComposerStateContext'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  COMPOSER_MAX_IMAGE_ATTACHMENTS,
  COMPOSER_MAX_IMAGE_BYTES,
  COMPOSER_MAX_IMAGE_DIMENSION,
} from '@constants/attachments'
import type { HostModelsResult } from '@hooks/useChatStore'
import {
  type ImageInputDecision,
  imageInputBlockMessage,
} from '../../../../../src/imageInputDecision'
import type { ComposerImageAttachment, FailedAgentSend } from '../../../uiTypes'
import { ComposerPanel } from '../ComposerPanel'

// Resolve the stylesheet relative to THIS test file (not process.cwd()) so the
// test passes regardless of the directory vitest is launched from. CI runs it
// from desktop-app/ui, where the old cwd-relative 'ui/src/styles.css' resolved
// to desktop-app/ui/ui/src/styles.css and failed with ENOENT.
const composerStyles = readFileSync(resolve(__dirname, '../../../styles.css'), 'utf8')

const composerState: ChatComposerStateContextValue = {
  composerImageAttachments: [],
  composerReferenceAttachments: [],
  agentSending: false,
  agentError: null,
  failedAgentSend: null,
  activeChatId: null,
  activeMessageCount: 0,
  composerFocusRequestId: 0,
}

const draftState = { value: '', set: vi.fn() }

/** Stable action spies so guard tests can assert what did (not) reach the controller. */
const actionsMock = {
  clearComposerSendError: vi.fn(),
  handleAddComposerImageAttachments: vi.fn(),
  handleUpdateComposerImageAttachment: vi.fn(),
  handleRemoveComposerImageAttachment: vi.fn(),
  handleAddComposerReferenceAttachments: vi.fn(),
  handleRemoveComposerReferenceAttachment: vi.fn(),
  handleSendAgentMessage: vi.fn(),
  handleRetryFailedAgentSend: vi.fn(),
  handleRecoverFailedAgentSend: vi.fn(),
  handleDiscardFailedAgentSend: vi.fn(),
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

vi.mock('@hooks/useComposerDraft', () => ({
  useComposerDraft: () => [draftState.value, draftState.set],
}))

/**
 * Shared model-selection view (issue #654). Mutable so a test can swap the
 * capability/state per case; every field of the hook's real return shape must be
 * present because ModelSelector reads them directly.
 */
const composerModelState = {
  data: {
    provider: 'claude',
    hostDefault: 'claude-haiku-4-5',
    sessionModel: null,
    degraded: false,
    models: [{ name: 'claude-haiku-4-5', displayName: 'Haiku 4.5' }],
  } as HostModelsResult | null | undefined,
  loading: false,
  saving: false,
  error: null as string | null,
  state: 'ready' as 'unloaded' | 'loading' | 'ready' | 'unavailable',
  effectiveModel: 'claude-haiku-4-5',
  intentModel: null as string | null,
  pending: false,
  selectionUnsettled: false,
  conflicted: false,
  confirmedRevision: null as number | null,
  imageInput: { state: 'unknown' as const, reason: 'model_unknown' },
  canAttachImages: false,
  imageBlockMessage: null as string | null,
  visualSendBlocked: false,
  selectModel: vi.fn(async () => true),
  clearError: vi.fn(),
  refresh: vi.fn(async () => undefined),
}

vi.mock('@hooks/useHostModels', () => ({
  useHostModels: () => composerModelState,
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
  Object.assign(composerState, {
    composerImageAttachments: [],
    composerReferenceAttachments: [],
    agentSending: false,
    agentError: null,
    failedAgentSend: null,
    activeChatId: null,
    activeMessageCount: 0,
    composerFocusRequestId: 0,
  })
  Object.assign(composerModelState, {
    visualSendBlocked: false,
    canAttachImages: false,
    imageBlockMessage: null,
    imageInput: { state: 'unknown', reason: 'model_unknown' },
  })
  for (const spy of Object.values(actionsMock)) spy.mockReset()
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

// ---------------------------------------------------------------------------
// Issue #654: composer image attachments through real DOM events.
//
// These drive the real component. jsdom has no file dialog and no DataTransfer,
// so the helpers below stand in for exactly those unavailable browser
// primitives; the accept filter, the FileReader byte preparation and every guard
// stay real. The jsdom environment does provide URL.createObjectURL, so chip
// previews are real `blob:` object URLs.
// ---------------------------------------------------------------------------

/** PNG signature bytes, so "the file's bytes reached the controller" is literal. */
const PNG_BYTES = [137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]
/** JPEG SOI/APP0 bytes for the cases that carry a .jpg file. */
const JPEG_BYTES = [255, 216, 255, 224, 0, 16, 74, 70, 73, 70]

function imageFile(name: string, type: string, bytes: Uint8Array | number[] = PNG_BYTES): File {
  return new File([new Uint8Array(bytes)], name, { type })
}

/** Reported `File.size` without allocating the payload (the picker guards on size). */
function imageFileWithReportedSize(name: string, type: string, sizeBytes: number): File {
  const file = imageFile(name, type)
  Object.defineProperty(file, 'size', { configurable: true, value: sizeBytes })
  return file
}

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

function decodedBytes(base64: string): number[] {
  return Array.from(atob(base64), char => char.charCodeAt(0))
}

function addedBatches(): ComposerImageAttachment[][] {
  return actionsMock.handleAddComposerImageAttachments.mock.calls.map(([batch]) => batch)
}

/** Asserts that the controller received exactly one batch with one prepared image. */
function expectSinglePreparedImage(): ComposerImageAttachment {
  const batches = addedBatches()
  expect(batches).toHaveLength(1)
  expect(batches[0]).toHaveLength(1)
  const attachment = batches[0]?.[0]
  if (!attachment) throw new Error('expected one prepared image attachment')
  return attachment
}

function pickerInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('.composer-file-input')
  if (!(input instanceof HTMLInputElement)) throw new Error('expected the composer file picker')
  return input
}

function capabilityMessage(decision: ImageInputDecision): string {
  const message = imageInputBlockMessage(composerModelState.effectiveModel, decision)
  if (!message) throw new Error('expected a blocking image-capability message')
  return message
}

/**
 * jsdom cannot open a native file dialog, so the picker click is the boundary
 * that stays observable: intercept it, and let the test fire the `change` event
 * that a real dialog would produce.
 */
async function withPickerClick<T>(run: (timesClicked: () => number) => Promise<T>): Promise<T> {
  const clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
  try {
    return await run(() => clickSpy.mock.calls.length)
  } finally {
    clickSpy.mockRestore()
  }
}

const SUPPORTED_CAPABILITY = {
  imageInput: { state: 'supported', reason: 'supported' } as ImageInputDecision,
  canAttachImages: true,
  imageBlockMessage: null,
  visualSendBlocked: false,
}

const BLOCKED_CAPABILITIES: Array<[string, ImageInputDecision]> = [
  ['unsupported', { state: 'unsupported', reason: 'model_unsupported' }],
  ['unverified', { state: 'unknown', reason: 'model_unknown' }],
]

describe.each(BLOCKED_CAPABILITIES)(
  'ComposerPanel with %s image capability',
  (_label, decision) => {
    const blockMessage = capabilityMessage(decision)

    beforeEach(() => {
      Object.assign(composerModelState, {
        imageInput: decision,
        canAttachImages: false,
        imageBlockMessage: blockMessage,
        visualSendBlocked: true,
      })
    })

    // #678: capability gates sending images, never selecting them. The picked
    // image is kept so the user can switch to a capable model; the send-time
    // notice (covered below) explains the block once the chip is pending.
    it('opens the Upload Files picker and attaches the picked image', async () => {
      await withPickerClick(async timesClicked => {
        const { container } = render(<ComposerPanel inline />)

        fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
        fireEvent.click(screen.getByRole('menuitem', { name: 'Upload Files' }))
        expect(timesClicked()).toBe(1)

        fireEvent.change(pickerInput(container), {
          target: { files: [imageFile('photo.png', 'image/png')] },
        })

        await waitFor(() =>
          expect(actionsMock.handleAddComposerImageAttachments).toHaveBeenCalledTimes(1)
        )
        expect(expectSinglePreparedImage()).toMatchObject({ name: 'photo.png' })
        expect(screen.queryByText(blockMessage)).toBeNull()
      })
    })

    it('attaches a pasted image', async () => {
      render(<ComposerPanel inline />)
      const textarea = screen.getByTestId('chat-input')

      const notPrevented = fireEvent.paste(textarea, {
        clipboardData: { files: [imageFile('clipboard.png', 'image/png')], items: [] },
      })

      // Consumed like a real paste so the image never lands as text either.
      expect(notPrevented).toBe(false)
      await waitFor(() =>
        expect(actionsMock.handleAddComposerImageAttachments).toHaveBeenCalledTimes(1)
      )
      expect(expectSinglePreparedImage().mimeType).toBe('image/png')
      expect(screen.queryByText(blockMessage)).toBeNull()
    })

    it('attaches a dropped image and clears the drop overlay', async () => {
      const { container } = render(<ComposerPanel inline />)
      const shell = container.querySelector('.composer-input-shell') as HTMLElement

      fireEvent.dragEnter(shell, { dataTransfer: { types: ['Files'] } })
      expect(screen.getByText('Drop files here')).toBeTruthy()

      const notPrevented = fireEvent.drop(shell, {
        dataTransfer: { files: [imageFile('dropped.png', 'image/png')], types: ['Files'] },
      })

      expect(notPrevented).toBe(false)
      await waitFor(() =>
        expect(actionsMock.handleAddComposerImageAttachments).toHaveBeenCalledTimes(1)
      )
      expect(expectSinglePreparedImage()).toMatchObject({ name: 'dropped.png' })
      expect(screen.queryByText('Drop files here')).toBeNull()
      expect(screen.queryByText(blockMessage)).toBeNull()
    })
  }
)

describe('ComposerPanel with an image-capable model', () => {
  beforeEach(() => {
    Object.assign(composerModelState, SUPPORTED_CAPABILITY)
  })

  it('opens the picker and hands the picked PNG bytes to the controller', async () => {
    await withPickerClick(async timesClicked => {
      const { container } = render(<ComposerPanel inline />)

      fireEvent.click(screen.getByRole('button', { name: 'Add context' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Upload Files' }))
      expect(timesClicked()).toBe(1)

      const fileInput = pickerInput(container)
      expect(fileInput.accept).toBe('image/jpeg,image/png')
      expect(fileInput.multiple).toBe(true)
      fireEvent.change(fileInput, { target: { files: [imageFile('photo.png', 'image/png')] } })

      await waitFor(() => expect(actionsMock.handleAddComposerImageAttachments).toHaveBeenCalled())
      const attachment = expectSinglePreparedImage()
      expect(attachment).toMatchObject({
        name: 'photo.png',
        mimeType: 'image/png',
        sizeBytes: PNG_BYTES.length,
      })
      expect(decodedBytes(attachment.dataBase64)).toEqual(PNG_BYTES)
      // createObjectURL is available here, so the chip preview is an object URL
      // for the picked file rather than the FileReader fallback.
      expect(attachment.previewDataUrl).toMatch(/^blob:/)
      expect(screen.queryByRole('alert')).toBeNull()
    })
  })

  it('prepares a pasted PNG once when the clipboard reports it as both file and item', async () => {
    render(<ComposerPanel inline />)
    const textarea = screen.getByTestId('chat-input')
    const pasted = imageFile('image.png', 'image/png')

    fireEvent.paste(textarea, {
      clipboardData: {
        files: [pasted],
        items: [{ kind: 'file', getAsFile: () => pasted }],
      },
    })

    await waitFor(() => expect(actionsMock.handleAddComposerImageAttachments).toHaveBeenCalled())
    const attachment = expectSinglePreparedImage()
    // A generic clipboard name is replaced with a distinguishable pasted-image name.
    expect(attachment.name).toMatch(/^pasted-image-\d+-1\.png$/)
    expect(attachment.mimeType).toBe('image/png')
    expect(decodedBytes(attachment.dataBase64)).toEqual(PNG_BYTES)
  })

  it('prepares a dropped JPEG and clears the drop overlay after the drop', async () => {
    const { container } = render(<ComposerPanel inline />)
    const shell = container.querySelector('.composer-input-shell') as HTMLElement

    fireEvent.dragEnter(shell, { dataTransfer: { types: ['Files'] } })
    expect(screen.getByText('Drop files here')).toBeTruthy()

    fireEvent.drop(shell, {
      dataTransfer: {
        files: [imageFile('dropped.jpg', 'image/jpeg', JPEG_BYTES)],
        types: ['Files'],
      },
    })

    await waitFor(() => expect(actionsMock.handleAddComposerImageAttachments).toHaveBeenCalled())
    const attachment = expectSinglePreparedImage()
    expect(attachment).toMatchObject({
      name: 'dropped.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: JPEG_BYTES.length,
    })
    expect(decodedBytes(attachment.dataBase64)).toEqual(JPEG_BYTES)
    expect(screen.queryByText('Drop files here')).toBeNull()
  })

  it('infers the mime type from the file name when the OS reports none', async () => {
    const { container } = render(<ComposerPanel inline />)

    fireEvent.change(pickerInput(container), {
      target: { files: [imageFile('screenshot.png', '')] },
    })

    await waitFor(() => expect(actionsMock.handleAddComposerImageAttachments).toHaveBeenCalled())
    expect(expectSinglePreparedImage().mimeType).toBe('image/png')
  })

  it('explains a rejected file type and still attaches the valid image in the same batch', async () => {
    const { container } = render(<ComposerPanel inline />)

    fireEvent.change(pickerInput(container), {
      target: {
        files: [imageFile('animation.gif', 'image/gif'), imageFile('good.png', 'image/png')],
      },
    })

    await waitFor(() => expect(actionsMock.handleAddComposerImageAttachments).toHaveBeenCalled())
    expect(screen.getByRole('alert').textContent).toBe(
      'animation.gif is not supported. Use PNG or JPEG.'
    )
    expect(expectSinglePreparedImage().name).toBe('good.png')
  })

  it('explains an oversize image and attaches nothing', async () => {
    const { container } = render(<ComposerPanel inline />)

    fireEvent.change(pickerInput(container), {
      target: {
        files: [imageFileWithReportedSize('huge.png', 'image/png', COMPOSER_MAX_IMAGE_BYTES + 1)],
      },
    })

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.getByRole('alert').textContent).toBe('huge.png is too large. Max size is 16 MiB.')
    expect(actionsMock.handleAddComposerImageAttachments).not.toHaveBeenCalled()
  })

  it('accepts a 12MiB image above the usual 10MiB target', async () => {
    const { container } = render(<ComposerPanel inline />)
    fireEvent.change(pickerInput(container), {
      target: { files: [imageFileWithReportedSize('large.png', 'image/png', 12 * 1024 * 1024)] },
    })
    await waitFor(() => expect(actionsMock.handleAddComposerImageAttachments).toHaveBeenCalled())
    expect(expectSinglePreparedImage().sizeBytes).toBe(12 * 1024 * 1024)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('refuses a 2049 px image before send and names the pixel bound', async () => {
    const { container } = render(<ComposerPanel inline />)
    fireEvent.change(pickerInput(container), {
      target: { files: [pngIhdrFile('over-res.png', COMPOSER_MAX_IMAGE_DIMENSION + 1, 128)] },
    })
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        `over-res.png is too large. Max resolution is ${COMPOSER_MAX_IMAGE_DIMENSION} px.`
      )
    )
    expect(actionsMock.handleAddComposerImageAttachments).not.toHaveBeenCalled()
  })

  it('attaches 20 images from one pick and says how many did not fit', async () => {
    expect(COMPOSER_MAX_IMAGE_ATTACHMENTS).toBe(20)
    const { container } = render(<ComposerPanel inline />)
    const files = Array.from({ length: 22 }, (_, index) =>
      imageFile(`photo-${index + 1}.png`, 'image/png', [...PNG_BYTES, index])
    )

    fireEvent.change(pickerInput(container), { target: { files } })

    await waitFor(() =>
      expect(actionsMock.handleAddComposerImageAttachments).toHaveBeenCalledTimes(1)
    )
    const [batch] = addedBatches()
    expect(batch?.map(attachment => attachment.name)).toEqual(
      files.slice(0, 20).map(file => file.name)
    )
    expect(screen.getByRole('alert').textContent).toBe(
      'You can attach up to 20 images per message; 2 images were not added.'
    )
  })

  it('attaches 10MiB + 7MiB in the composer; the hop owns the aggregate', async () => {
    const { container } = render(<ComposerPanel inline />)
    fireEvent.change(pickerInput(container), {
      target: {
        files: [
          imageFileWithReportedSize('fits.png', 'image/png', 10 * 1024 * 1024),
          imageFileWithReportedSize('over-total.png', 'image/png', 7 * 1024 * 1024),
        ],
      },
    })
    await waitFor(() =>
      expect(actionsMock.handleAddComposerImageAttachments).toHaveBeenCalledTimes(1)
    )
    expect(addedBatches()[0]?.map(attachment => attachment.name)).toEqual([
      'fits.png',
      'over-total.png',
    ])
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not let a dropped non-image take one of the free image slots', async () => {
    // 18 of the 20 slots are taken; the drop carries a PDF ahead of two PNGs.
    composerState.composerImageAttachments = Array.from({ length: 18 }, (_, index) => ({
      id: `attached-${index + 1}`,
      name: `attached-${index + 1}.png`,
      mimeType: 'image/png' as const,
      dataBase64: 'iVBORw0KGgo=',
      sizeBytes: 8,
      previewDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    }))
    const { container } = render(<ComposerPanel inline />)
    const shell = container.querySelector('.composer-input-shell') as HTMLElement

    fireEvent.drop(shell, {
      dataTransfer: {
        files: [
          imageFile('doc.pdf', 'application/pdf'),
          imageFile('a.png', 'image/png', [...PNG_BYTES, 1]),
          imageFile('b.png', 'image/png', [...PNG_BYTES, 2]),
        ],
        types: ['Files'],
      },
    })

    await waitFor(() =>
      expect(actionsMock.handleAddComposerImageAttachments).toHaveBeenCalledTimes(1)
    )
    const [batch] = addedBatches()
    expect(batch?.map(attachment => attachment.name)).toEqual(['a.png', 'b.png'])
    // The only message is the PDF refusal: no image was counted as skipped.
    expect(screen.getByRole('alert').textContent).toBe('doc.pdf is not supported. Use PNG or JPEG.')
  })
})

describe('ComposerPanel with a pending image after a model switch', () => {
  const pendingImage: ComposerImageAttachment = {
    id: 'pending-image-1',
    name: 'pending.png',
    mimeType: 'image/png',
    dataBase64: 'iVBORw0KGgo=',
    sizeBytes: 8,
    previewDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
  }
  const switchedAway: ImageInputDecision = { state: 'unknown', reason: 'model_unknown' }

  beforeEach(() => {
    composerState.composerImageAttachments = [pendingImage]
    draftState.value = 'inspect this image'
    Object.assign(composerModelState, SUPPORTED_CAPABILITY)
  })

  it('keeps the pending chip, shows the block notice, and refuses Enter and the send button', () => {
    const { rerender } = render(<ComposerPanel inline />)
    expect(screen.queryByTestId('composer-image-capability-notice')).toBeNull()

    // The host now reports the effective model as unable to receive images.
    Object.assign(composerModelState, {
      imageInput: switchedAway,
      canAttachImages: false,
      imageBlockMessage: capabilityMessage(switchedAway),
      visualSendBlocked: true,
    })
    rerender(<ComposerPanel inline />)

    // The pending attachment is still there, with the reason it cannot be sent.
    expect(screen.getByRole('button', { name: 'Remove pending.png' })).toBeTruthy()
    const notice = screen.getByTestId('composer-image-capability-notice')
    expect(notice.getAttribute('role')).toBe('alert')
    expect(notice.textContent).toBe(capabilityMessage(switchedAway))
    // The disabled send button points assistive technology at the reason.
    const describedBy = screen.getByTestId('send-button').getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy as string)).toBe(notice)

    const textarea = screen.getByTestId('chat-input') as HTMLTextAreaElement
    expect((screen.getByTestId('send-button') as HTMLButtonElement).disabled).toBe(true)
    expect(fireEvent.keyDown(textarea, { key: 'Enter' })).toBe(false)
    expect(actionsMock.handleSendAgentMessage).not.toHaveBeenCalled()
    // Shift+Enter is still a newline, and still not a send.
    expect(fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })).toBe(true)
    expect(actionsMock.handleSendAgentMessage).not.toHaveBeenCalled()
  })

  it('sends the pending image with Enter while the model can receive images', () => {
    render(<ComposerPanel inline />)
    expect(screen.queryByTestId('composer-image-capability-notice')).toBeNull()
    expect(screen.getByTestId('send-button').hasAttribute('aria-describedby')).toBe(false)
    const textarea = screen.getByTestId('chat-input') as HTMLTextAreaElement

    expect((screen.getByTestId('send-button') as HTMLButtonElement).disabled).toBe(false)
    expect(fireEvent.keyDown(textarea, { key: 'Enter' })).toBe(false)
    expect(actionsMock.handleSendAgentMessage).toHaveBeenCalledWith('inspect this image')

    fireEvent.click(screen.getByTestId('send-button'))
    expect(actionsMock.handleSendAgentMessage).toHaveBeenCalledTimes(2)
  })

  it('renders the pending image chip and dispatches removal with its id', () => {
    render(<ComposerPanel inline />)

    expect(screen.getByText('pending.png')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove pending.png' }))
    expect(actionsMock.handleRemoveComposerImageAttachment).toHaveBeenCalledWith('pending-image-1')
  })
})

describe('ComposerPanel failed-send recovery actions', () => {
  const failedSend: FailedAgentSend = {
    content: 'inspect this image',
    attachments: [],
    references: [],
    message: 'Image input evidence changed',
    kind: 'upstream',
    timestamp: 1,
    agentRef: 'agent-1',
    chatId: 'chat-1',
  }

  it('offers explicit recovery and dispatch and routes each action to the controller', () => {
    composerState.failedAgentSend = failedSend
    composerState.agentError = 'Sending failed'
    render(<ComposerPanel inline />)

    expect(screen.getByText('Sending failed')).toBeTruthy()
    expect(screen.getByText('Image input evidence changed')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Recover input' }))
    expect(actionsMock.handleRecoverFailedAgentSend).toHaveBeenCalledTimes(1)
    expect(actionsMock.handleDiscardFailedAgentSend).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Discard failed input' }))
    expect(actionsMock.handleDiscardFailedAgentSend).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Retry last send' }))
    expect(actionsMock.handleRetryFailedAgentSend).toHaveBeenCalledTimes(1)
  })

  it('disables recovery while a send is in flight', () => {
    composerState.failedAgentSend = failedSend
    composerState.agentError = 'Sending failed'
    composerState.agentSending = true
    render(<ComposerPanel inline />)

    for (const name of ['Recover input', 'Discard failed input', 'Retry last send']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true)
    }
  })

  it('explains the waking state and routes its retry to the controller', () => {
    composerState.failedAgentSend = { ...failedSend, kind: 'waking' }
    composerState.agentError = 'Sending failed'
    render(<ComposerPanel inline />)

    const waking = screen.getByTestId('waking-state')
    expect(waking.getAttribute('role')).toBe('status')
    expect(waking.textContent).toContain('Agent is waking up')

    fireEvent.click(screen.getByRole('button', { name: 'Retry last send' }))
    expect(actionsMock.handleRetryFailedAgentSend).toHaveBeenCalledTimes(1)
  })
})
