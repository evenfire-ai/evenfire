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
  id: `global-file:${RID}`,
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
      'Global Files: plan.md. These files were explicitly selected by the user.'
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
  id: `global-file:${RID.replace('0', 'f')}`,
  resourceId: RID.replace('0', 'f'),
  gfsUri: `gfs://main/${RID.replace('0', 'f')}`,
  label: 'notes.md',
  version: 1,
}

const PLAN_ID = `gfs:main:${RID}@v4`
const NOTES_ID = `gfs:main:${RID.replace('0', 'f')}@v1`

/** The synchronous ack is a direct reply; the async ack carries a task id. */
const ACK_SHAPES = [
  ['synchronous', { response: 'done' }],
  ['async', { taskId: 'task-refs' }],
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
function expectAcceptedAck(shape: string, pushToast: ReturnType<typeof vi.fn>) {
  if (shape === 'synchronous') {
    expect(pushToast).toHaveBeenCalledWith('Message sent to agent-x.', 'success')
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
      expectAcceptedAck(shape, spies.pushToast)
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
    '%s ack that echoes only some sent ids shows the error',
    async (shape, ack) => {
      const { result, spies } = await sendWithReferences(
        { ...ack, acceptedFileReferenceIds: [PLAN_ID] },
        [planFile, notesFile]
      )

      expect(sentReferenceIds()).toEqual([PLAN_ID, NOTES_ID])
      expect(result.current.agentError).toBe(NOT_RECEIVED)
      expect(spies.pushToast).toHaveBeenCalledWith(NOT_RECEIVED, 'error')
      expectAcceptedAck(shape, spies.pushToast)
      expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1)
    }
  )

  it('does not check the ack of a send without references', async () => {
    const { result, spies } = await sendWithReferences({ response: 'done' }, [])

    // Witness: the send was accepted; the ack carries no ids and needs none.
    expectAcceptedAck('synchronous', spies.pushToast)
    expect(sentRequest()).not.toHaveProperty('fileReferences')
    expect(result.current.agentError).toBeNull()
    expect(spies.pushToast).not.toHaveBeenCalledWith(NOT_RECEIVED, 'error')
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
