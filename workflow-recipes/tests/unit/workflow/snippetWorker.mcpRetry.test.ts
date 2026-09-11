import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { SnippetExecuteRequest } from '../../../src/workflow/snippetTypes'

let connectAttempts = 0
let transportIds = 0
let connectFailuresBeforeSuccess = 1
let connectHangs = false
const callToolCalls: unknown[][] = []
const callToolFailures: unknown[] = []
const connectedTransportIds: number[] = []

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class MockStreamableHTTPClientTransport {
    readonly id = ++transportIds
    started = false
    constructor(readonly url: URL) {}
  },
}))

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: class MockSSEClientTransport {
    readonly id = ++transportIds
    started = false
    constructor(readonly url: URL) {}
  },
}))

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class MockClient {
    async connect(transport: { id: number; started: boolean }) {
      if (transport.started) {
        throw new Error('StreamableHTTPClientTransport already started')
      }
      transport.started = true
      connectedTransportIds.push(transport.id)
      connectAttempts += 1
      if (connectHangs) {
        return new Promise(() => undefined)
      }
      if (connectAttempts <= connectFailuresBeforeSuccess) {
        throw new Error('mcp server not ready yet')
      }
    }

    async callTool(...args: unknown[]) {
      callToolCalls.push(args)
      const failure = callToolFailures.shift()
      if (failure) throw failure
      return { content: [{ type: 'text', text: 'ok' }] }
    }

    async close() {}
  },
}))

beforeEach(() => {
  connectAttempts = 0
  transportIds = 0
  connectFailuresBeforeSuccess = 1
  connectHangs = false
  callToolCalls.length = 0
  callToolFailures.length = 0
  connectedTransportIds.length = 0
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe.sequential('snippet worker MCP retry', () => {
  it('creates a fresh MCP client transport for each retry attempt', async () => {
    const { executeSnippetPayload } = await import('../../../src/workflow/snippetWorker')
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snippet-mcp-retry-'))
    try {
      const request: SnippetExecuteRequest = {
        workflowName: 'wf',
        stepId: 'call-mcp',
        run: {
          type: 'snippet',
          language: 'typescript',
          code: 'return await sdk.mcp.callTool("mock-tools", "add", { a: 1, b: 2 })',
          capabilities: {
            mcp: {
              servers: ['mock-tools'],
              allowedTools: { include: ['mock-tools__add'] },
            },
          },
        },
        previousOutputs: {},
        resolvedWorkloads: [],
        resolvedMcpServers: [
          {
            id: 'mock-tools',
            url: 'http://mock-tools.mcp-server:3000/mcp',
            transport: 'streamableHttp',
          },
        ],
      }

      const startedAt = Date.now()
      const result = await executeSnippetPayload({
        request,
        outputDir,
        timeoutMs: 10_000,
        env: {},
      })

      expect(Date.now() - startedAt).toBeLessThan(2_500)
      expect(result.status).toBe('completed')
      expect(result.output).toEqual({ content: [{ type: 'text', text: 'ok' }] })
      expect(connectAttempts).toBe(2)
      expect(connectedTransportIds).toEqual([1, 2])
      expect(callToolCalls).toHaveLength(1)
      expect(callToolCalls[0][2]).toEqual(
        expect.objectContaining({
          timeout: expect.any(Number),
        })
      )
      expect((callToolCalls[0][2] as { timeout: number }).timeout).toBeLessThanOrEqual(10_000)
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it('does not retry completed MCP tool validation failures', async () => {
    connectFailuresBeforeSuccess = 0
    callToolFailures.push(Object.assign(new Error('validation failed'), { code: -32602 }))
    const { executeSnippetPayload } = await import('../../../src/workflow/snippetWorker')
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snippet-mcp-no-retry-'))
    try {
      const request: SnippetExecuteRequest = {
        workflowName: 'wf',
        stepId: 'call-mcp',
        run: {
          type: 'snippet',
          language: 'typescript',
          code: 'return await sdk.mcp.callTool("mock-tools", "add", { a: 1, b: 2 })',
          capabilities: {
            mcp: {
              servers: ['mock-tools'],
              allowedTools: { include: ['mock-tools__add'] },
            },
          },
        },
        previousOutputs: {},
        timeoutSeconds: 5,
        resolvedWorkloads: [],
        resolvedMcpServers: [
          {
            id: 'mock-tools',
            url: 'http://mock-tools.mcp-server:3000/mcp',
            transport: 'streamableHttp',
          },
        ],
      }

      await expect(
        executeSnippetPayload({
          request,
          outputDir,
          timeoutMs: 5_000,
          env: {},
        })
      ).rejects.toThrow('validation failed')

      expect(connectAttempts).toBe(1)
      expect(transportIds).toBe(1)
      expect(callToolCalls).toHaveLength(1)
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it('fails invalid MCP server URLs without retrying transport setup', async () => {
    const { executeSnippetPayload } = await import('../../../src/workflow/snippetWorker')
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snippet-mcp-invalid-url-'))
    try {
      const request: SnippetExecuteRequest = {
        workflowName: 'wf',
        stepId: 'call-mcp',
        run: {
          type: 'snippet',
          language: 'typescript',
          code: 'return await sdk.mcp.callTool("mock-tools", "add", { a: 1, b: 2 })',
          capabilities: {
            mcp: {
              servers: ['mock-tools'],
              allowedTools: { include: ['mock-tools__add'] },
            },
          },
        },
        previousOutputs: {},
        resolvedWorkloads: [],
        resolvedMcpServers: [
          {
            id: 'mock-tools',
            url: 'not a url',
            transport: 'streamableHttp',
          },
        ],
      }

      const startedAt = Date.now()
      await expect(
        executeSnippetPayload({
          request,
          outputDir,
          timeoutMs: 10_000,
          env: {},
        })
      ).rejects.toThrow('Invalid URL')

      expect(Date.now() - startedAt).toBeLessThan(500)
      expect(transportIds).toBe(0)
      expect(connectAttempts).toBe(0)
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it('bounds a hung MCP connect by the remaining snippet budget', async () => {
    connectFailuresBeforeSuccess = 0
    connectHangs = true
    const { executeSnippetPayload } = await import('../../../src/workflow/snippetWorker')
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snippet-mcp-connect-timeout-'))
    vi.useFakeTimers()
    try {
      const request: SnippetExecuteRequest = {
        workflowName: 'wf',
        stepId: 'call-mcp',
        run: {
          type: 'snippet',
          language: 'typescript',
          code: 'return await sdk.mcp.callTool("mock-tools", "add", { a: 1, b: 2 })',
          capabilities: {
            mcp: {
              servers: ['mock-tools'],
              allowedTools: { include: ['mock-tools__add'] },
            },
          },
        },
        previousOutputs: {},
        resolvedWorkloads: [],
        resolvedMcpServers: [
          {
            id: 'mock-tools',
            url: 'http://mock-tools.mcp-server:3000/mcp',
            transport: 'streamableHttp',
          },
        ],
      }

      const pending = executeSnippetPayload({
        request,
        outputDir,
        timeoutMs: 500,
        env: {},
      })
      const assertion = expect(pending).rejects.toThrow('snippet MCP connect timeout')
      await vi.advanceTimersByTimeAsync(500)

      await assertion
      expect(connectAttempts).toBe(1)
      expect(callToolCalls).toHaveLength(0)
    } finally {
      vi.useRealTimers()
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })
})
