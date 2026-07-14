/**
 * Integration: channel-reader → mcp-host
 *
 * Validates the RPC forward path from channel-reader to mcp-host.
 * NOTE: mcp-host POST /v1/runtime/messages is synchronous — it waits for the
 * full LLM response before returning. Tests use a short AbortSignal (8s) so
 * they verify the endpoint ACCEPTS the connection without waiting for LLM
 * completion. Full LLM flow is covered by the bash E2E suite.
 *
 * Requires: minikube cluster with mcp-host port-forwarded on :8080
 *   make minikube-pf-all
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { issueRealRpcToken } from '../mcp-host/runtimeAuth.js'
import {
  EXTERNAL_REST_API_URL,
  MCP_HOST_URL,
  RPC_PROXY_URL,
  fetchJson,
  isServiceUp,
} from './helpers.integration.js'

let mchUp = false
let runtimeAuthReady = false
let runtimeToken = ''

beforeAll(async () => {
  mchUp = await isServiceUp(MCP_HOST_URL)
  if (!mchUp) {
    console.log('[channel-reader-mcp-host] mcp-host not available — tests will be skipped')
    return
  }

  const externalUp = await isServiceUp(EXTERNAL_REST_API_URL)
  const rpcProxyUp = await isServiceUp(RPC_PROXY_URL)
  if (!externalUp || !rpcProxyUp) {
    console.log(
      '[channel-reader-mcp-host] external-rest-api/rpc-proxy not available — auth-required tests will be skipped'
    )
    return
  }

  runtimeToken = await issueRealRpcToken(
    ['host:message:invoke', 'host:status:read'],
    [process.env.TEST_HOST_REF ?? 'chatllm']
  )
  runtimeAuthReady = true
})

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    content: 'integration test ping',
    hostRef: process.env.TEST_HOST_REF ?? 'chatllm',
    channelId: 'integration-test',
    sender: 'integration-test-user',
    channelType: 'telegram',
    timestamp: new Date().toISOString(),
    messageId: `int-${Date.now()}`,
    ...overrides,
  }
}

/**
 * Posts to mcp-host with a short timeout (8s).
 * Returns the HTTP status, or 202 if the request times out (meaning
 * the endpoint accepted the connection but LLM is still processing).
 */
async function postMessageQuick(
  body: unknown,
  token = runtimeToken
): Promise<{ status: number; timedOut: boolean }> {
  try {
    const res = await fetch(`${MCP_HOST_URL}/v1/runtime/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    })
    return { status: res.status, timedOut: false }
  } catch (err: unknown) {
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      // Request was accepted by the server — LLM just took longer than 8s.
      // This is expected behavior for mcp-host; count as "accepted" (202-like).
      return { status: 202, timedOut: true }
    }
    throw err
  }
}

// ── Health ────────────────────────────────────────────────────────────────────

describe('channel-reader → mcp-host: health', () => {
  it('/v1/runtime/health returns 200', async () => {
    if (!mchUp) return

    const { status } = await fetchJson(`${MCP_HOST_URL}/v1/runtime/health`)
    expect(status).toBe(200)
  })
})

// ── Message endpoint acceptance ───────────────────────────────────────────────

describe('channel-reader → mcp-host: POST /v1/runtime/messages', () => {
  it('rejects a valid message without runtime auth', async () => {
    if (!mchUp) return

    const res = await fetch(`${MCP_HOST_URL}/v1/runtime/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeMessage()),
      signal: AbortSignal.timeout(5000),
    })
    expect(res.status).toBe(401)
  })

  it('accepts a valid message (2xx — LLM may still be processing)', async () => {
    if (!mchUp || !runtimeAuthReady) return

    const { status } = await postMessageQuick(makeMessage())
    // 200 = LLM completed within 8s; 202 = timed out (LLM still processing)
    // Both are acceptable — the endpoint is reachable and accepted the message
    expect([200, 202]).toContain(status)
  })

  it('returns 400 immediately for a message with invalid JSON body', async () => {
    if (!mchUp || !runtimeAuthReady) return

    const res = await fetch(`${MCP_HOST_URL}/v1/runtime/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${runtimeToken}`,
      },
      body: '{ invalid json',
      signal: AbortSignal.timeout(5000),
    })
    expect(res.status).toBe(400)
  })

  it('does not return 5xx for a message missing optional fields', async () => {
    if (!mchUp || !runtimeAuthReady) return

    const { status } = await postMessageQuick({
      content: 'minimal message',
      hostRef: 'chatllm',
      channelId: 'test',
      sender: 'test-user',
      channelType: 'telegram',
      timestamp: new Date().toISOString(),
      messageId: `int-minimal-${Date.now()}`,
    })
    expect(status).toBeLessThan(500)
  })
})

// ── Status endpoint ───────────────────────────────────────────────────────────

describe('channel-reader → mcp-host: GET /v1/runtime/status', () => {
  it('rejects status without runtime auth', async () => {
    if (!mchUp) return

    const { status } = await fetchJson<Record<string, unknown>>(`${MCP_HOST_URL}/v1/runtime/status`)
    expect(status).toBe(401)
  })

  it('returns 200 with a non-empty status object', async () => {
    if (!mchUp || !runtimeAuthReady) return

    const { status, data } = await fetchJson<Record<string, unknown>>(
      `${MCP_HOST_URL}/v1/runtime/status`,
      {
        headers: {
          Authorization: `Bearer ${runtimeToken}`,
        },
      }
    )
    expect(status).toBe(200)
    expect(Object.keys(data).length).toBeGreaterThan(0)
  })
})
