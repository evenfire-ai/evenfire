import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { McpHostNotConfiguredError } from '../../src/errors'
import type { Signal } from '../../src/index'
import { WorkflowSDK } from '../../src/index'

const WRC_TOKEN = 'test-token'
const LOOPBACK_HOST = '127.0.0.1'

async function writeTokenFile(token: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-sdk-lifecycle-'))
  const file = path.join(dir, 'token')
  await fs.writeFile(file, token, 'utf8')
  return file
}

async function setRequiredEnv() {
  process.env.CLERUM_WORKFLOW_NAME = 'integration-wf'
  process.env.CLERUM_NAMESPACE = 'sandbox-recipes'
  process.env.CLERUM_WRC_URL = 'http://wrc:8082'
  process.env.WRC_TOKEN_FILE = await writeTokenFile(WRC_TOKEN)
  process.env.CLERUM_SIGNAL_POLL_INTERVAL_MS = '60000'
}

async function freePort(): Promise<number> {
  const probe = net.createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, LOOPBACK_HOST, () => resolve())
  })
  const address = probe.address()
  if (address === null || typeof address === 'string') {
    throw new Error('expected a TCP address from the port probe')
  }
  await new Promise<void>((resolve, reject) => probe.close(err => (err ? reject(err) : resolve())))
  return address.port
}

// fetch is stubbed for the WRC calls, so the local REST server is reached
// with node:http.
function getStatus(port: number, token?: string): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: LOOPBACK_HOST, port, path: '/status', method: 'GET', headers },
      res => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => (data += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }))
      }
    )
    req.on('error', reject)
    req.end()
  })
}

function clearEnv() {
  delete process.env.CLERUM_WORKFLOW_RUN_ID
  delete process.env.CLERUM_SDK_REST_PORT
  delete process.env.CLERUM_WORKFLOW_NAME
  delete process.env.CLERUM_NAMESPACE
  delete process.env.CLERUM_WRC_URL
  delete process.env.WRC_TOKEN_FILE
  delete process.env.CLERUM_MCPHOST_URL
  delete process.env.MCP_HOST_TOKEN_FILE
  delete process.env.CLERUM_SIGNAL_POLL_INTERVAL_MS
  delete process.env.CLERUM_CORRELATION_ID
}

describe('WorkflowSDK lifecycle', () => {
  beforeEach(() => {
    clearEnv()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [],
      })
    )
  })

  afterEach(async () => {
    clearEnv()
    vi.unstubAllGlobals()
  })

  it('fromEnvironment() initializes with required env vars', async () => {
    await setRequiredEnv()
    const sdk = await WorkflowSDK.fromEnvironment()
    expect(sdk.config).toBeDefined()
    expect(sdk.signals).toBeDefined()
    expect(sdk.coordinator).toBeDefined()
    expect(sdk.status).toBeDefined()
    expect(sdk.mcpHost).toBeNull()
    await sdk.shutdown()
  })

  it('fromEnvironment() initializes mcpHost when optional vars present', async () => {
    await setRequiredEnv()
    process.env.CLERUM_MCPHOST_URL = 'http://mcp:8080'
    process.env.MCP_HOST_TOKEN_FILE = await writeTokenFile('mcp-tok')
    const sdk = await WorkflowSDK.fromEnvironment()
    expect(sdk.mcpHost).not.toBeNull()
    await sdk.shutdown()
  })

  it('requireMcpHost() throws when not configured', async () => {
    await setRequiredEnv()
    const sdk = await WorkflowSDK.fromEnvironment()
    expect(() => sdk.requireMcpHost()).toThrow(McpHostNotConfiguredError)
    await sdk.shutdown()
  })

  it('requireMcpHost() returns client when configured', async () => {
    await setRequiredEnv()
    process.env.CLERUM_MCPHOST_URL = 'http://mcp:8080'
    process.env.MCP_HOST_TOKEN_FILE = await writeTokenFile('mcp-tok')
    const sdk = await WorkflowSDK.fromEnvironment()
    expect(sdk.requireMcpHost()).toBeDefined()
    await sdk.shutdown()
  })

  it('updatePhase() updates internal state', async () => {
    await setRequiredEnv()
    const sdk = await WorkflowSDK.fromEnvironment()
    sdk.updatePhase('running')
    // Verify through rest server
    await sdk.shutdown()
  })

  it('shutdown() stops signal poller and server', async () => {
    await setRequiredEnv()
    const sdk = await WorkflowSDK.fromEnvironment()
    await sdk.shutdown()
    // Should not throw on double shutdown
    await sdk.shutdown()
  })

  it('fromEnvironment accepts only the cancel of its run', async () => {
    const runId = '7c0f6a52-3c1e-4d8a-9b6f-2a1e5d4c3b20'
    const otherRunId = '0b9e8d7c-6a5f-4e3d-8c2b-1a0f9e8d7c6b'
    await setRequiredEnv()
    process.env.CLERUM_WORKFLOW_RUN_ID = runId
    // ConfigLoader requires the correlation id to equal the run id.
    process.env.CLERUM_CORRELATION_ID = runId
    process.env.CLERUM_SDK_REST_PORT = String(await freePort())
    const foreignCancel: Signal = {
      type: 'cancel',
      requestId: `cancel:${otherRunId}`,
      receivedAt: new Date().toISOString(),
    }
    const ownCancel: Signal = {
      type: 'cancel',
      requestId: `cancel:${runId}`,
      receivedAt: new Date().toISOString(),
    }
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ signals: [foreignCancel, ownCancel] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const sdk = await WorkflowSDK.fromEnvironment()
    try {
      const received: Signal[] = []
      sdk.signals.pollSignals(signal => {
        received.push(signal)
      })
      // Wait for the poll to fetch, then let it finish reading the response.
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      await new Promise(resolve => setTimeout(resolve, 20))

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock.mock.calls[0][0]).toBe(
        `${process.env.CLERUM_WRC_URL}/api/v1/workflow/integration-wf/signals`
      )
      // Witness: the own cancel of the same response was accepted.
      expect(received).toEqual([ownCancel])
      expect(sdk.signals.hasSignal('cancel')).toBe(true)
      expect(sdk.signals.getSignals().map(s => s.requestId)).toEqual([`cancel:${runId}`])
    } finally {
      await sdk.shutdown()
    }
  })

  it('fromEnvironment guards /status with the WRC token', async () => {
    await setRequiredEnv()
    const port = await freePort()
    process.env.CLERUM_SDK_REST_PORT = String(port)

    const sdk = await WorkflowSDK.fromEnvironment()
    try {
      const anonymous = await getStatus(port)
      expect(anonymous).toEqual({ status: 401, body: { error: 'Unauthorized' } })

      const wrongToken = await getStatus(port, `${WRC_TOKEN}-other`)
      expect(wrongToken.status).toBe(401)

      // Witness: the same server serves /status with the WRC token.
      const authorized = await getStatus(port, WRC_TOKEN)
      expect(authorized).toEqual({
        status: 200,
        body: { workflowName: 'integration-wf', phase: 'pending', steps: {} },
      })
    } finally {
      await sdk.shutdown()
    }
  })

  it('fromEnvironment() throws when required env missing', async () => {
    // No env vars set
    await expect(WorkflowSDK.fromEnvironment()).rejects.toThrow('CLERUM_WORKFLOW_NAME')
  })
})
