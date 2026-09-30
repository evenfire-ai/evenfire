// @vitest-environment jsdom
/**
 * Issue #678 — a document picked in the composer travels as an inline
 * `kind:'file'` attachment. These tests drive the public controller API: add a
 * file, send, and read what reached the Host and what the user is told.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import { createHash } from 'node:crypto'
import { loadHostModels, resetHostModelSelectionStore } from '@lib/hostModelSelectionStore'
import type { HostModelsResult } from '../../../../../src/types'
import { renderController } from './__fixtures__/controllerHarness'
import { type MockClerum, installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

let clerum: MockClerum

const imageCatalog: HostModelsResult = {
  provider: 'zai',
  hostDefault: 'glm-5.3-flash',
  sessionModel: null,
  degraded: false,
  modelSelectionRevision: 0,
  models: [{ name: 'glm-5.3-flash', imageInput: { state: 'supported', reason: 'supported' } }],
}
let uuidCounter = 0

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NOTES_TEXT = 'first line\nsecond line\n'
const NOTES_BYTES = new TextEncoder().encode(NOTES_TEXT)
const NOTES_DIGEST = createHash('sha256').update(NOTES_BYTES).digest('hex')

const UNSUPPORTED =
  'The Host does not accept file attachments yet; the message was not delivered with them. Your files are kept so you can retry once the Host is updated.'

beforeEach(() => {
  uuidCounter = 0
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(
    () => `uuid-${++uuidCounter}` as `${string}-${string}-${string}-${string}-${string}`
  )
  clerum = installMockClerum()
})

afterEach(() => {
  vi.restoreAllMocks()
  resetHostModelSelectionStore()
  uninstallMockClerum()
})

async function settleMount() {
  await waitFor(() => expect(clerum.chat.getIndex).toHaveBeenCalled())
}

function notesFile(): File {
  return new File([NOTES_BYTES], 'notes.txt', { type: 'text/plain' })
}

type Rendered = ReturnType<typeof renderController>

/** Adds a file through the public action and waits until it is read and hashed. */
async function addReadyFile(rendered: Rendered, file: File = notesFile()) {
  act(() => {
    rendered.result.current.handleAddComposerFiles([file], '')
  })
  await waitFor(() =>
    expect(rendered.result.current.composerFileAttachments.map(item => item.status)).toEqual([
      'ready',
    ])
  )
  return rendered.result.current.composerFileAttachments[0]!
}

function sentAttachments(callIndex = 0): Array<Record<string, unknown>> {
  const request = clerum.rpc.invokeHostMessage.mock.calls[callIndex]?.[1] as Record<string, unknown>
  expect(request).toBeDefined()
  return (request.attachments ?? []) as Array<Record<string, unknown>>
}

describe('sendAgentMessage — document attachments (#678)', () => {
  it('sends a ready document as an inline file attachment with its sha256', async () => {
    clerum.rpc.invokeHostMessage.mockResolvedValue({ response: 'done' })
    const rendered = renderController()
    await settleMount()
    const file = await addReadyFile(rendered)

    await act(async () => {
      await rendered.result.current.handleSendAgentMessage('Summarize this')
    })

    expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1)
    expect(sentAttachments()).toEqual([
      {
        id: file.id,
        kind: 'file',
        filename: 'notes.txt',
        mimeType: 'text/plain',
        detectedMediaType: 'text/plain',
        encoding: 'base64',
        dataBase64: Buffer.from(NOTES_BYTES).toString('base64'),
        sizeBytes: NOTES_BYTES.byteLength,
        digest: { algorithm: 'sha256', hex: NOTES_DIGEST },
      },
    ])
    // The composer is cleared once the send is accepted for delivery.
    expect(rendered.result.current.composerFileAttachments).toEqual([])
  })

  it('sends a message that has only a document and no text', async () => {
    clerum.rpc.invokeHostMessage.mockResolvedValue({ response: 'done' })
    const rendered = renderController()
    await settleMount()
    await addReadyFile(rendered)

    await act(async () => {
      await rendered.result.current.handleSendAgentMessage('')
    })

    // Witness: the send reached the Host and carried the document.
    expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1)
    expect(sentAttachments()).toHaveLength(1)
  })

  it('does not send while a document is not ready', async () => {
    clerum.rpc.invokeHostMessage.mockResolvedValue({ response: 'done' })
    const rendered = renderController()
    await settleMount()
    // A file whose read never settles stays in `reading`.
    const pending = new File([NOTES_BYTES], 'slow.txt', { type: 'text/plain' })
    vi.spyOn(pending, 'arrayBuffer').mockReturnValue(new Promise(() => {}))
    act(() => {
      rendered.result.current.handleAddComposerFiles([pending], '')
    })
    // Liveness witness: the chip exists and is mid-read, so the send below is
    // refused because of it and not because the composer is empty.
    await waitFor(() =>
      expect(rendered.result.current.composerFileAttachments.map(item => item.status)).toEqual([
        'reading',
      ])
    )

    await act(async () => {
      await rendered.result.current.handleSendAgentMessage('go')
    })

    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
    expect(rendered.result.current.composerFileAttachments).toHaveLength(1)
  })

  it('lists the ids the Host admitted and shows no error when the file is among them', async () => {
    const rendered = renderController()
    await settleMount()
    const file = await addReadyFile(rendered)
    clerum.rpc.invokeHostMessage.mockResolvedValue({
      response: 'done',
      acceptedAttachmentIds: [file.id],
    })

    await act(async () => {
      await rendered.result.current.handleSendAgentMessage('Summarize this')
    })

    // Witness: the accepted branch ran (success toast) and released the snapshot.
    expect(rendered.spies.pushToast).toHaveBeenCalledWith('Message sent to agent-x.', 'success')
    expect(rendered.result.current.agentError).toBeNull()
    expect(rendered.result.current.failedAgentSend).toBeNull()
  })
})

describe('sendAgentMessage — a Host without file attachments (#678 D13)', () => {
  it('rejected with LLM_INVALID_ATTACHMENT: says so, keeps the files, and retries without rereading', async () => {
    const rendered = renderController()
    await settleMount()
    const source = notesFile()
    const arrayBuffer = vi.spyOn(source, 'arrayBuffer')
    const file = await addReadyFile(rendered, source)
    expect(arrayBuffer).toHaveBeenCalledTimes(1)

    clerum.rpc.invokeHostMessage.mockResolvedValueOnce({
      success: false,
      error: {
        code: 'LLM_INVALID_ATTACHMENT',
        message: 'Unsupported attachment kind: file',
        retryable: false,
        provider: 'unknown',
      },
    })
    await act(async () => {
      await rendered.result.current.handleSendAgentMessage('Summarize this')
    })

    expect(rendered.spies.pushToast).toHaveBeenCalledWith(
      `Message to agent-x failed: ${UNSUPPORTED}`,
      'error'
    )
    const failed = rendered.result.current.failedAgentSend
    expect(failed?.message).toBe(UNSUPPORTED)
    expect(failed?.files.map(item => item.id)).toEqual([file.id])

    // The Host was updated in the meantime: it now lists the file it admitted.
    clerum.rpc.invokeHostMessage.mockResolvedValueOnce({
      response: 'done',
      acceptedAttachmentIds: [file.id],
    })
    await act(async () => {
      await rendered.result.current.handleRetryFailedAgentSend()
    })

    // The retry re-sent the very same document without reading it again.
    expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(2)
    expect(sentAttachments(1)).toEqual(sentAttachments(0))
    expect(sentAttachments(1)[0]).toMatchObject({ id: file.id, digest: { hex: NOTES_DIGEST } })
    expect(arrayBuffer).toHaveBeenCalledTimes(1)
    expect(rendered.result.current.failedAgentSend).toBeNull()
  })

  it('does not blame the files for an unrelated LLM_INVALID_ATTACHMENT on a send without any', async () => {
    const rendered = renderController()
    await settleMount()
    clerum.rpc.invokeHostMessage.mockResolvedValueOnce({
      success: false,
      error: { code: 'LLM_INVALID_ATTACHMENT', message: 'bad image', retryable: false },
    })

    await act(async () => {
      await rendered.result.current.handleSendAgentMessage('no files here')
    })

    // Witness: the send was refused with its own message.
    expect(rendered.spies.pushToast).toHaveBeenCalledWith(
      'Message to agent-x failed: bad image',
      'error'
    )
    expect(rendered.result.current.failedAgentSend?.message).toBe('bad image')
  })

  it('accepted without listing the file: reports it and keeps the snapshot', async () => {
    const rendered = renderController()
    await settleMount()
    const file = await addReadyFile(rendered)
    // An older Host drops the attachment and still answers, with no id list.
    clerum.rpc.invokeHostMessage.mockResolvedValueOnce({
      response: 'done',
      acceptedAttachmentIds: [],
    })

    await act(async () => {
      await rendered.result.current.handleSendAgentMessage('Summarize this')
    })

    expect(rendered.result.current.agentError).toBe(UNSUPPORTED)
    expect(rendered.spies.pushToast).toHaveBeenCalledWith(UNSUPPORTED, 'error')
    expect(rendered.spies.pushToast).not.toHaveBeenCalledWith('Message sent to agent-x.', 'success')
    expect(rendered.result.current.failedAgentSend?.files.map(item => item.id)).toEqual([file.id])
  })

  it('names how many files were dropped when the Host admitted only some', async () => {
    const rendered = renderController()
    await settleMount()
    act(() => {
      rendered.result.current.handleAddComposerFiles(
        [
          new File([NOTES_BYTES], 'a.txt', { type: 'text/plain' }),
          new File([NOTES_BYTES], 'b.txt', { type: 'text/plain' }),
        ],
        ''
      )
    })
    await waitFor(() =>
      expect(rendered.result.current.composerFileAttachments.map(item => item.status)).toEqual([
        'ready',
        'ready',
      ])
    )
    const [first] = rendered.result.current.composerFileAttachments
    clerum.rpc.invokeHostMessage.mockResolvedValueOnce({
      response: 'done',
      acceptedAttachmentIds: [first!.id],
    })

    await act(async () => {
      await rendered.result.current.handleSendAgentMessage('Summarize these')
    })

    const partial =
      'The Host did not receive 1 of the attached files. Your files are kept so you can retry.'
    expect(rendered.result.current.agentError).toBe(partial)
    expect(rendered.result.current.failedAgentSend?.files).toHaveLength(2)
  })

  it('async task accepted without listing the file: keeps the snapshot after the task succeeds', async () => {
    clerum.rpc.getTaskResult.mockResolvedValue({ status: 'completed', response: 'all done' })
    const rendered = renderController()
    await settleMount()
    const file = await addReadyFile(rendered)
    clerum.rpc.invokeHostMessage.mockResolvedValueOnce({
      taskId: 'task-doc',
      acceptedAttachmentIds: [],
    })

    const send = act(async () => {
      await rendered.result.current.handleSendAgentMessage('Summarize this')
    })
    await waitFor(() => expect(clerum.hasProgressHandler('task-doc')).toBe(true))
    await send

    // The sent bubble lists the document by name.
    const sent = rendered.result.current.chatMessages.find(message => message.role === 'user')
    expect(sent?.attachments).toEqual([
      expect.objectContaining({ id: file.id, type: 'uploaded_file', label: 'notes.txt' }),
    ])

    await act(async () => {
      clerum.emitTaskProgress('task-doc', {
        type: 'terminal',
        data: { taskId: 'task-doc', status: 'completed' },
      })
    })

    // Witness that the success branch ran: the durable reply was persisted.
    await waitFor(() =>
      expect(clerum.chat.appendMessages).toHaveBeenCalledWith(
        'agent-x',
        expect.any(String),
        expect.arrayContaining([
          expect.objectContaining({ role: 'assistant', content: 'all done' }),
        ])
      )
    )
    expect(rendered.spies.pushToast).toHaveBeenCalledWith(UNSUPPORTED, 'error')
    expect(rendered.result.current.failedAgentSend?.message).toBe(UNSUPPORTED)
    expect(rendered.result.current.failedAgentSend?.files.map(item => item.id)).toEqual([file.id])
  })

  it('titles a new chat from both the images and the documents of a send without text', async () => {
    clerum.rpc.invokeHostMessage.mockResolvedValue({ response: 'done' })
    const modelTransport = {
      getHostModels: vi.fn(async () => imageCatalog),
      setHostModel: vi.fn(),
    }
    Object.assign(clerum.rpc, modelTransport)
    const rendered = renderController()
    await settleMount()
    // An image send needs a model with verified image input.
    await act(async () => {
      await loadHostModels(modelTransport, 'agent-x', null)
    })
    expect(rendered.result.current.activeChatId).toBeNull()
    act(() => {
      rendered.result.current.handleAddComposerImageAttachments([
        {
          id: 'image-1',
          name: 'shot.png',
          mimeType: 'image/png',
          dataBase64: 'YWJj',
          sizeBytes: 3,
          previewDataUrl: 'data:image/png;base64,YWJj',
        },
      ])
    })
    await addReadyFile(rendered)

    await act(async () => {
      await rendered.result.current.handleSendAgentMessage('')
    })

    // Witness: the send auto-created the chat that gets the title.
    const createdChatId = rendered.result.current.activeChatId
    expect(createdChatId).not.toBeNull()
    await waitFor(() =>
      expect(clerum.chat.rename).toHaveBeenCalledWith(
        'agent-x',
        createdChatId,
        'Images: shot.png; Files: notes.txt',
        1
      )
    )
  })

  it('does not read an empty ack (an unreadable Host answer) as a dropped file', async () => {
    const rendered = renderController()
    await settleMount()
    await addReadyFile(rendered)
    clerum.rpc.invokeHostMessage.mockResolvedValueOnce({})

    await act(async () => {
      await rendered.result.current.handleSendAgentMessage('Summarize this')
    })

    // Witness: the send went out with the document and was not marked failed.
    expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1)
    expect(sentAttachments()).toHaveLength(1)
    expect(rendered.result.current.failedAgentSend).toBeNull()
    expect(rendered.result.current.agentError).toBeNull()
    expect(rendered.spies.pushToast).not.toHaveBeenCalledWith(UNSUPPORTED, 'error')
  })
})
