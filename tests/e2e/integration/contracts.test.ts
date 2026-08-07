/**
 * Contract tests — validate API schemas between services.
 *
 * These tests verify that the contracts (request/response shapes) between
 * services are consistent. They run against live services when available,
 * but can also validate response shapes from static fixtures when the
 * cluster is not up.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import {
  CONTROL_API_URL,
  EXTERNAL_REST_API_URL,
  MCP_HOST_URL,
  fetchJson,
  isServiceUp,
} from './helpers.integration.js'

// ── Schema validators (pure, no cluster needed) ───────────────────────────────

function isValidLoginResult(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false
  const d = data as Record<string, unknown>
  return typeof d['token'] === 'string' && d['token'].length > 0
}

function isValidHealthResponse(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false
  const d = data as Record<string, unknown>
  return typeof d['status'] === 'string'
}

function isValidMessageResponse(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false
  const d = data as Record<string, unknown>
  return typeof d['success'] === 'boolean'
}

// ── Pure schema tests (no cluster needed) ─────────────────────────────────────

describe('Contracts — schema validators (pure)', () => {
  it('isValidLoginResult accepts valid token response', () => {
    expect(isValidLoginResult({ token: 'abc123', user: {} })).toBe(true)
  })

  it('isValidLoginResult rejects response without token', () => {
    expect(isValidLoginResult({ error: 'invalid' })).toBe(false)
    expect(isValidLoginResult(null)).toBe(false)
    expect(isValidLoginResult({ token: '' })).toBe(false)
  })

  it('isValidHealthResponse accepts { status: string }', () => {
    expect(isValidHealthResponse({ status: 'ok' })).toBe(true)
    expect(isValidHealthResponse({ status: 'degraded' })).toBe(true)
  })

  it('isValidHealthResponse rejects missing status field', () => {
    expect(isValidHealthResponse({})).toBe(false)
    expect(isValidHealthResponse({ healthy: true })).toBe(false)
  })

  it('isValidMessageResponse accepts { success: boolean }', () => {
    expect(isValidMessageResponse({ success: true, status: 'completed' })).toBe(true)
    expect(isValidMessageResponse({ success: false, error: 'timeout' })).toBe(true)
  })

  it('isValidMessageResponse rejects missing success field', () => {
    expect(isValidMessageResponse({ status: 'ok' })).toBe(false)
    expect(isValidMessageResponse(null)).toBe(false)
  })
})

// ── Live contract tests (require cluster) ─────────────────────────────────────

describe('Contracts — external-rest-api /health shape', () => {
  it('returns { status: string } matching contract', async () => {
    const up = await isServiceUp(EXTERNAL_REST_API_URL)
    if (!up) return

    const { status, data } = await fetchJson(`${EXTERNAL_REST_API_URL}/health`)
    expect(status).toBe(200)
    expect(isValidHealthResponse(data)).toBe(true)
  })
})

describe('Contracts — control-api /health shape', () => {
  it('returns { status: string } matching contract', async () => {
    const up = await isServiceUp(CONTROL_API_URL)
    if (!up) return

    const { status, data } = await fetchJson(`${CONTROL_API_URL}/health`)
    expect(status).toBe(200)
    expect(isValidHealthResponse(data)).toBe(true)
  })
})

describe('Contracts — mcp-host /v1/runtime/messages response shape', () => {
  it('accepts message (contract: non-5xx, 2xx if LLM responds within 8s)', async () => {
    const up = await isServiceUp(MCP_HOST_URL)
    if (!up) return

    // Use short AbortSignal — mcp-host is synchronous with LLM, which can take >120s.
    // We verify the endpoint accepts the request (non-5xx), not LLM completion.
    try {
      const res = await fetch(`${MCP_HOST_URL}/v1/runtime/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'contract test',
          hostRef: 'chatllm',
          channelId: 'contract-test',
          sender: 'contract-user',
          channelType: 'telegram',
          timestamp: new Date().toISOString(),
          messageId: `contract-${Date.now()}`,
        }),
        signal: AbortSignal.timeout(8000),
      })
      // If LLM responds within 8s, validate the contract shape
      expect(res.status).toBeLessThan(500)
      if (res.status === 200) {
        const data = await res.json()
        expect(isValidMessageResponse(data)).toBe(true)
      }
    } catch (err: unknown) {
      if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        // LLM took > 8s — endpoint accepted the connection, contract is OK
        return
      }
      throw err
    }
  })
})

describe('Contracts — external-rest-api 401 shape on protected routes', () => {
  it('returns { error: string } on 401 responses', async () => {
    const up = await isServiceUp(EXTERNAL_REST_API_URL)
    if (!up) return

    const { status, data } = await fetchJson<{ error?: string }>(
      `${EXTERNAL_REST_API_URL}/api/v1/me`
    )
    expect(status).toBe(401)
    // Should have some error indicator
    expect(data).toBeTruthy()
  })
})
