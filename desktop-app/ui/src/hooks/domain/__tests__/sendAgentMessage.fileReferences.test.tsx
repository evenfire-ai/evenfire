// @vitest-environment jsdom
/**
 * Issue #666 — a Global Files selection is sent as a structured FileReference v1
 * in `fileReferences`, next to the prompt line that names it. The prompt no
 * longer tells the model how to read the file; the Host's turn context does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import type { ComposerGlobalFileReference } from '../../../uiTypes'
import { renderController } from './__fixtures__/controllerHarness'
import { type MockClerum, installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

let clerum: MockClerum
let uuidCounter = 0

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const RID = '0123456789abcdef0123456789abcdef'

const planFile: ComposerGlobalFileReference = {
  id: `global-file:main:${RID}`,
  type: 'global_file',
  resourceId: RID,
  drive: 'main',
  gfsUri: `gfs://main/${RID}`,
  label: 'plan.md',
  version: 4,
  bytes: 2048,
}

beforeEach(() => {
  uuidCounter = 0
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(
    () => `uuid-${++uuidCounter}` as `${string}-${string}-${string}-${string}-${string}`
  )
  clerum = installMockClerum()
})

afterEach(() => {
  vi.restoreAllMocks()
  uninstallMockClerum()
})

async function settleMount() {
  await waitFor(() => expect(clerum.chat.getIndex).toHaveBeenCalled())
}

function sentRequest(): Record<string, unknown> {
  expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1)
  return clerum.rpc.invokeHostMessage.mock.calls[0]?.[1] as Record<string, unknown>
}

describe('sendAgentMessage — structured Global Files references (#666)', () => {
  it('sends the selection as a FileReference v1', async () => {
    clerum.rpc.invokeHostMessage.mockResolvedValue({ response: 'done' })
    const { result } = renderController()
    await settleMount()

    act(() => {
      result.current.handleAddComposerReferenceAttachments([planFile])
    })
    await act(async () => {
      await result.current.handleSendAgentMessage('Summarize the plan')
    })

    const request = sentRequest()
    expect(request.fileReferences).toEqual([
      expect.objectContaining({
        schemaVersion: 1,
        id: `gfs:main:${RID}@v4`,
        source: {
          kind: 'gfs',
          drive: 'main',
          resourceId: RID,
          gfsUri: `gfs://main/${RID}`,
          version: 4,
        },
        name: 'plan.md',
        class: 'markdown',
        byteLength: 2048,
      }),
    ])
    expect(request.content).toContain(
      'Global Files: "plan.md". These files were explicitly selected by the user.'
    )
    expect(request.content).not.toContain('clerum__gfs_read')
    // The URI travels only in the structured reference above.
    expect(request.content).not.toContain('gfs://')
  })

  it('sends no fileReferences field without a Global Files selection', async () => {
    clerum.rpc.invokeHostMessage.mockResolvedValue({ response: 'done' })
    const { result } = renderController()
    await settleMount()

    await act(async () => {
      await result.current.handleSendAgentMessage('plain question')
    })

    // Witness: the message was sent with its content.
    const request = sentRequest()
    expect(request.content).toBe('plain question')
    expect(request).not.toHaveProperty('fileReferences')
  })
})

const NOT_RECEIVED =
  'The Host did not receive the selected Global Files; the message was sent without them.'

const notesFile: ComposerGlobalFileReference = {
  ...planFile,
  id: `global-file:main:${RID.replace('0', 'f')}`,
  resourceId: RID.replace('0', 'f'),
  gfsUri: `gfs://main/${RID.replace('0', 'f')}`,
  label: 'notes.md',
  version: 1,
}

const PLAN_ID = `gfs:main:${RID}@v4`
const NOTES_ID = `gfs:main:${RID.replace('0', 'f')}@v1`

/**
 * The Host's accepted answers (`messageHandler.ts`): a direct reply, a new
 * task, and the replay of a duplicate delivery whose first task completed.
 */
const ACK_SHAPES = [
  ['synchronous', { success: true, response: 'done' }],
  ['async', { success: true, status: 'pending', taskId: 'task-refs' }],
  ['async replay', { success: true, status: 'completed', taskId: 'task-refs', response: 'done' }],
] as const

async function sendWithReferences(
  ack: Record<string, unknown>,
  references: ComposerGlobalFileReference[]
) {
  clerum.rpc.invokeHostMessage.mockResolvedValue(ack)
  const rendered = renderController()
  await settleMount()
  act(() => {
    rendered.result.current.handleAddComposerReferenceAttachments(references)
  })
  await act(async () => {
    await rendered.result.current.handleSendAgentMessage('Summarize the files')
  })
  return rendered
}

function sentReferenceIds(): string[] {
  const request = sentRequest()
  return (request.fileReferences as Array<{ id: string }>).map(reference => reference.id)
}

/** Proves the accepted-ack branch ran, whatever the ack shape. */
function expectAcceptedAck(
  shape: string,
  pushToast: ReturnType<typeof vi.fn>,
  droppedMessage?: string
) {
  if (shape === 'synchronous') {
    if (droppedMessage === undefined) {
      expect(pushToast).toHaveBeenCalledWith('Message sent to agent-x.', 'success')
      return
    }
    // A send that lost its files shows only the error that says so: a success
    // toast beside it would contradict it. The error toast is the witness that
    // the accepted branch ran, and no other error toast may appear with it.
    expect(pushToast).not.toHaveBeenCalledWith('Message sent to agent-x.', 'success')
    expect(pushToast.mock.calls.filter(([, kind]) => kind === 'error')).toEqual([
      [droppedMessage, 'error'],
    ])
    return
  }
  expect(clerum.chat.appendMessages).toHaveBeenCalledWith(
    'agent-x',
    expect.any(String),
    expect.arrayContaining([expect.objectContaining({ role: 'user', task_id: 'task-refs' })])
  )
}

describe('sendAgentMessage — references the Host did not receive (#666 M1)', () => {
  it.each(ACK_SHAPES)(
    '%s ack without acceptedFileReferenceIds shows the error once, without a retry',
    async (shape, ack) => {
      const { result, spies } = await sendWithReferences({ ...ack }, [planFile])

      expect(sentReferenceIds()).toEqual([PLAN_ID])
      expect(result.current.agentError).toBe(NOT_RECEIVED)
      expect(spies.pushToast).toHaveBeenCalledWith(NOT_RECEIVED, 'error')
      // The send stands: accepted, not failed, and not resent.
      expectAcceptedAck(shape, spies.pushToast, NOT_RECEIVED)
      expect(result.current.failedAgentSend).toBeNull()
      expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1)
    }
  )

  it.each(ACK_SHAPES)('%s ack that echoes every sent id shows no error', async (shape, ack) => {
    const { result, spies } = await sendWithReferences(
      { ...ack, acceptedFileReferenceIds: [PLAN_ID, NOTES_ID] },
      [planFile, notesFile]
    )

    // Witness: the ack reached the accepted branch and echoed exactly the
    // ids that were sent.
    expectAcceptedAck(shape, spies.pushToast)
    expect(sentReferenceIds()).toEqual([PLAN_ID, NOTES_ID])
    expect(result.current.agentError).toBeNull()
    expect(spies.pushToast).not.toHaveBeenCalledWith(NOT_RECEIVED, 'error')
  })

  it.each(ACK_SHAPES)(
    '%s ack that echoes only some sent ids names the dropped count',
    async (shape, ack) => {
      const { result, spies } = await sendWithReferences(
        { ...ack, acceptedFileReferenceIds: [PLAN_ID] },
        [planFile, notesFile]
      )

      expect(sentReferenceIds()).toEqual([PLAN_ID, NOTES_ID])
      const partial =
        'The Host did not receive 1 of the selected Global Files; the message was sent without them.'
      expect(result.current.agentError).toBe(partial)
      expect(spies.pushToast).toHaveBeenCalledWith(partial, 'error')
      expectAcceptedAck(shape, spies.pushToast, partial)
      expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1)
    }
  )

  it('shows a file reference refusal as its own error, not as a drop', async () => {
    const refusal = {
      success: false,
      error: {
        code: 'FILE_REFERENCE_CHECK_FAILED',
        message: 'The selected files could not be checked. Try again.',
        retryable: true,
        provider: 'unknown',
      },
    }
    const { result, spies } = await sendWithReferences(refusal, [planFile])

    // Witness: the refusal reached the chat as an error message with its code.
    expect(sentReferenceIds()).toEqual([PLAN_ID])
    const lastMessage = result.current.chatMessages.at(-1)
    expect(lastMessage).toMatchObject({
      role: 'assistant',
      isError: true,
      errorCode: 'FILE_REFERENCE_CHECK_FAILED',
      content: 'The selected files could not be checked. Try again.',
    })
    expect(result.current.agentError).not.toBe(NOT_RECEIVED)
    expect(spies.pushToast).not.toHaveBeenCalledWith(NOT_RECEIVED, 'error')
  })

  it('does not check the ack of a send without references', async () => {
    const { result, spies } = await sendWithReferences({ response: 'done' }, [])

    // Witness: the send was accepted; the ack carries no ids and needs none.
    expectAcceptedAck('synchronous', spies.pushToast)
    expect(sentRequest()).not.toHaveProperty('fileReferences')
    expect(result.current.agentError).toBeNull()
    expect(spies.pushToast).not.toHaveBeenCalledWith(NOT_RECEIVED, 'error')
  })
})

describe('sendAgentMessage — file limit (#666 M4)', () => {
  function manyFiles(count: number): ComposerGlobalFileReference[] {
    return Array.from({ length: count }, (_, index) => {
      const rid = index.toString(16).padStart(32, 'a')
      return {
        ...planFile,
        id: `global-file:main:${rid}`,
        resourceId: rid,
        gfsUri: `gfs://main/${rid}`,
        label: `f${index}.md`,
      }
    })
  }

  it('refuses an eleventh file before anything is cleared or sent', async () => {
    clerum.rpc.invokeHostMessage.mockResolvedValue({ response: 'done' })
    const { result, spies } = renderController()
    await settleMount()

    // Two picker opens, each within the ten-file limit on its own.
    act(() => {
      result.current.handleAddComposerReferenceAttachments(manyFiles(6))
    })
    act(() => {
      result.current.handleAddComposerReferenceAttachments(manyFiles(11).slice(6))
    })
    // Liveness witness: all eleven are in the composer, so the refusal below
    // comes from the limit and not from an empty selection.
    expect(result.current.composerReferenceAttachments).toHaveLength(11)

    await act(async () => {
      await result.current.handleSendAgentMessage('Summarize the files')
    })

    const limit = 'A message can reference at most 10 files.'
    expect(result.current.agentError).toBe(limit)
    expect(spies.pushToast).toHaveBeenCalledWith(limit, 'error')
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
    // The composer keeps the selection so the user can remove one and resend.
    expect(result.current.composerReferenceAttachments).toHaveLength(11)
    expect(result.current.agentSending).toBe(false)
  })

  it('sends after the user removes the extra file, so the refusal does not lock the composer', async () => {
    clerum.rpc.invokeHostMessage.mockResolvedValue({ response: 'done' })
    const { result } = renderController()
    await settleMount()

    const files = manyFiles(11)
    act(() => {
      result.current.handleAddComposerReferenceAttachments(files)
    })
    await act(async () => {
      await result.current.handleSendAgentMessage('Summarize the files')
    })
    // Liveness witness: the first attempt was refused.
    expect(result.current.agentError).toBe('A message can reference at most 10 files.')
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()

    act(() => {
      result.current.handleRemoveComposerReferenceAttachment(files[10]!.id)
    })
    // Removing a file answers the refusal, so the error goes away with it.
    expect(result.current.agentError).toBeNull()

    await act(async () => {
      await result.current.handleSendAgentMessage('Summarize the files')
    })
    expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1)
  })

  it('refuses a selection whose reference cannot be built, before anything is cleared or sent', async () => {
    clerum.rpc.invokeHostMessage.mockResolvedValue({ response: 'done' })
    const { result, spies } = renderController()
    await settleMount()

    act(() => {
      result.current.handleAddComposerReferenceAttachments([
        { ...planFile, label: 'drafts/plan.md' },
      ])
    })
    await act(async () => {
      await result.current.handleSendAgentMessage('Summarize the plan')
    })

    expect(result.current.agentError).toMatch(/^Global file reference is invalid \(/)
    expect(spies.pushToast).toHaveBeenCalledWith(result.current.agentError, 'error')
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
    expect(result.current.composerReferenceAttachments).toHaveLength(1)
    expect(result.current.agentSending).toBe(false)
  })
})

describe('sendAgentMessage — payload too large (#666 L12)', () => {
  it('names images and attached files in the 413 message', async () => {
    clerum.rpc.invokeHostMessage.mockRejectedValue(new Error('Request Entity Too Large'))
    const { result } = renderController()
    await settleMount()

    await act(async () => {
      await result.current.handleSendAgentMessage('large send')
    })

    expect(result.current.agentError).toContain(
      'The message is larger than the deployed runtime accepts (images or attached files).'
    )
    expect(result.current.agentError).not.toContain('Image payload')
  })
})
