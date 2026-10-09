/**
 * #1043 — the Host route that continues a model-step checkpoint.
 *
 * The handler itself is exercised through `handleModelStepContinuationRoute`
 * with the same fake `req`/`res` shape as `messageRoute.test.ts`; the DRAINING
 * fence lives in `server.ts`, so that case runs against a real listening
 * `RPCServer` exactly as `server.drainingFence.test.ts` does.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'
import type { AddressInfo } from 'net'
import fs from 'node:fs'
import path from 'node:path'
import type { ModelStepContinuationHandler } from '../../agent/modelStepContinuation'
import {
  MODEL_STEP_CONTINUE_RUNTIME_ROUTE,
  type ModelStepContinueBlocked,
  type ModelStepContinueClaimed,
} from '../../core/conversation/modelStepCheckpointContract'
import { handleModelStepContinuationRoute } from '../routes'
import { makeHandlers } from './testHelpers'

const VECTOR_DIR = path.join(__dirname, '../../../../tests/fixtures/model-step-checkpoint')
const CHECKPOINT_ID = 'msc_01J9Z7Q4R2M3N5P6Q7R8S9T0V1'

function readVector(name: string): { httpStatus: number; body: Record<string, unknown> } {
  return JSON.parse(fs.readFileSync(path.join(VECTOR_DIR, name), 'utf8')) as {
    httpStatus: number
    body: Record<string, unknown>
  }
}

const BLOCKED_BODY = readVector('continue-response.blocked.json')
  .body as unknown as ModelStepContinueBlocked
const CLAIMED_BODY = readVector('continue-response.claimed.json')
  .body as unknown as ModelStepContinueClaimed

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

const RPC_CALLER = { caller: 'rpc-proxy', hostRef: 'chatllm', userId: 'edge-user' }

function makeReq(
  overrides: {
    params?: Record<string, string>
    body?: unknown
    /** `null` omits the edge caller context entirely. */
    caller?: unknown
  } = {}
): Request {
  const req: Record<string, unknown> = {
    params: {
      agent: 'agent-x',
      chatId: 'chat-1',
      checkpointId: CHECKPOINT_ID,
      ...overrides.params,
    },
    body: overrides.body ?? { version: 3 },
  }
  if (overrides.caller !== null) req.runtimeCaller = overrides.caller ?? RPC_CALLER
  return req as unknown as Request
}

describe('handleModelStepContinuationRoute — request validation (#1043)', () => {
  it.each([
    ['missing', undefined],
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['string', '1'],
    ['null', null],
    ['NaN', Number.NaN],
  ])(
    'rejects a %s version before the handler (witness: a valid version reaches it)',
    async (_label, version) => {
      const handler = vi.fn<ModelStepContinuationHandler>(async () => ({
        status: 202,
        body: CLAIMED_BODY,
      }))

      const rejected = makeRes()
      await handleModelStepContinuationRoute(
        makeReq({ body: { version } }),
        rejected.res,
        makeHandlers({ modelStepContinuationHandler: handler })
      )
      expect(rejected.statusCode).toBe(400)
      // The exact guard message proves the version check ran, not a later one.
      expect(rejected.jsonBody).toEqual({ error: 'version must be a positive integer' })
      expect(handler).not.toHaveBeenCalled()

      const accepted = makeRes()
      await handleModelStepContinuationRoute(
        makeReq({ body: { version: 3 } }),
        accepted.res,
        makeHandlers({ modelStepContinuationHandler: handler })
      )
      expect(accepted.statusCode).toBe(202)
      expect(handler).toHaveBeenCalledTimes(1)
    }
  )

  it.each([
    ['an agent with a colon', { agent: 'a:b' }],
    ['a dot-dot chatId', { chatId: '..' }],
    ['a chatId with a slash', { chatId: 'a/b' }],
    ['an overlong chatId', { chatId: 'x'.repeat(501) }],
    ['an empty checkpointId', { checkpointId: '' }],
    ['a dot-dot checkpointId', { checkpointId: '..' }],
  ])('rejects %s before the handler (witness: safe segments reach it)', async (_label, params) => {
    const handler = vi.fn<ModelStepContinuationHandler>(async () => ({
      status: 202,
      body: CLAIMED_BODY,
    }))

    const rejected = makeRes()
    await handleModelStepContinuationRoute(
      makeReq({ params }),
      rejected.res,
      makeHandlers({ modelStepContinuationHandler: handler })
    )
    expect(rejected.statusCode).toBe(400)
    expect(rejected.jsonBody).toEqual({ error: 'Invalid agent, chatId or checkpointId' })
    expect(handler).not.toHaveBeenCalled()

    const accepted = makeRes()
    await handleModelStepContinuationRoute(
      makeReq(),
      accepted.res,
      makeHandlers({ modelStepContinuationHandler: handler })
    )
    expect(accepted.statusCode).toBe(202)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['without any edge caller context', null],
    ['for a channel-reader caller', { caller: 'channel-reader', hostRef: 'chatllm' }],
    ['for an rpc-proxy caller without a user id', { caller: 'rpc-proxy', hostRef: 'chatllm' }],
  ])(
    'answers 401 %s, before the handler (witness: the rpc-proxy caller reaches it)',
    async (_label, caller) => {
      const handler = vi.fn<ModelStepContinuationHandler>(async () => ({
        status: 202,
        body: CLAIMED_BODY,
      }))

      const rejected = makeRes()
      await handleModelStepContinuationRoute(
        makeReq({ caller }),
        rejected.res,
        makeHandlers({ modelStepContinuationHandler: handler })
      )
      expect(rejected.statusCode).toBe(401)
      expect(rejected.jsonBody).toEqual({ error: 'Missing rpc edge caller context' })
      expect(handler).not.toHaveBeenCalled()

      const accepted = makeRes()
      await handleModelStepContinuationRoute(
        makeReq(),
        accepted.res,
        makeHandlers({ modelStepContinuationHandler: handler })
      )
      expect(accepted.statusCode).toBe(202)
      expect(handler).toHaveBeenCalledTimes(1)
    }
  )

  it('answers 501 when no continuation handler is configured', async () => {
    const captured = makeRes()
    await handleModelStepContinuationRoute(makeReq(), captured.res, makeHandlers())
    expect(captured.statusCode).toBe(501)
    expect(captured.jsonBody).toEqual({ error: 'Model-step continuation handler not configured' })

    // Witness: the same request answers with the configured handler's result.
    const handler = vi.fn<ModelStepContinuationHandler>(async () => ({
      status: 202,
      body: CLAIMED_BODY,
    }))
    const configured = makeRes()
    await handleModelStepContinuationRoute(
      makeReq(),
      configured.res,
      makeHandlers({ modelStepContinuationHandler: handler })
    )
    expect(configured.statusCode).toBe(202)
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

describe('handleModelStepContinuationRoute — identity and relay (#1043)', () => {
  it('relays the handler status and body unchanged', async () => {
    const handler = vi.fn<ModelStepContinuationHandler>(async () => ({
      status: 409,
      body: BLOCKED_BODY,
    }))
    const captured = makeRes()

    await handleModelStepContinuationRoute(
      makeReq({ body: { version: 7 } }),
      captured.res,
      makeHandlers({ modelStepContinuationHandler: handler })
    )

    expect(captured.statusCode).toBe(409)
    expect(captured.jsonBody).toEqual(BLOCKED_BODY)
    expect(captured.statusCode).toBe(readVector('continue-response.blocked.json').httpStatus)
  })

  it('takes the userId from the edge caller context, never from the body', async () => {
    const handler = vi.fn<ModelStepContinuationHandler>(async () => ({
      status: 202,
      body: CLAIMED_BODY,
    }))

    const captured = makeRes()
    await handleModelStepContinuationRoute(
      makeReq({ body: { version: 7, userId: 'body-user', sender: 'body-sender' } }),
      captured.res,
      makeHandlers({ modelStepContinuationHandler: handler })
    )

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({
      userId: 'edge-user',
      agent: 'agent-x',
      chatId: 'chat-1',
      checkpointId: CHECKPOINT_ID,
      version: 7,
    })
  })
})

type LifecycleGateStub = {
  isIntakeFenced: () => boolean
  noteIntakeActivity: ReturnType<typeof vi.fn<() => void>>
  noteFencedIntake: ReturnType<typeof vi.fn<() => void>>
}

async function startServer(gate?: LifecycleGateStub): Promise<{
  server: { stop(): Promise<void> }
  handler: ReturnType<typeof vi.fn<ModelStepContinuationHandler>>
  baseUrl: string
}> {
  process.env.CLERUM_ENABLE_AUTH = 'false'
  process.env.CLERUM_HOST_NAME = 'chatllm'
  vi.resetModules()
  const { RPCServer } = await import('../../server')
  const server = new RPCServer(0)
  const handler = vi.fn<ModelStepContinuationHandler>(async () => ({
    status: 202,
    body: CLAIMED_BODY,
  }))
  server.onModelStepContinuation(handler)
  if (gate) server.setLifecycleGate(gate)
  await server.start()
  const address = (server as unknown as { server: { address: () => AddressInfo } }).server.address()
  return { server, handler, baseUrl: `http://127.0.0.1:${address.port}` }
}

function continueUrl(baseUrl: string): string {
  return `${baseUrl}${MODEL_STEP_CONTINUE_RUNTIME_ROUTE.replace(':agent', 'agent-x')
    .replace(':chatId', 'chat-1')
    .replace(':checkpointId', CHECKPOINT_ID)}`
}

function rpcEdgeHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-clerum-edge-caller': 'rpc-proxy',
    'x-clerum-edge-host-ref': 'chatllm',
    'x-clerum-edge-user-id': 'user-1',
  }
}

describe('POST /v1/runtime/sessions/.../continue — DRAINING fence (#1043)', () => {
  it('answers 503 host_draining while fenced, without calling the handler, and resumes once the fence lifts', async () => {
    let fenced = true
    const gate: LifecycleGateStub = {
      isIntakeFenced: () => fenced,
      noteIntakeActivity: vi.fn(),
      noteFencedIntake: vi.fn(),
    }
    const { server, handler, baseUrl } = await startServer(gate)
    try {
      const rejected = await fetch(continueUrl(baseUrl), {
        method: 'POST',
        headers: rpcEdgeHeaders(),
        body: JSON.stringify({ version: 3 }),
      })
      expect(rejected.status).toBe(503)
      // rpc-proxy keys on this exact code; nothing else may leak.
      expect(await rejected.json()).toEqual({ code: 'host_draining' })
      expect(handler).not.toHaveBeenCalled()
      // Witness that the fence branch ran: it records the pending intake.
      expect(gate.noteFencedIntake).toHaveBeenCalledTimes(1)
      expect(gate.noteIntakeActivity).not.toHaveBeenCalled()

      // Reversible: the fence lifts and the same request reaches the handler.
      fenced = false
      const accepted = await fetch(continueUrl(baseUrl), {
        method: 'POST',
        headers: rpcEdgeHeaders(),
        body: JSON.stringify({ version: 3 }),
      })
      expect(accepted.status).toBe(202)
      expect(await accepted.json()).toEqual(CLAIMED_BODY)
      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler.mock.calls[0][0]).toEqual({
        userId: 'user-1',
        agent: 'agent-x',
        chatId: 'chat-1',
        checkpointId: CHECKPOINT_ID,
        version: 3,
      })
      // The accepted intake is the liveness witness for the fenced branch:
      // only the fenced call skipped it.
      expect(gate.noteIntakeActivity).toHaveBeenCalledTimes(1)
      expect(gate.noteFencedIntake).toHaveBeenCalledTimes(1)
    } finally {
      await server.stop()
    }
  })
})
