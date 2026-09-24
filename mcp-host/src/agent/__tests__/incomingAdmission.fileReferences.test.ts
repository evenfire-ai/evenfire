/**
 * #666 — admission resolves structured file references before the task exists.
 * The real resolver runs behind a gfsc double, so every availability here is
 * the one production would compute.
 */
import { type Mock, describe, expect, it, vi } from 'vitest'
import {
  type FileReferenceV1,
  buildGfsFileReference,
  classifyBytes,
} from '@clerum/gfs-interaction-policy'
import { GfscHttpError } from '../../internalTools/gfsClient'
import type { IncomingMessage, MessageResponse } from '../../server/types'
import type { FileReferenceGfscClient } from '../fileReferenceResolver'
import { type IncomingAdmissionDeps, createIncomingAdmission } from '../incomingAdmission'

const RID = '1234567890abcdef1234567890abcdef'
const RID_2 = 'abcdefabcdefabcdefabcdefabcdefab'
const FILE_NAME = 'quarterly-SENTINEL-666.md'

function gfsReference(resourceId = RID, version = 3): FileReferenceV1 {
  const built = buildGfsFileReference({
    drive: 'main',
    resourceId,
    gfsUri: `gfs://main/${resourceId}`,
    version,
    name: FILE_NAME,
    declaredMediaType: 'text/markdown',
    byteLength: 120,
    classification: classifyBytes({
      bytes: new Uint8Array(0),
      totalByteLength: 120,
      declaredMediaType: 'text/markdown',
      filename: FILE_NAME,
    }),
  })
  if (!built.ok) throw new Error(built.message)
  return built.value
}

function view(resourceId: string, fields: Record<string, unknown> = {}) {
  return {
    ok: true,
    data: {
      resourceId,
      rid: resourceId,
      drive: 'main',
      gfsUri: `gfs://main/${resourceId}`,
      kind: 'file',
      name: FILE_NAME,
      version: 3,
      bytes: 120,
      ...fields,
    },
  }
}

function message(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    content: 'summarize the file',
    channelType: 'rpc',
    channelId: 'agent-1',
    sender: 'user-1',
    timestamp: '2026-09-24T10:00:00Z',
    messageId: 'msg-1',
    hostRef: 'host-1',
    threadId: 'chat-1',
    ...overrides,
  }
}

function makeAdmission(
  resolve: FileReferenceGfscClient['resolve'] | null,
  overrides: Partial<IncomingAdmissionDeps> = {}
) {
  const order: string[] = []
  const resolveSpy = resolve
    ? vi.fn<FileReferenceGfscClient['resolve']>((args, call) => {
        order.push('resolve')
        return resolve(args, call)
      })
    : null
  const dispatch = vi.fn<IncomingAdmissionDeps['dispatch']>(() => {
    order.push('dispatch')
    return { success: true, taskId: 't-1', status: 'pending' }
  })
  const applySessionModelSelection = vi.fn<IncomingAdmissionDeps['applySessionModelSelection']>(
    async () => {
      order.push('apply')
      return { ok: true, provider: 'zai', model: 'glm-5.3-flash', modelSelectionRevision: 2 }
    }
  )
  const info: Mock<IncomingAdmissionDeps['logger']['info']> = vi.fn()
  const warn: Mock<IncomingAdmissionDeps['logger']['warn']> = vi.fn()
  const deps: IncomingAdmissionDeps = {
    limits: { maxCount: 4, maxBytes: 1_000_000, maxFileBytes: 1_000_000 },
    queueReady: () => true,
    degradedReason: () => null,
    hostProvider: () => 'zai',
    getConversationByKey: async () => undefined,
    resolveTaskModel: () => null,
    resolveImageInput: () => undefined,
    applySessionModelSelection,
    dispatch,
    fileReferenceClient: () => (resolveSpy ? { resolve: resolveSpy } : null),
    logger: { info, warn },
    ...overrides,
  }
  return {
    admit: createIncomingAdmission(deps),
    dispatch: deps.dispatch as typeof dispatch,
    resolve: resolveSpy,
    applySessionModelSelection,
    info,
    warn,
    order,
  }
}

function dispatched(dispatch: Mock<IncomingAdmissionDeps['dispatch']>): IncomingMessage {
  expect(dispatch).toHaveBeenCalledTimes(1)
  return dispatch.mock.calls[0]![0]
}

function events(spy: Mock<(obj: Record<string, unknown>, msg: string) => void>, name: string) {
  return spy.mock.calls.map(call => call[0]).filter(obj => obj.event === name)
}

describe('incoming admission with file references (#666)', () => {
  it('resolves an available reference and names it on the ack', async () => {
    const ref = gfsReference()
    const { admit, dispatch, resolve } = makeAdmission(async () => view(RID))
    const response = await admit(message({ fileReferences: [ref] }))
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(dispatched(dispatch).fileReferenceResolutions).toEqual([
      { availability: 'available', reference: ref },
    ])
    expect(response).toEqual({
      success: true,
      taskId: 't-1',
      status: 'pending',
      acceptedFileReferenceIds: [ref.id],
    })
  })

  it('admits unavailable references and lists each with its availability', async () => {
    const denied = gfsReference()
    const stale = gfsReference(RID_2)
    const { admit, dispatch } = makeAdmission(async ({ uri }) => {
      if (uri.endsWith(RID)) throw new GfscHttpError(403, 'forbidden')
      return view(RID_2, { version: 5, bytes: 300 })
    })
    const response = (await admit(message({ fileReferences: [denied, stale] }))) as MessageResponse
    expect(dispatched(dispatch).fileReferenceResolutions).toEqual([
      { availability: 'denied', reference: denied },
      { availability: 'stale', reference: stale, resolvedVersion: 5 },
    ])
    expect(response.acceptedFileReferenceIds).toEqual([denied.id, stale.id])
  })

  it('marks every reference unsupported, without gfsc, when the Host has no read scope', async () => {
    const ref = gfsReference()
    const { admit, dispatch } = makeAdmission(null)
    const response = (await admit(message({ fileReferences: [ref] }))) as MessageResponse
    expect(dispatched(dispatch).fileReferenceResolutions).toEqual([
      { availability: 'unsupported', reference: ref },
    ])
    expect(response.acceptedFileReferenceIds).toEqual([ref.id])
  })

  it('logs classes and availabilities, never the file name', async () => {
    const { admit, info } = makeAdmission(async () => view(RID))
    await admit(message({ fileReferences: [gfsReference()] }))
    const resolved = events(info, 'file_reference_resolved')
    // Witness: the resolution log line was emitted.
    expect(resolved).toEqual([
      expect.objectContaining({
        referenceCount: 1,
        availabilities: ['available'],
        fileClasses: ['markdown'],
        byteLength: 120,
      }),
    ])
    expect(JSON.stringify(info.mock.calls)).not.toContain('SENTINEL-666')
  })

  it.each([
    [
      'a transient gfsc failure',
      () => Promise.reject(new GfscHttpError(503, 'not_mounted')),
      { code: 'LLM_API_CALL_FAILED', retryable: true },
      'transient',
    ],
    [
      'a gfsc 400',
      () => Promise.reject(new GfscHttpError(400, 'path_invalid')),
      { code: 'FILE_REFERENCE_INVALID', retryable: false },
      'invalid',
    ],
    [
      'metadata about another file',
      () => Promise.resolve(view(RID_2)),
      { code: 'LLM_API_CALL_FAILED', retryable: false },
      'contract',
    ],
  ])('refuses the message on %s', async (_label, answer, error, failure) => {
    const { admit, dispatch, resolve, warn } = makeAdmission(answer)
    const response = await admit(message({ fileReferences: [gfsReference()] }))
    expect(response).toEqual({
      success: false,
      error: { ...error, message: expect.any(String), provider: 'zai' },
    })
    // Witness: gfsc was asked, and the refusal was logged with its failure.
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(events(warn, 'file_reference_refused')).toEqual([
      expect.objectContaining({ referenceCount: 1, failure }),
    ])
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('resolves before the piggybacked model write, and skips the write on a refusal', async () => {
    const ok = makeAdmission(async () => view(RID))
    const response = (await ok.admit(
      message({ fileReferences: [gfsReference()], model: 'glm-5.3-flash' })
    )) as MessageResponse
    expect(ok.order).toEqual(['resolve', 'apply', 'dispatch'])
    expect(response).toMatchObject({
      modelSelectionRevision: 2,
      acceptedFileReferenceIds: [gfsReference().id],
    })

    const refused = makeAdmission(() => Promise.reject(new GfscHttpError(503, 'down')))
    await refused.admit(message({ fileReferences: [gfsReference()], model: 'glm-5.3-flash' }))
    expect(refused.order).toEqual(['resolve'])
    expect(refused.applySessionModelSelection).not.toHaveBeenCalled()
  })

  it('never forwards caller-supplied resolutions', async () => {
    const forged = [{ availability: 'available' as const, reference: gfsReference() }]
    const { admit, dispatch, resolve } = makeAdmission(async () => view(RID))
    const response = (await admit(message({ fileReferenceResolutions: forged }))) as MessageResponse
    expect(dispatched(dispatch).fileReferenceResolutions).toBeUndefined()
    expect(resolve).not.toHaveBeenCalled()
    expect(response).toEqual({ success: true, taskId: 't-1', status: 'pending' })
  })

  it('omits the ids when dispatch refuses the task', async () => {
    const { admit, dispatch, resolve } = makeAdmission(async () => view(RID), {
      dispatch: vi.fn(() => ({
        success: false,
        error: { code: 'X', message: 'no', retryable: false, provider: 'zai' },
      })),
    })
    const response = await admit(message({ fileReferences: [gfsReference()] }))
    // Witness: the reference was resolved and the resolved message dispatched.
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(dispatched(dispatch).fileReferenceResolutions).toHaveLength(1)
    expect(response).not.toHaveProperty('acceptedFileReferenceIds')
    expect(response).toMatchObject({ success: false })
  })

  it('names the ids on an async ack', async () => {
    const ref = gfsReference()
    const { admit } = makeAdmission(async () => view(RID), {
      dispatch: vi.fn(async () => ({ success: true, taskId: 't-9', status: 'pending' as const })),
    })
    expect(await admit(message({ fileReferences: [ref] }), { async: true })).toEqual({
      success: true,
      taskId: 't-9',
      status: 'pending',
      acceptedFileReferenceIds: [ref.id],
    })
  })

  it('does not call gfsc when the queue is not ready', async () => {
    const { admit, resolve, dispatch } = makeAdmission(async () => view(RID), {
      queueReady: () => false,
    })
    const response = await admit(message({ fileReferences: [gfsReference()] }))
    // Witness: the queue gate produced its own refusal.
    expect(response).toMatchObject({ error: { message: 'Message queue not initialized' } })
    expect(resolve).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })
})
