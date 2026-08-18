import { afterEach, describe, expect, it } from 'vitest'
import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { findSdkSandboxUiFailureMarker } from './e2e-playwright/sdk-client-notification/sdkWorkloadFixture'

const REPO_ROOT = path.resolve(__dirname, '../..')
const FIXTURE_ENTRY = path.join(
  REPO_ROOT,
  'tests/e2e/fixtures/workflow-plugin-sdk-e2e/src/index.js'
)

type RunningFixture = {
  logs: () => string
  stop: () => Promise<void>
  url: string
}

const fixtures: RunningFixture[] = []

async function freePort(): Promise<number> {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as net.AddressInfo
  server.close()
  return address.port
}

async function listen(
  handler: http.RequestListener
): Promise<{ close: () => Promise<void>; url: string }> {
  const server = http.createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as net.AddressInfo
  return {
    close: async () => {
      server.close()
      await once(server, 'close')
    },
    url: `http://127.0.0.1:${address.port}`,
  }
}

async function startFixture(endpoint: string): Promise<RunningFixture> {
  const port = await freePort()
  let output = ''
  const child: ChildProcess = spawn(process.execPath, [FIXTURE_ENTRY], {
    env: {
      ...process.env,
      E2E_SDK_MODE: 'sandbox-ui',
      E2E_SDK_RUN_ID: 'test-run',
      E2E_SDK_SANDBOX_UI_MAX_ATTEMPTS: '1',
      E2E_SDK_USER_REF: 'test-user',
      PLUGIN_WORKLOAD_SDK_ENDPOINT: endpoint,
      PLUGIN_WORKLOAD_SDK_TOKEN: 'test-only-token',
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', data => {
    output += data.toString()
  })
  child.stderr?.on('data', data => {
    output += data.toString()
  })
  const fixture: RunningFixture = {
    logs: () => output,
    stop: async () => {
      if (child.exitCode === null) {
        child.kill('SIGTERM')
        await once(child, 'exit')
      }
    },
    url: `http://127.0.0.1:${port}`,
  }
  fixtures.push(fixture)

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if ((await fetch(`${fixture.url}/healthz`)).ok) return fixture
    } catch {
      // The fixture server is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Sandbox UI fixture did not start: ${output}`)
}

async function runMissingEndpointFixture(): Promise<string> {
  let output = ''
  const child = spawn(process.execPath, [FIXTURE_ENTRY], {
    env: { ...process.env, E2E_SDK_MODE: 'sandbox-ui' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', data => {
    output += data.toString()
  })
  child.stderr?.on('data', data => {
    output += data.toString()
  })
  await once(child, 'exit')
  return output
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(fixture => fixture.stop()))
})

describe('Sandbox UI SDK fixture failure marker', () => {
  it('emits a safe failure marker that the waiter recognizes', async () => {
    const sdk = await listen((_request, response) => {
      response.writeHead(403, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'caller_not_allowed' }))
    })
    try {
      const fixture = await startFixture(sdk.url)
      const response = await fetch(fixture.url)
      const body = await response.text()
      const logs = fixture.logs()

      expect(response.status).toBe(500)
      expect(body).toBe('Could not emit Sandbox UI notification.')
      expect(findSdkSandboxUiFailureMarker(logs)).toBe('E2E_SDK_SANDBOX_UI_FAIL=caller_not_allowed')
      expect(logs).not.toContain('test-only-token')
    } finally {
      await sdk.close()
    }
  })

  it('replaces unsafe failures with the constant marker', async () => {
    const unsafeError = 'upstream token=secret-value endpoint=https://internal.example'
    const sdk = await listen((_request, response) => {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: unsafeError }))
    })
    try {
      const fixture = await startFixture(sdk.url)
      const response = await fetch(fixture.url)
      const body = await response.text()
      const logs = fixture.logs()

      expect(response.status).toBe(500)
      expect(body).toBe('Could not emit Sandbox UI notification.')
      expect(findSdkSandboxUiFailureMarker(logs)).toBe(
        'E2E_SDK_SANDBOX_UI_FAIL=notification_emit_failed'
      )
      expect(`${logs}\n${body}`).not.toContain(unsafeError)
    } finally {
      await sdk.close()
    }
  })

  it('preserves successful and missing-endpoint markers', async () => {
    const sdk = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ notificationId: '11111111-1111-4111-8111-111111111111' }))
    })
    try {
      const fixture = await startFixture(sdk.url)
      const response = await fetch(fixture.url)

      expect(response.status).toBe(200)
      expect(fixture.logs()).toContain(
        'E2E_SDK_SANDBOX_UI_NOTIFICATION_OK=11111111-1111-4111-8111-111111111111'
      )
      expect(await runMissingEndpointFixture()).toContain(
        'E2E_SDK_SANDBOX_UI_FAIL=missing_endpoint_or_token'
      )
    } finally {
      await sdk.close()
    }
  })
})
