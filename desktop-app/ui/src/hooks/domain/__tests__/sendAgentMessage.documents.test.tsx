// @vitest-environment jsdom
/**
 * Issue #678 — a document picked in the composer travels as an inline
 * `kind:'file'` attachment. These tests drive the public controller API: add a
 * file, send, and read what reached the Host and what the user is told.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import { createHash } from 'node:crypto'
import { getComposerDraft, setComposerDraft } from '@lib/composerDraftStore'
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
/** The Host answered the text and dropped every document (#678 D13). */
const DROPPED =
  'The Host does not accept file attachments yet; the message was sent without them. Recover the files to attach them again once the Host is updated.'

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
    // Nothing was answered: the whole input is still a retry candidate.
    expect(failed?.answeredWithoutFiles).toBe(false)

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

  it('recovers a refused send into the composer with its text and its document', async () => {
    const rendered = renderController()
    await settleMount()
    const file = await addReadyFile(rendered)
    clerum.rpc.invokeHostMessage.mockResolvedValueOnce({
      success: false,
      error: { code: 'LLM_INVALID_ATTACHMENT', message: 'Unsupported attachment kind: file' },
    })
    await act(async () => {
      await rendered.result.current.handleSendAgentMessage('Summarize this')
    })
    // Witness: the refusal kept the document and emptied the composer.
    expect(rendered.result.current.failedAgentSend?.answeredWithoutFiles).toBe(false)
    expect(rendered.result.current.failedAgentSend?.files.map(item => item.id)).toEqual([file.id])
    expect(rendered.result.current.composerFileAttachments).toEqual([])
    const chat = rendered.result.current.activeChatId

    act(() => rendered.result.current.handleRecoverFailedAgentSend())

    expect(getComposerDraft(chat, 'agent-x')).toBe('Summarize this')
    expect(rendered.result.current.composerFileAttachments).toEqual([
      expect.objectContaining({ id: file.id, status: 'ready', digestHex: NOTES_DIGEST }),
    ])
    expect(rendered.result.current.failedAgentSend).toBeNull()
    expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1)
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

    expect(rendered.result.current.agentError).toBe(DROPPED)
    expect(rendered.spies.pushToast).toHaveBeenCalledWith(DROPPED, 'error')
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
      'The Host did not receive 1 of the attached files; the message was sent without them. Recover the files to attach them again.'
    expect(rendered.result.current.agentError).toBe(partial)
    expect(rendered.result.current.failedAgentSend?.files).toHaveLength(2)
  })

  it('recovers only the files the Host did not receive after a partial drop', async () => {
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
    const [delivered, dropped] = rendered.result.current.composerFileAttachments
    clerum.rpc.invokeHostMessage.mockResolvedValueOnce({
      response: 'done',
      acceptedAttachmentIds: [delivered!.id],
    })
    await act(async () => {
      await rendered.result.current.handleSendAgentMessage('Summarize these')
    })
    // Witness: the failure is a files-only recovery holding both documents.
    expect(rendered.result.current.failedAgentSend?.answeredWithoutFiles).toBe(true)
    expect(rendered.result.current.failedAgentSend?.files).toHaveLength(2)

    act(() => rendered.result.current.handleRecoverFailedAgentSend())

    // The Host read a.txt already: only b.txt comes back to attach again.
    expect(rendered.result.current.composerFileAttachments.map(item => item.id)).toEqual([
      dropped!.id,
    ])
    expect(rendered.result.current.failedAgentSend).toBeNull()
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
    expect(rendered.spies.pushToast).toHaveBeenCalledWith(DROPPED, 'error')
    expect(rendered.result.current.failedAgentSend?.message).toBe(DROPPED)
    expect(rendered.result.current.failedAgentSend?.files.map(item => item.id)).toEqual([file.id])
    // The task answered the text: only the files are left to recover.
    expect(rendered.result.current.failedAgentSend?.answeredWithoutFiles).toBe(true)
  })

  it('async task accepted without listing the file, then failed: the text comes back with the files', async () => {
    clerum.rpc.getTaskResult.mockResolvedValue({
      status: 'failed',
      error: { message: 'LLM down', code: 'provider_error' },
    })
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
    // Witness: the drop was recorded first, as a files-only recovery.
    expect(rendered.result.current.failedAgentSend?.answeredWithoutFiles).toBe(true)
    const chat = rendered.result.current.activeChatId

    await act(async () => {
      clerum.emitTaskProgress('task-doc', {
        type: 'terminal',
        data: { taskId: 'task-doc', status: 'failed' },
      })
    })

    // Witness that the failure branch ran: its message replaced the drop notice.
    await waitFor(() => expect(rendered.result.current.failedAgentSend?.message).toBe('LLM down'))
    // The task answered nothing, so this is a rejected send: text and files.
    expect(rendered.result.current.failedAgentSend?.answeredWithoutFiles).toBe(false)
    expect(rendered.result.current.failedAgentSend?.files.map(item => item.id)).toEqual([file.id])

    act(() => rendered.result.current.handleRecoverFailedAgentSend())

    expect(getComposerDraft(chat, 'agent-x')).toBe('Summarize this')
    expect(rendered.result.current.composerFileAttachments).toEqual([
      expect.objectContaining({ id: file.id, status: 'ready', digestHex: NOTES_DIGEST }),
    ])
    expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1)
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
    expect(rendered.spies.pushToast).not.toHaveBeenCalledWith(DROPPED, 'error')
  })
})

/**
 * jozer-rami review 5437205747 — when the Host answered the text and dropped
 * the documents, a retry would send that text again. The failure offers the
 * files back instead, and nothing is re-sent.
 */
describe('sendAgentMessage — a message answered without its documents', () => {
  async function answeredWithoutFiles(rendered: Rendered) {
    const file = await addReadyFile(rendered)
    clerum.rpc.invokeHostMessage.mockResolvedValueOnce({
      response: 'done',
      acceptedAttachmentIds: [],
    })
    await act(async () => {
      await rendered.result.current.handleSendAgentMessage('Summarize this')
    })
    // Witness: the send went out once with the document and the failure kept it.
    expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1)
    expect(sentAttachments()).toEqual([expect.objectContaining({ id: file.id })])
    expect(rendered.result.current.failedAgentSend?.files.map(item => item.id)).toEqual([file.id])
    expect(rendered.result.current.composerFileAttachments).toEqual([])
    return file
  }

  it('marks the failure as answered without its files', async () => {
    const rendered = renderController()
    await settleMount()
    await answeredWithoutFiles(rendered)
    expect(rendered.result.current.failedAgentSend?.answeredWithoutFiles).toBe(true)
  })

  it('refuses to retry, so the answered text is not sent again', async () => {
    const rendered = renderController()
    await settleMount()
    const file = await answeredWithoutFiles(rendered)

    await act(async () => {
      await rendered.result.current.handleRetryFailedAgentSend()
    })

    expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1)
    // Liveness: the failure and its files are still there to recover.
    expect(rendered.result.current.failedAgentSend?.files.map(item => item.id)).toEqual([file.id])
  })

  it('recovers only the files into the composer and sends nothing', async () => {
    const rendered = renderController()
    await settleMount()
    const file = await answeredWithoutFiles(rendered)
    const chat = rendered.result.current.activeChatId

    act(() => rendered.result.current.handleRecoverFailedAgentSend())

    expect(rendered.result.current.composerFileAttachments).toEqual([
      expect.objectContaining({ id: file.id, status: 'ready', digestHex: NOTES_DIGEST }),
    ])
    // The text was answered: it does not come back as a draft to send again.
    expect(getComposerDraft(chat, 'agent-x')).toBe('')
    expect(rendered.result.current.failedAgentSend).toBeNull()
    expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1)
  })

  it('recovers the files next to a new draft and keeps the draft', async () => {
    const rendered = renderController()
    await settleMount()
    const file = await answeredWithoutFiles(rendered)
    const chat = rendered.result.current.activeChatId
    act(() => setComposerDraft(chat, 'A new question', 'agent-x'))

    act(() => rendered.result.current.handleRecoverFailedAgentSend())

    expect(rendered.result.current.composerFileAttachments).toEqual([
      expect.objectContaining({ id: file.id, status: 'ready' }),
    ])
    expect(getComposerDraft(chat, 'agent-x')).toBe('A new question')
    expect(rendered.result.current.failedAgentSend).toBeNull()
  })

  it('does not replace documents already in the composer', async () => {
    const rendered = renderController()
    await settleMount()
    const file = await answeredWithoutFiles(rendered)
    const other = await addReadyFile(
      rendered,
      new File([new TextEncoder().encode('other')], 'other.txt', { type: 'text/plain' })
    )

    act(() => rendered.result.current.handleRecoverFailedAgentSend())

    // Witness: the refusal was shown, so the recover path ran.
    expect(rendered.spies.pushToast).toHaveBeenCalledWith(
      'Remove the documents in the composer before recovering the earlier files.',
      'error'
    )
    expect(rendered.result.current.composerFileAttachments.map(item => item.id)).toEqual([other.id])
    expect(rendered.result.current.failedAgentSend?.files.map(item => item.id)).toEqual([file.id])
  })
})
