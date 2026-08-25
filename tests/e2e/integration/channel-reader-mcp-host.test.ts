/**
 * Integration: rpc-proxy → mcp-host
 *
 * Validates the RPC forward path. Authenticated requests go through
 * rpc-proxy (mcp-host rejects direct Bearer auth). Health and
 * rejection tests hit mcp-host directly. The positive path asks for an
 * asynchronous acknowledgement and asserts the returned task identity.
 *
 * Requires: minikube cluster with port-forwards active (make minikube-pf-all)
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { issueRealRpcToken } from '../mcp-host/runtimeAuth.js'
import {
  EXTERNAL_REST_API_URL,
  MCP_HOST_URL,
  RPC_PROXY_URL,
  fetchJson,
} from './helpers.integration.js'
import { requireServiceUp, skipEachIfClusterDown } from './mcpRotation.helpers.js'

const HOST_REF = process.env.TEST_HOST_REF ?? 'chatllm'
const SUITE = 'rpc-proxy-mcp-host'

let mchUp = false
let runtimeAuthReady = false
let runtimeToken = ''

// Marks every test as vitest "skipped" (yellow) when mcp-host is unreachable,
// instead of the old `if (!mchUp) return` guards which silently PASSED tests
// with zero assertions. Tests that additionally need runtime auth call
// ctx.skip() in their body when runtimeAuthReady is false.
skipEachIfClusterDown(() => mchUp)

beforeAll(async () => {
  // Fail-loud by default; returns false only under E2E_SKIP_IF_CLUSTER_UNREACHABLE=1.
  mchUp = await requireServiceUp(SUITE, 'mcp-host', MCP_HOST_URL)
  if (!mchUp) return

  const externalUp = await requireServiceUp(SUITE, 'external-rest-api', EXTERNAL_REST_API_URL)
  const rpcProxyUp = await requireServiceUp(SUITE, 'rpc-proxy', RPC_PROXY_URL)
  if (!externalUp || !rpcProxyUp) return

  runtimeToken = await issueRealRpcToken(['host:message:invoke', 'host:status:read'], [HOST_REF])
  runtimeAuthReady = true
})

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    content: 'integration test ping',
    hostRef: HOST_REF,
    channelId: 'integration-test',
    sender: 'integration-test-user',
    channelType: 'telegram',
    timestamp: new Date().toISOString(),
    messageId: `int-${Date.now()}`,
    ...overrides,
  }
}

/**
 * Posts a message via rpc-proxy → mcp-host and requests an async acknowledgement.
 * mcp-host rejects direct Bearer auth; authenticated requests must go
 * through rpc-proxy which validates the RPC token and forwards.
 */
async function postMessageQuick(
  body: unknown,
  token = runtimeToken
): Promise<{ status: number; data: Record<string, unknown> }> {
  const url = `${RPC_PROXY_URL}/api/v1/rpc/hosts/${encodeURIComponent(HOST_REF)}/messages?async=true`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  const raw = await res.text()
  let data: Record<string, unknown> = {}
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        data = parsed as Record<string, unknown>
      }
    } catch {
      // A non-JSON response is rejected by the task-id assertion below.
    }
  }
  return { status: res.status, data }
}

// ── Health ────────────────────────────────────────────────────────────────────

describe('rpc-proxy → mcp-host: health', () => {
  it('/v1/runtime/health returns 200', async () => {
    const { status } = await fetchJson(`${MCP_HOST_URL}/v1/runtime/health`)
    expect(status).toBe(200)
  })
})

// ── Message endpoint acceptance ───────────────────────────────────────────────

describe('rpc-proxy → mcp-host: POST /v1/runtime/messages', () => {
  it('rejects a valid message without runtime auth', async () => {
    const res = await fetch(`${MCP_HOST_URL}/v1/runtime/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeMessage()),
      signal: AbortSignal.timeout(5000),
    })
    expect(res.status).toBe(401)
  })

  it('returns an async task acknowledgement for a valid message', async ctx => {
    if (!runtimeAuthReady) ctx.skip()

    const { status, data } = await postMessageQuick(makeMessage())
    expect(status).toBe(200)
    expect(typeof data.taskId).toBe('string')
    expect(String(data.taskId)).not.toHaveLength(0)
  })

  it('returns 400 immediately for a message with invalid JSON body', async () => {
    const res = await fetch(`${MCP_HOST_URL}/v1/runtime/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ invalid json',
      signal: AbortSignal.timeout(5000),
    })
    expect(res.status).toBe(400)
  })

  it('returns an async task acknowledgement when optional fields are omitted', async ctx => {
    if (!runtimeAuthReady) ctx.skip()

    const { status, data } = await postMessageQuick({
      content: 'minimal message',
      hostRef: HOST_REF,
      channelId: 'test',
      sender: 'test-user',
      channelType: 'telegram',
      timestamp: new Date().toISOString(),
      messageId: `int-minimal-${Date.now()}`,
    })
    expect(status).toBe(200)
    expect(typeof data.taskId).toBe('string')
    expect(String(data.taskId)).not.toHaveLength(0)
  })
})

// ── Status endpoint ───────────────────────────────────────────────────────────

describe('rpc-proxy → mcp-host: GET /v1/runtime/status', () => {
  it('rejects status without runtime auth', async () => {
    const { status } = await fetchJson<Record<string, unknown>>(`${MCP_HOST_URL}/v1/runtime/status`)
    expect(status).toBe(401)
  })

  it('returns 200 with a non-empty status object via rpc-proxy', async ctx => {
    if (!runtimeAuthReady) ctx.skip()

    const url = `${RPC_PROXY_URL}/api/v1/rpc/hosts/${encodeURIComponent(HOST_REF)}/status`
    const { status, data } = await fetchJson<Record<string, unknown>>(url, {
      headers: { Authorization: `Bearer ${runtimeToken}` },
    })
    expect(status).toBe(200)
    expect(Object.keys(data).length).toBeGreaterThan(0)
  })
})
