/**
 * The message route parses `locationReferences` with the shared contract and
 * refuses a malformed list with the same 200 MessageResponse as a malformed
 * `fileReferences`, before admission resolves anything.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'
import {
  LOCATION_REFERENCE_MAX_COUNT,
  buildGfsFileReference,
  buildGfsLocationReference,
  classifyBytes,
} from '@clerum/gfs-interaction-policy'
import { type IncomingAdmissionDeps, createIncomingAdmission } from '../../agent/incomingAdmission'
import { handleMessageRoute } from '../routes'
import { makeHandlers } from './testHelpers'

const rid = (n: number) => n.toString(16).padStart(32, '0')

function folder(n: number, overrides: Record<string, unknown> = {}) {
  const built = buildGfsLocationReference({
    drive: 'main',
    resourceId: rid(n),
    gfsUri: `gfs://main/${rid(n)}`,
    name: `Folder-${n}`,
  })
  if (!built.ok) throw new Error(built.message)
  return { ...built.value, ...overrides }
}

function fileReference(n: number) {
  const built = buildGfsFileReference({
    drive: 'main',
    resourceId: rid(n),
    gfsUri: `gfs://main/${rid(n)}`,
    version: 1,
    name: `doc-${n}.md`,
    declaredMediaType: 'text/markdown',
    byteLength: 10,
    classification: classifyBytes({
      bytes: new Uint8Array(0),
      totalByteLength: 10,
      declaredMediaType: 'text/markdown',
      filename: `doc-${n}.md`,
    }),
  })
  if (!built.ok) throw new Error(built.message)
  return built.value
}

function makeRes() {
  const captured: { statusCode?: number; jsonBody?: unknown } = {}
  const res = {
    writeHead: vi.fn((status: number) => {
      captured.statusCode = status
      return res
    }),
    end: vi.fn((body?: string) => {
      if (typeof body === 'string') captured.jsonBody = JSON.parse(body)
      return res
    }),
  } as unknown as Response
  return { captured, res }
}

function route() {
  const dispatch = vi.fn<IncomingAdmissionDeps['dispatch']>(() => ({
    success: true,
    status: 'pending',
    taskId: 'task-1',
  }))
  const messageHandler = createIncomingAdmission({
    limits: { maxCount: 20, maxBytes: 1_000_000, maxFileBytes: 1_000_000 },
    queueReady: () => true,
    degradedReason: () => null,
    hostProvider: () => 'zai',
    getConversationByKey: async () => undefined,
    resolveTaskModel: () => null,
    resolveImageInput: () => undefined,
    applySessionModelSelection: vi.fn(),
    dispatch,
    fileReferenceGfs: () => ({ status: 'unsupported' }),
    logger: { info: vi.fn(), warn: vi.fn() },
  })
  return { dispatch, handlers: makeHandlers({ messageHandler }) }
}

function request(fields: Record<string, unknown>) {
  return {
    runtimeCaller: { caller: 'rpc-proxy', hostRef: 'chatllm', userId: 'legit-user' },
    body: {
      sender: 'legit-user',
      channelType: 'rpc',
      channelId: 'agent-x',
      threadId: 'chat-1',
      content: 'Create a file in the folder',
      timestamp: 'now',
      messageId: 'm-loc',
      hostRef: 'chatllm',
      ...fields,
    },
    query: {},
  } as unknown as Request
}

describe('handleMessageRoute — location references', () => {
  it('dispatches the parsed folder and names it on the ack', async () => {
    const ref = folder(1)
    const { dispatch, handlers } = route()
    const { captured, res } = makeRes()
    await handleMessageRoute(request({ locationReferences: [ref] }), res, handlers)
    expect(captured.statusCode).toBe(200)
    expect(dispatch.mock.calls[0]![0].locationReferences).toEqual([ref])
    expect(captured.jsonBody).toEqual({
      success: true,
      status: 'pending',
      taskId: 'task-1',
      acceptedLocationReferenceIds: [ref.id],
    })
  })

  it('normalizes an empty list to a message without locations', async () => {
    const { dispatch, handlers } = route()
    const { captured, res } = makeRes()
    await handleMessageRoute(request({ locationReferences: [] }), res, handlers)
    expect(captured.statusCode).toBe(200)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls[0]![0].locationReferences).toBeUndefined()
    expect(captured.jsonBody).toEqual({ success: true, status: 'pending', taskId: 'task-1' })
  })

  it.each([
    [
      'more folders than the limit',
      () => Array.from({ length: LOCATION_REFERENCE_MAX_COUNT + 1 }, (_, i) => folder(i + 1)),
      'FILE_REFERENCE_INVALID',
    ],
    ['a non-list value', () => folder(1), 'FILE_REFERENCE_INVALID'],
    ['a null value', () => null, 'FILE_REFERENCE_INVALID'],
    ['a file reference', () => [fileReference(1)], 'FILE_REFERENCE_INVALID'],
    [
      'a forged id',
      () => [folder(1, { id: `gfs-folder:main:${rid(2)}` })],
      'FILE_REFERENCE_INVALID',
    ],
    [
      'an unsupported schema version',
      () => [folder(1, { schemaVersion: 2 })],
      'FILE_REFERENCE_SCHEMA_VERSION_UNSUPPORTED',
    ],
  ])('refuses %s with a 200 MessageResponse before dispatch', async (_label, value, code) => {
    const { dispatch, handlers } = route()
    // Control: a valid folder on the same route reaches dispatch.
    await handleMessageRoute(request({ locationReferences: [folder(1)] }), makeRes().res, handlers)
    expect(dispatch).toHaveBeenCalledTimes(1)

    const { captured, res } = makeRes()
    await handleMessageRoute(request({ locationReferences: value() }), res, handlers)
    expect(captured.statusCode).toBe(200)
    expect(captured.jsonBody).toEqual({
      success: false,
      error: { code, message: expect.any(String), retryable: false, provider: 'unknown' },
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('refuses a malformed folder even when the file references are valid', async () => {
    const { dispatch, handlers } = route()
    const { captured, res } = makeRes()
    await handleMessageRoute(
      request({ fileReferences: [fileReference(1)], locationReferences: 'nope' }),
      res,
      handlers
    )
    expect(captured.jsonBody).toMatchObject({
      success: false,
      error: { code: 'FILE_REFERENCE_INVALID' },
    })
    expect(dispatch).not.toHaveBeenCalled()
  })
})
