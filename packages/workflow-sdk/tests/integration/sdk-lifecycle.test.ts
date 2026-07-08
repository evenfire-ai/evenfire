import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { McpHostNotConfiguredError } from '../../src/errors'
import { WorkflowSDK } from '../../src/index'

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
  process.env.WRC_TOKEN_FILE = await writeTokenFile('test-token')
  process.env.CLERUM_SIGNAL_POLL_INTERVAL_MS = '60000'
}

function clearEnv() {
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

  it('fromEnvironment() throws when required env missing', async () => {
    // No env vars set
    await expect(WorkflowSDK.fromEnvironment()).rejects.toThrow('CLERUM_WORKFLOW_NAME')
  })
})
