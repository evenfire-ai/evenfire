import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { ReaderConfig } from '../src/config.js'

/**
 * The reader's decision and enrollment calls against a real MCP Host whose
 * direct service admission bucket is full: the 429 the client reads is the
 * one the Host produces, not a hand-built answer.
 */

const runtimeTestEnvironmentKeys = [
  'CLERUM_ENABLE_AUTH',
  'CLERUM_HOST_NAME',
  'CLERUM_DEV_MODE',
  'CLERUM_HOST_REF',
  'LOG_LEVEL',
  'MCP_HOST_RPC_PROXY_EDGE_TOKEN',
  'RPC_PROXY_MCP_HOST_EDGE_TOKEN',
] as const

const APPROVAL_REQUEST_ID = '99999999-8888-7777-6666-555555555555'

let environmentBefore: Map<string, string | undefined> | undefined

afterEach(() => {
  vi.restoreAllMocks()
  if (!environmentBefore) return
  for (const [key, value] of environmentBefore) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  environmentBefore = undefined
})

type Admission = { admit: () => { allowed: boolean; retryAfterSeconds?: number } }

async function bootHost() {
  environmentBefore = new Map(runtimeTestEnvironmentKeys.map(key => [key, process.env[key]]))
  process.env.CLERUM_ENABLE_AUTH = 'false'
  process.env.CLERUM_HOST_NAME = 'chatllm'
  process.env.CLERUM_DEV_MODE = 'true'
  process.env.CLERUM_HOST_REF = 'chatllm'
  process.env.LOG_LEVEL = 'silent'
  process.env.MCP_HOST_RPC_PROXY_EDGE_TOKEN = 'dev-rpc-proxy-mcp-host-edge-token'
  process.env.RPC_PROXY_MCP_HOST_EDGE_TOKEN = 'dev-rpc-proxy-mcp-host-edge-token'
  vi.resetModules()

  const { RPCServer } = await import('../../mcp-host/src/server')
  const server = new RPCServer(0)
  const handlers = {
    decision: vi.fn(async () => ({ success: true, duplicate: false })),
    enrollment: vi.fn(async () => ({ ok: true })),
  }
  server.onProviderWorkflowApprovalDecision(handlers.decision)
  server.onWorkflowApprovalMediumEnrollment(handlers.enrollment)
  await server.start()
  const address = (server as unknown as { server: { address(): AddressInfo } }).server.address()
  const admission = (server as unknown as { directServiceAdmission: Admission })
    .directServiceAdmission
  return { server, handlers, admission, baseUrl: `http://127.0.0.1:${address.port}` }
}

function readerConfig(baseUrl: string): ReaderConfig {
  return {
    port: 0,
    mcpHostBaseUrl: baseUrl,
    mcpHostRef: 'chatllm',
    mcpHostTargets: [{ hostRef: 'chatllm', baseUrl }],
    enabledMedia: new Set(['slack']),
    mcpHostTimeoutMs: 5_000,
    mcpHostMessageTimeoutMs: 5_000,
    rateLimitWindowMs: 60_000,
    rateLimitMaxRequests: 120,
    controlApiBaseUrl: '',
    controlApiToken: '',
    controlApiTimeoutMs: 5_000,
    channelReaderUrlTemplate: '',
    channelReaderHandoffToken: '',
    channelReaderHandoffTimeoutMs: 5_000,
  }
}

const decisionCommand = {
  approvalRequestId: APPROVAL_REQUEST_ID,
  mcpHostRef: 'chatllm',
  medium: 'slack' as const,
  providerUserId: 'U123',
  providerWorkspaceId: 'T123',
  providerChannelId: 'C123',
  providerEventId: 'slack:T123:C123:event-limited',
  decision: 'approve' as const,
}

const enrollmentCommand = {
  nonce: '123456',
  medium: 'slack' as const,
  mcpHostRef: 'chatllm',
  communicationChannelRef: 'channels/slack-channel',
  providerUserId: 'U123',
  providerWorkspaceId: 'T123',
  providerChannelId: 'C123',
}

describe('reader calls against a real MCP Host admission limit', () => {
  it('reads the Host admission refusal and its wait on the decision and enrollment routes', async () => {
    const host = await bootHost()
    const { submitMcpHostDecision, submitMcpHostEnrollment } = await import(
      '../src/mcpHostClient.js'
    )
    const cfg = readerConfig(host.baseUrl)
    const admissionClock = vi.spyOn(Date, 'now').mockReturnValue(120_001)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      for (let index = 0; index < 600; index += 1) {
        expect(host.admission.admit()).toEqual({ allowed: true })
      }
      // Witness that the bucket is really full.
      expect(host.admission.admit()).toMatchObject({ allowed: false })

      const decision = await submitMcpHostDecision(cfg, decisionCommand)
      const enrollment = await submitMcpHostEnrollment(cfg, enrollmentCommand)

      for (const limited of [decision, enrollment]) {
        expect(limited).toEqual({
          ok: false,
          status: 429,
          error: 'runtime_service_admission_limited',
          retryAfterSeconds: expect.any(Number),
        })
        expect(limited.retryAfterSeconds).toBeGreaterThanOrEqual(1)
        expect(limited.retryAfterSeconds).toBeLessThanOrEqual(60)
      }
      expect(host.handlers.decision).not.toHaveBeenCalled()
      expect(host.handlers.enrollment).not.toHaveBeenCalled()

      // Witness: the same calls reach the handlers once the window rolls over.
      admissionClock.mockReturnValue(180_000)
      await expect(submitMcpHostDecision(cfg, decisionCommand)).resolves.toEqual({
        ok: true,
        duplicate: false,
      })
      await expect(submitMcpHostEnrollment(cfg, enrollmentCommand)).resolves.toMatchObject({
        ok: true,
      })
      expect(host.handlers.decision).toHaveBeenCalledOnce()
      expect(host.handlers.enrollment).toHaveBeenCalledOnce()
    } finally {
      admissionClock.mockRestore()
      await host.server.stop()
    }
  }, 60_000)
})
