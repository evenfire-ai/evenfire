import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ApiError } from '../src/httpClient.js'
import { RpcProxyClient } from '../src/rpcProxyClient.js'

vi.mock('../src/config.js', () => ({
  config: {
    rpcProxyBaseUrl: 'http://localhost:8094',
    requestTimeoutMs: 5000,
  },
}))

/**
 * #1044 — the Desktop main-process reader of the model-step checkpoint wire
 * contract, driven by the C0 contract fixtures (`tests/fixtures/model-step-checkpoint`).
 */

const FIXTURES = resolve(__dirname, '../../tests/fixtures/model-step-checkpoint')
const CHECKPOINT_ID = 'msc_01J9Z7Q4R2M3N5P6Q7R8S9T0V1'
const CONTINUE_URL =
  'http://localhost:8094/api/v1/rpc/hosts/chatllm/sessions/chatllm/c1/model-step-checkpoints/msc_01J9Z7Q4R2M3N5P6Q7R8S9T0V1/continue'

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf8'))
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function continueFixtureResponse(name: string): Response {
  const { httpStatus, body } = fixture(name) as { httpStatus: number; body: unknown }
  return jsonResponse(httpStatus, body)
}

let client: RpcProxyClient
let fetchSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  client = new RpcProxyClient()
  fetchSpy = vi.fn()
  vi.stubGlobal('fetch', fetchSpy)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function continueStep(version = 1) {
  return client.continueModelStep('rpc-token', 'chatllm', 'chatllm', 'c1', CHECKPOINT_ID, version)
}

describe('RpcProxyClient — continueModelStep() (#1044)', () => {
  it('POSTs the version to the continue route with the bearer token', async () => {
    fetchSpy.mockResolvedValueOnce(continueFixtureResponse('continue-response.claimed.json'))

    await continueStep(1)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [requestUrl, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(requestUrl).toBe(CONTINUE_URL)
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({
      authorization: 'Bearer rpc-token',
      'content-type': 'application/json',
    })
    expect(JSON.parse(String(init.body))).toEqual({ version: 1 })
  })

  it.each([
    [
      'continue-response.claimed.json',
      'claimed',
      202,
      '3c1e9b7a-0f2d-4a6b-8c5e-1d7f9a3b2c40',
      false,
    ],
    [
      'continue-response.replayed.json',
      'claimed',
      202,
      '3c1e9b7a-0f2d-4a6b-8c5e-1d7f9a3b2c40',
      true,
    ],
    [
      'continue-response.reclaimed.json',
      'claimed',
      202,
      'b5a4c3d2-e1f0-4a9b-8c7d-6e5f4a3b2c10',
      false,
    ],
    [
      'continue-response.completed.json',
      'completed',
      200,
      '3c1e9b7a-0f2d-4a6b-8c5e-1d7f9a3b2c40',
      true,
    ],
  ] as const)('maps %s to the %s row', async (name, outcome, httpStatus, taskId, replayed) => {
    fetchSpy.mockResolvedValueOnce(continueFixtureResponse(name))

    const result = await continueStep()

    expect(result).toEqual({
      outcome,
      httpStatus,
      body: { taskId, checkpointId: CHECKPOINT_ID, status: outcome, replayed },
    })
  })

  it('maps 404 model_step_checkpoint_not_found to not_found', async () => {
    fetchSpy.mockResolvedValueOnce(continueFixtureResponse('continue-response.not-found.json'))

    await expect(continueStep()).resolves.toEqual({
      outcome: 'not_found',
      httpStatus: 404,
      body: { code: 'model_step_checkpoint_not_found' },
    })
  })

  it('maps 409 version mismatch to the current view the Host reported', async () => {
    fetchSpy.mockResolvedValueOnce(
      continueFixtureResponse('continue-response.version-mismatch.json')
    )

    const result = await continueStep()

    expect(result.outcome).toBe('version_mismatch')
    if (result.outcome !== 'version_mismatch') throw new Error('unreachable')
    expect(result.body.current).toMatchObject({
      checkpointId: CHECKPOINT_ID,
      version: 3,
      status: 'resumable',
      retryAvailable: true,
      tools: { confirmed: 21, unknown: 0, notDispatched: 0 },
    })
  })

  it('maps 409 blocked to its reason', async () => {
    fetchSpy.mockResolvedValueOnce(continueFixtureResponse('continue-response.blocked.json'))

    await expect(continueStep()).resolves.toEqual({
      outcome: 'blocked',
      httpStatus: 409,
      body: { code: 'model_step_checkpoint_blocked', blockedReason: 'budget_exhausted' },
    })
  })

  it('throws an ApiError carrying the status for 503 host_draining', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(503, { code: 'host_draining' }))

    const error = await continueStep().catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(503)
    expect((error as ApiError).message).toContain('Continue model step failed (503)')
  })

  it('rejects a success answer for a different checkpoint', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(202, {
        taskId: '3c1e9b7a-0f2d-4a6b-8c5e-1d7f9a3b2c40',
        checkpointId: 'msc_other',
        status: 'claimed',
        replayed: false,
      })
    )

    await expect(continueStep()).rejects.toThrow(
      'Invalid model step continue response.checkpointId'
    )
  })

  it('rejects an invalid version before any request', async () => {
    await expect(continueStep(-1)).rejects.toThrow('version must be a non-negative integer')
    // Witness: the same client issues the request for a valid version.
    fetchSpy.mockResolvedValueOnce(continueFixtureResponse('continue-response.claimed.json'))
    await continueStep(0)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

describe('RpcProxyClient — loadSessionMessages() modelStepCheckpoint (#1044)', () => {
  const session = (checkpoint?: unknown) => ({
    agent: 'chatllm',
    chatId: 'c1',
    turns: [],
    ...(checkpoint !== undefined ? { modelStepCheckpoint: checkpoint } : {}),
  })

  it.each([
    ['session-view.resumable.json', 'resumable', true],
    ['session-view.claimed.json', 'claimed', false],
    ['session-view.blocked.json', 'blocked', false],
  ] as const)('reads %s as a %s view', async (name, status, retryAvailable) => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, session(fixture(name))))

    const result = await client.loadSessionMessages('rpc-token', 'chatllm', 'chatllm', 'c1')

    expect(result.modelStepCheckpoint).toEqual(fixture(name))
    expect(result.modelStepCheckpoint?.status).toBe(status)
    expect(result.modelStepCheckpoint?.retryAvailable).toBe(retryAvailable)
  })

  it('leaves the field absent when the Host sends none', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, session()))

    const result = await client.loadSessionMessages('rpc-token', 'chatllm', 'chatllm', 'c1')

    // Witness: the session itself was read.
    expect(result.chatId).toBe('c1')
    expect('modelStepCheckpoint' in result).toBe(false)
  })

  it('rejects a view whose retryAvailable disagrees with its status', async () => {
    const view = { ...(fixture('session-view.blocked.json') as object), retryAvailable: true }
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, session(view)))

    await expect(
      client.loadSessionMessages('rpc-token', 'chatllm', 'chatllm', 'c1')
    ).rejects.toThrow('Invalid session messages response.modelStepCheckpoint.retryAvailable')
  })

  it('rejects a claimed view without its continuation task', async () => {
    const { continuationTaskId: _dropped, ...view } = fixture('session-view.claimed.json') as {
      continuationTaskId: string
    }
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, session(view)))

    await expect(
      client.loadSessionMessages('rpc-token', 'chatllm', 'chatllm', 'c1')
    ).rejects.toThrow('Invalid session messages response.modelStepCheckpoint.continuationTaskId')
  })
})
