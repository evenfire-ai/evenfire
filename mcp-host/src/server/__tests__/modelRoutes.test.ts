import { describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'
import { handleModelsListRoute, handleSetModelRoute } from '../routes'
import type { ModelsListHandler, SetModelHandler } from '../types'
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

function makeReq(opts: {
  caller?: 'rpc-proxy'
  userId?: string
  hostRef?: string
  query?: Record<string, unknown>
  body?: Record<string, unknown>
}): Request {
  const runtimeCaller =
    opts.caller === undefined
      ? undefined
      : { caller: opts.caller, hostRef: opts.hostRef, userId: opts.userId }
  return {
    runtimeCaller,
    query: opts.query ?? {},
    body: opts.body ?? {},
  } as unknown as Request
}

describe('handleModelsListRoute (GET /v1/runtime/models)', () => {
  const result = {
    provider: 'claude',
    hostDefault: 'claude-opus-4-8',
    sessionModel: 'claude-haiku-4-5',
    degraded: false,
    models: [
      { name: 'claude-opus-4-8', displayName: 'Opus 4.8', contextWindowTokens: 200000 },
      { name: 'claude-haiku-4-5' },
    ],
  }

  it('returns 200 with the projection and passes userId/hostRef/chatId', async () => {
    const modelsListHandler: ModelsListHandler = vi.fn().mockResolvedValue(result)
    const req = makeReq({
      caller: 'rpc-proxy',
      userId: 'u-1',
      hostRef: 'chatllm',
      query: { chatId: 'c-9' },
    })
    const captured = makeRes()
    await handleModelsListRoute(req, captured.res, makeHandlers({ modelsListHandler }))
    expect(captured.statusCode).toBe(200)
    expect(captured.jsonBody).toEqual(result)
    expect(modelsListHandler).toHaveBeenCalledWith('u-1', 'chatllm', 'c-9')
  })

  it('passes chatId undefined when the query is absent', async () => {
    const modelsListHandler: ModelsListHandler = vi.fn().mockResolvedValue(result)
    const req = makeReq({ caller: 'rpc-proxy', userId: 'u-1', hostRef: 'chatllm' })
    const captured = makeRes()
    await handleModelsListRoute(req, captured.res, makeHandlers({ modelsListHandler }))
    expect(modelsListHandler).toHaveBeenCalledWith('u-1', 'chatllm', undefined)
  })

  it('returns 401 without a verified rpc-proxy caller', async () => {
    const req = makeReq({ query: {} })
    const captured = makeRes()
    await handleModelsListRoute(req, captured.res, makeHandlers({ modelsListHandler: vi.fn() }))
    expect(captured.statusCode).toBe(401)
  })

  it('returns 501 when the handler is not configured', async () => {
    const req = makeReq({ caller: 'rpc-proxy', userId: 'u-1', hostRef: 'chatllm' })
    const captured = makeRes()
    await handleModelsListRoute(req, captured.res, makeHandlers({ modelsListHandler: null }))
    expect(captured.statusCode).toBe(501)
  })
})

describe('handleSetModelRoute (POST /v1/runtime/model)', () => {
  it('returns 200 { effective:"next-task", provider, model } on success', async () => {
    const setModelHandler: SetModelHandler = vi
      .fn()
      .mockResolvedValue({ ok: true, provider: 'claude', model: 'claude-haiku-4-5' })
    const req = makeReq({
      caller: 'rpc-proxy',
      userId: 'u-1',
      hostRef: 'chatllm',
      body: { chatId: 'c-9', model: 'claude-haiku-4-5' },
    })
    const captured = makeRes()
    await handleSetModelRoute(req, captured.res, makeHandlers({ setModelHandler }))
    expect(captured.statusCode).toBe(200)
    expect(captured.jsonBody).toEqual({
      effective: 'next-task',
      provider: 'claude',
      model: 'claude-haiku-4-5',
    })
    expect(setModelHandler).toHaveBeenCalledWith('u-1', 'chatllm', 'c-9', 'claude-haiku-4-5')
  })

  it('returns 403 model_not_allowed when the handler rejects the model', async () => {
    const setModelHandler: SetModelHandler = vi.fn().mockResolvedValue({
      ok: false,
      reason: 'model_not_allowed',
      provider: 'claude',
      model: 'gpt-5',
    })
    const req = makeReq({
      caller: 'rpc-proxy',
      userId: 'u-1',
      hostRef: 'chatllm',
      body: { chatId: 'c-9', model: 'gpt-5' },
    })
    const captured = makeRes()
    await handleSetModelRoute(req, captured.res, makeHandlers({ setModelHandler }))
    expect(captured.statusCode).toBe(403)
    expect(captured.jsonBody).toEqual({
      error: 'model_not_allowed',
      provider: 'claude',
      model: 'gpt-5',
    })
  })

  it('returns 400 when chatId is missing (mandatory)', async () => {
    const setModelHandler: SetModelHandler = vi.fn()
    const req = makeReq({
      caller: 'rpc-proxy',
      userId: 'u-1',
      hostRef: 'chatllm',
      body: { model: 'claude-haiku-4-5' },
    })
    const captured = makeRes()
    await handleSetModelRoute(req, captured.res, makeHandlers({ setModelHandler }))
    expect(captured.statusCode).toBe(400)
    expect(setModelHandler).not.toHaveBeenCalled()
  })

  it('returns 400 when model is missing', async () => {
    const setModelHandler: SetModelHandler = vi.fn()
    const req = makeReq({
      caller: 'rpc-proxy',
      userId: 'u-1',
      hostRef: 'chatllm',
      body: { chatId: 'c-9' },
    })
    const captured = makeRes()
    await handleSetModelRoute(req, captured.res, makeHandlers({ setModelHandler }))
    expect(captured.statusCode).toBe(400)
    expect(setModelHandler).not.toHaveBeenCalled()
  })

  it('returns 401 without a verified rpc-proxy caller (cross-user defense)', async () => {
    const req = makeReq({ body: { chatId: 'c-9', model: 'claude-haiku-4-5' } })
    const captured = makeRes()
    await handleSetModelRoute(req, captured.res, makeHandlers({ setModelHandler: vi.fn() }))
    expect(captured.statusCode).toBe(401)
  })
})
