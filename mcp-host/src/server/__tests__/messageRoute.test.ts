import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'
import { createHash } from 'node:crypto'
import { buildGfsFileReference, classifyBytes } from '@clerum/gfs-interaction-policy'
import { type IncomingAdmissionDeps, createIncomingAdmission } from '../../agent/incomingAdmission'
import { config } from '../../config'
import { ConversationError, ConversationErrorCode } from '../../core/errors'
import { handleMessageRoute } from '../routes'
import type { MessageResponse } from '../types'
import { makeHandlers } from './testHelpers'

interface CapturedRes {
  statusCode?: number
  jsonBody?: unknown
  res: Response
}

function makeRes(): CapturedRes {
  const captured: { statusCode?: number; jsonBody?: unknown } = {}
  const res = {
    writeHead: vi.fn().mockImplementation((status: number) => {
      captured.statusCode = status
      return res
    }),
    end: vi.fn().mockImplementation((body?: string) => {
      if (typeof body === 'string') {
        try {
          captured.jsonBody = JSON.parse(body)
        } catch {
          captured.jsonBody = body
        }
      }
      return res
    }),
  } as unknown as Response
  return {
    get statusCode() {
      return captured.statusCode
    },
    get jsonBody() {
      return captured.jsonBody
    },
    res,
  }
}

describe('handleMessageRoute — rpc sender identity invariant', () => {
  it.each([null, undefined, 42, {}, []])(
    'rejects non-string content %j before dispatch',
    async content => {
      const messageHandler = vi.fn()
      const req = { body: { content } } as unknown as Request
      const captured = makeRes()
      await handleMessageRoute(req, captured.res, makeHandlers({ messageHandler }))
      expect(captured.statusCode).toBe(400)
      expect(messageHandler).not.toHaveBeenCalled()
    }
  )
  // Tests assume auth is enabled (production / minikube default).
  beforeEach(() => {
    ;(config as { enableAuth: boolean }).enableAuth = true
  })
  afterEach(() => {
    ;(config as { enableAuth: boolean }).enableAuth = true
  })

  it('overwrites sender with auth.sub for channelType=rpc (defense-in-depth)', async () => {
    const messageHandler = vi.fn().mockResolvedValue({ success: true, status: 'completed' })
    const req = {
      runtimeCaller: { caller: 'rpc-proxy', hostRef: 'chatllm', userId: 'legit-user' },
      body: {
        sender: 'attacker-pretending-to-be-victim',
        channelType: 'rpc',
        channelId: 'agent-x',
        threadId: 'chat-1',
        content: 'hi',
        timestamp: 'now',
        messageId: 'm1',
        hostRef: 'chatllm',
      },
      query: {},
    } as unknown as Request
    const captured = makeRes()
    await handleMessageRoute(req, captured.res, makeHandlers({ messageHandler }))
    expect(messageHandler).toHaveBeenCalledTimes(1)
    const forwarded = messageHandler.mock.calls[0][0]
    expect(forwarded.sender).toBe('legit-user')
  })

  it('returns 401 for channelType=rpc when edge user context is missing', async () => {
    const messageHandler = vi.fn()
    const req = {
      body: {
        sender: 'someone',
        channelType: 'rpc',
        channelId: 'agent-x',
        threadId: 'chat-1',
        content: 'hi',
        timestamp: 'now',
        messageId: 'm1',
        hostRef: 'chatllm',
      },
      query: {},
    } as unknown as Request
    const captured = makeRes()
    await handleMessageRoute(req, captured.res, makeHandlers({ messageHandler }))
    expect(captured.statusCode).toBe(401)
    expect(messageHandler).not.toHaveBeenCalled()
  })

  it('leaves sender unchanged for non-rpc channels', async () => {
    const messageHandler = vi.fn().mockResolvedValue({ success: true, status: 'completed' })
    const req = {
      runtimeCaller: {
        caller: 'channel-reader',
        hostRef: 'chatllm',
        channelType: 'slack',
        channelId: 'C1',
        sender: '@user123',
      },
      body: {
        sender: '@user123',
        channelType: 'slack',
        channelId: 'C1',
        threadId: 't1',
        content: 'hi',
        timestamp: 'now',
        messageId: 'm1',
        hostRef: 'chatllm',
      },
      query: {},
    } as unknown as Request
    const captured = makeRes()
    await handleMessageRoute(req, captured.res, makeHandlers({ messageHandler }))
    expect(messageHandler).toHaveBeenCalledTimes(1)
    const forwarded = messageHandler.mock.calls[0][0]
    expect(forwarded.sender).toBe('@user123')
  })

  it('rejects channelType=rpc without rpc-proxy edge context even when auth is disabled', async () => {
    ;(config as { enableAuth: boolean }).enableAuth = false
    const messageHandler = vi.fn().mockResolvedValue({ success: true, status: 'completed' })
    const req = {
      body: {
        sender: 'dev-user',
        channelType: 'rpc',
        channelId: 'agent-x',
        threadId: 'chat-1',
        content: 'hi',
        timestamp: 'now',
        messageId: 'm1',
        hostRef: 'chatllm',
      },
      query: {},
    } as unknown as Request
    const captured = makeRes()
    await handleMessageRoute(req, captured.res, makeHandlers({ messageHandler }))
    expect(captured.statusCode).toBe(401)
    expect(messageHandler).not.toHaveBeenCalled()
  })

  it('rejects channel-reader attempts to smuggle channelType=rpc', async () => {
    const messageHandler = vi.fn().mockResolvedValue({ success: true, status: 'completed' })
    const req = {
      runtimeCaller: {
        caller: 'channel-reader',
        hostRef: 'chatllm',
        channelType: 'telegram',
        channelId: 'tg-chat-1',
        sender: '123456',
      },
      body: {
        sender: '123456',
        channelType: 'rpc',
        channelId: 'agent-x',
        threadId: 'chat-1',
        content: 'hi',
        timestamp: 'now',
        messageId: 'm1',
        hostRef: 'chatllm',
      },
      query: {},
    } as unknown as Request
    const captured = makeRes()
    await handleMessageRoute(req, captured.res, makeHandlers({ messageHandler }))
    expect(captured.statusCode).toBe(401)
    expect(messageHandler).not.toHaveBeenCalled()
  })

  it('rejects rpc-proxy attempts to submit provider channel messages', async () => {
    const messageHandler = vi.fn().mockResolvedValue({ success: true, status: 'completed' })
    const req = {
      runtimeCaller: { caller: 'rpc-proxy', hostRef: 'chatllm', userId: 'legit-user' },
      body: {
        sender: '123456',
        channelType: 'telegram',
        channelId: 'tg-chat-1',
        content: 'hi',
        timestamp: 'now',
        messageId: 'm1',
        hostRef: 'chatllm',
      },
      query: {},
    } as unknown as Request
    const captured = makeRes()
    await handleMessageRoute(req, captured.res, makeHandlers({ messageHandler }))
    expect(captured.statusCode).toBe(403)
    expect(messageHandler).not.toHaveBeenCalled()
  })

  it('maps persisted ownership mismatches to a generic 403', async () => {
    const messageHandler = vi
      .fn()
      .mockRejectedValue(
        new ConversationError('sensitive ownership detail', ConversationErrorCode.OwnershipMismatch)
      )
    const req = {
      runtimeCaller: { caller: 'rpc-proxy', hostRef: 'chatllm', userId: 'legit-user' },
      body: {
        sender: 'legit-user',
        channelType: 'rpc',
        channelId: 'agent-x',
        threadId: 'chat-1',
        content: 'hi',
        timestamp: 'now',
        messageId: 'm1',
        hostRef: 'chatllm',
      },
      query: {},
    } as unknown as Request
    const captured = makeRes()

    await handleMessageRoute(req, captured.res, makeHandlers({ messageHandler }))

    expect(captured.statusCode).toBe(403)
    expect(captured.jsonBody).toEqual({ success: false, error: 'session access denied' })
  })
})

describe('handleMessageRoute — async response serialization', () => {
  beforeEach(() => {
    ;(config as { enableAuth: boolean }).enableAuth = true
  })
  afterEach(() => {
    ;(config as { enableAuth: boolean }).enableAuth = true
  })

  // Regression: the piggybacked-model path (R2 "Option A") wraps the handler in
  // an async IIFE (it must persist `message.model` before enqueue), so the async
  // branch can return a Promise. If the route does not AWAIT it, `json()`
  // JSON.stringify's a Promise to `{}` and the async ack's `taskId` is dropped —
  // the desktop then treats a background task as a sync reply and never
  // subscribes to its progress.
  it('awaits a Promise-returning handler on async=true so the ack (taskId) survives', async () => {
    const ack = { success: true, status: 'processing', taskId: 'task-abc' }
    // mockReturnValue(Promise.resolve(...)) — a genuine Promise, mirroring the
    // piggyback wrapper — NOT a synchronously-returned object.
    const messageHandler = vi.fn().mockReturnValue(Promise.resolve(ack))
    const req = {
      runtimeCaller: { caller: 'rpc-proxy', hostRef: 'chatllm', userId: 'legit-user' },
      body: {
        sender: 'legit-user',
        channelType: 'rpc',
        channelId: 'agent-x',
        threadId: 'chat-1',
        content: 'hi',
        timestamp: 'now',
        messageId: 'm1',
        hostRef: 'chatllm',
      },
      query: { async: 'true' },
    } as unknown as Request
    const captured = makeRes()
    await handleMessageRoute(req, captured.res, makeHandlers({ messageHandler }))
    expect(messageHandler).toHaveBeenCalledWith(expect.objectContaining({ sender: 'legit-user' }), {
      async: true,
    })
    expect(captured.statusCode).toBe(200)
    expect(captured.jsonBody).toEqual(ack)
  })

  it('serializes a synchronously-returned ack unchanged on async=true', async () => {
    const ack = { success: true, status: 'processing', taskId: 'task-sync' }
    // The non-piggyback async path returns its ack synchronously; awaiting a
    // non-thenable is a harmless no-op and the body must be identical.
    const messageHandler = vi.fn().mockReturnValue(ack)
    const req = {
      runtimeCaller: { caller: 'rpc-proxy', hostRef: 'chatllm', userId: 'legit-user' },
      body: {
        sender: 'legit-user',
        channelType: 'rpc',
        channelId: 'agent-x',
        threadId: 'chat-1',
        content: 'hi',
        timestamp: 'now',
        messageId: 'm1',
        hostRef: 'chatllm',
      },
      query: { async: 'true' },
    } as unknown as Request
    const captured = makeRes()
    await handleMessageRoute(req, captured.res, makeHandlers({ messageHandler }))
    expect(captured.statusCode).toBe(200)
    expect(captured.jsonBody).toEqual(ack)
  })
})

describe('handleMessageRoute — acceptedAttachmentIds through the real admission (issue #666)', () => {
  beforeEach(() => {
    ;(config as { enableAuth: boolean }).enableAuth = true
  })

  const NOTES = Buffer.from('# Notes\n', 'utf8')
  const file = {
    id: 'file-1',
    kind: 'file',
    mimeType: 'text/markdown',
    detectedMediaType: 'text/markdown',
    encoding: 'base64',
    dataBase64: NOTES.toString('base64'),
    filename: 'notes.md',
    sizeBytes: NOTES.length,
    digest: { algorithm: 'sha256', hex: createHash('sha256').update(NOTES).digest('hex') },
  }

  function routeThroughAdmission(ack: MessageResponse) {
    const dispatch = vi.fn<IncomingAdmissionDeps['dispatch']>(() => ack)
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
      fileReferenceClient: () => null,
      logger: { info: vi.fn(), warn: vi.fn() },
    })
    return { dispatch, handlers: makeHandlers({ messageHandler }) }
  }

  function rpcRequest(attachments: unknown[] | undefined, query: Record<string, string>) {
    return {
      runtimeCaller: { caller: 'rpc-proxy', hostRef: 'chatllm', userId: 'legit-user' },
      body: {
        sender: 'legit-user',
        channelType: 'rpc',
        channelId: 'agent-x',
        threadId: 'chat-1',
        content: 'Analyze the attached file',
        timestamp: 'now',
        messageId: 'm1',
        hostRef: 'chatllm',
        ...(attachments ? { attachments } : {}),
      },
      query,
    } as unknown as Request
  }

  it('returns the accepted ids on the sync response', async () => {
    const { dispatch, handlers } = routeThroughAdmission({ success: true, status: 'completed' })
    const captured = makeRes()

    await handleMessageRoute(rpcRequest([file], {}), captured.res, handlers)

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'm1' }), undefined)
    expect(captured.statusCode).toBe(200)
    expect(captured.jsonBody).toEqual({
      success: true,
      status: 'completed',
      acceptedAttachmentIds: ['file-1'],
    })
  })

  it('returns the accepted ids on the async=true ack', async () => {
    const { dispatch, handlers } = routeThroughAdmission({
      success: true,
      status: 'pending',
      taskId: 'task-1',
    })
    const captured = makeRes()

    await handleMessageRoute(rpcRequest([file], { async: 'true' }), captured.res, handlers)

    expect(dispatch).toHaveBeenCalledWith(expect.anything(), { async: true })
    expect(captured.jsonBody).toEqual({
      success: true,
      status: 'pending',
      taskId: 'task-1',
      acceptedAttachmentIds: ['file-1'],
    })
  })

  it('omits the field on a text-only message', async () => {
    const ack: MessageResponse = { success: true, status: 'pending', taskId: 'task-2' }
    const { dispatch, handlers } = routeThroughAdmission(ack)
    const captured = makeRes()

    await handleMessageRoute(rpcRequest(undefined, { async: 'true' }), captured.res, handlers)

    // Witness: the text turn was dispatched and its ack serialized.
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(captured.jsonBody).toEqual(ack)
  })
})

describe('handleMessageRoute — structured file references (#666)', () => {
  function reference(index: number, overrides: Record<string, unknown> = {}) {
    const rid = index.toString(16).padStart(32, '0')
    const built = buildGfsFileReference({
      drive: 'main',
      resourceId: rid,
      gfsUri: `gfs://main/${rid}`,
      version: 1,
      name: `doc-${index}.md`,
      declaredMediaType: 'text/markdown',
      byteLength: 10,
      classification: classifyBytes({
        bytes: new Uint8Array(0),
        totalByteLength: 10,
        declaredMediaType: 'text/markdown',
        filename: `doc-${index}.md`,
      }),
    })
    if (!built.ok) throw new Error(built.message)
    return { ...built.value, ...overrides }
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
      fileReferenceClient: () => null,
      logger: { info: vi.fn(), warn: vi.fn() },
    })
    return { dispatch, handlers: makeHandlers({ messageHandler }) }
  }

  function request(fileReferences: unknown) {
    return {
      runtimeCaller: { caller: 'rpc-proxy', hostRef: 'chatllm', userId: 'legit-user' },
      body: {
        sender: 'legit-user',
        channelType: 'rpc',
        channelId: 'agent-x',
        threadId: 'chat-1',
        content: 'Summarize the referenced file',
        timestamp: 'now',
        messageId: 'm-ref',
        hostRef: 'chatllm',
        fileReferences,
      },
      query: {},
    } as unknown as Request
  }

  it('dispatches the parsed references and names them on the ack', async () => {
    const refs = [reference(1), reference(2)]
    const { dispatch, handlers } = route()
    const captured = makeRes()
    await handleMessageRoute(request(refs), captured.res, handlers)
    expect(captured.statusCode).toBe(200)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls[0]![0].fileReferences).toEqual(refs)
    expect(captured.jsonBody).toEqual({
      success: true,
      status: 'pending',
      taskId: 'task-1',
      acceptedFileReferenceIds: refs.map(r => r.id),
    })
  })

  it('accepts exactly the configured maximum', async () => {
    const refs = Array.from({ length: config.fileReferenceMaxCount }, (_, i) => reference(i + 1))
    const { dispatch, handlers } = route()
    const captured = makeRes()
    await handleMessageRoute(request(refs), captured.res, handlers)
    expect(captured.statusCode).toBe(200)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it.each([
    [
      'more references than the limit',
      () => Array.from({ length: config.fileReferenceMaxCount + 1 }, (_, i) => reference(i + 1)),
      'FILE_REFERENCE_INVALID',
    ],
    ['a non-list value', () => ({ id: 'x' }), 'FILE_REFERENCE_INVALID'],
    ['a null value', () => null, 'FILE_REFERENCE_INVALID'],
    [
      'an unsupported schema version',
      () => [reference(1, { schemaVersion: 2 })],
      'FILE_REFERENCE_SCHEMA_VERSION_UNSUPPORTED',
    ],
    [
      'a gfsUri on another drive',
      () => {
        const ref = reference(1)
        if (ref.source.kind !== 'gfs') throw new Error('expected a GFS reference')
        return [
          { ...ref, source: { ...ref.source, gfsUri: `gfs://other/${ref.source.resourceId}` } },
        ]
      },
      'FILE_REFERENCE_INVALID',
    ],
  ])('refuses %s with 400 before dispatch', async (_label, value, code) => {
    const { dispatch, handlers } = route()
    // Control: a valid reference on the same route reaches dispatch.
    await handleMessageRoute(request([reference(1)]), makeRes().res, handlers)
    expect(dispatch).toHaveBeenCalledTimes(1)

    const captured = makeRes()
    await handleMessageRoute(request(value()), captured.res, handlers)
    expect(captured.statusCode).toBe(400)
    expect(captured.jsonBody).toEqual({
      success: false,
      error: { code, message: expect.any(String), retryable: false, provider: 'unknown' },
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
})
