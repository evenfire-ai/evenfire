/**
 * E2E Tests: Desktop Tools (X11 + Browser)
 *
 * Prerequisites:
 *   1. Minikube running with `make minikube-setup`
 *   2. Host CRD `chatllm` has `spec.desktop: { browser: true, x11: true }`
 *   3. mcp-host pod uses `clerum/mcp-host-desktop:test` image
 *   4. Port-forward active: `kubectl port-forward -n mcp-host svc/chatllm 8080:8080`
 *   5. LLM provider is vision-capable (e.g., OpenAI gpt-4o)
 *
 * Run:
 *   cd tests/e2e && npx vitest run mcp-host/desktop-tools-e2e.test.ts
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { execSync } from 'child_process'
import { createRequire } from 'module'
import { MCP_HOST_URL, fetchJson, healthCheck, sleep, waitForIdle } from '../helpers'

const require = createRequire(import.meta.url)
const jwt = require('jsonwebtoken')

const TASK_TIMEOUT = 120_000 // 2 min — LLM + tool execution

let authToken: string

/** Generate a JWT signed with the cluster's actual private key. */
function generateClusterJwt(): string {
  // Extract the RPC JWT private key from the cluster
  const keyB64 = execSync(
    "kubectl get secret control-api-secrets -n control-plane -o jsonpath='{.data.CONTROL_API_RPC_JWT_PRIVATE_KEY}'",
    { encoding: 'utf-8' }
  ).replace(/'/g, '')
  const privateKey = Buffer.from(keyB64, 'base64').toString('utf-8')

  return jwt.sign(
    {
      sub: 'e2e-desktop-test',
      typ: 'user',
      teamId: 'e2e-team',
      scopes: ['host:message:invoke', 'host:status:read', 'host:task:read', 'host:activity:read'],
      hostRefs: ['chatllm'],
      jti: `e2e-desktop-${Date.now()}`,
    },
    privateKey,
    {
      algorithm: 'RS256',
      issuer: 'control-api',
      audience: 'rpc-proxy',
      expiresIn: '1h',
    }
  )
}

/** Authenticated fetch helper. */
async function authedFetch(
  url: string,
  opts?: RequestInit
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${authToken}`,
    ...((opts?.headers as Record<string, string>) ?? {}),
  }
  const res = await fetch(url, { ...opts, headers })
  const text = await res.text()
  let data: any
  try {
    data = JSON.parse(text)
  } catch {
    data = text
  }
  return { status: res.status, data }
}

/**
 * Send a message and wait for the task to complete.
 */
async function sendAndWaitForResult(
  content: string,
  timeoutMs = TASK_TIMEOUT
): Promise<{ response: string; toolsCalled?: string[] }> {
  const { data } = await authedFetch(`${MCP_HOST_URL}/v1/runtime/messages`, {
    method: 'POST',
    body: JSON.stringify({
      content,
      hostRef: 'chatllm',
      channelId: 'e2e-desktop',
      sender: 'e2e-desktop-test',
      channelType: 'api',
      timestamp: new Date().toISOString(),
      messageId: `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      async: true,
    }),
  })

  if (data.response) return data

  if (data.taskId) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const res = await authedFetch(`${MCP_HOST_URL}/v1/runtime/tasks/${data.taskId}/result`)
      if (res.data?.status === 'completed' || res.data?.response) {
        return res.data
      }
      await sleep(2000)
    }
    throw new Error(`Task ${data.taskId} did not complete within ${timeoutMs}ms`)
  }

  // Fallback: wait for idle
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const res = await authedFetch(`${MCP_HOST_URL}/v1/runtime/status`)
    if (res.data?.agent?.state === 'idle') return data
    await sleep(1000)
  }
  return data
}

describe('Desktop Tools E2E', () => {
  beforeAll(async () => {
    // Generate auth token from cluster secrets
    authToken = generateClusterJwt()

    // Health check (authenticated)
    const { status } = await authedFetch(`${MCP_HOST_URL}/v1/runtime/health`)
    if (status !== 200) {
      throw new Error(
        'mcp-host is not reachable. Ensure port-forward is active: ' +
          'kubectl port-forward -n mcp-host svc/chatllm 8080:8080'
      )
    }

    // Wait for agent to be idle
    const start = Date.now()
    while (Date.now() - start < 30_000) {
      const res = await authedFetch(`${MCP_HOST_URL}/v1/runtime/status`)
      if (res.data?.agent?.state === 'idle') break
      await sleep(1000)
    }
  }, 60_000)

  describe('desktop_screenshot (X11)', () => {
    it(
      'takes a screenshot and the LLM describes the desktop',
      async () => {
        const result = await sendAndWaitForResult(
          'Take a screenshot of the desktop using the desktop_screenshot tool. ' +
            'Briefly describe what you see.'
        )

        expect(result.response).toBeTruthy()
        const response = result.response.toLowerCase()
        expect(
          response.includes('desktop') ||
            response.includes('screen') ||
            response.includes('xfce') ||
            response.includes('applications') ||
            response.includes('icons')
        ).toBe(true)
      },
      TASK_TIMEOUT
    )
  })

  describe('desktop_click (X11)', () => {
    it(
      'clicks the Applications menu and takes a screenshot',
      async () => {
        const result = await sendAndWaitForResult(
          'Click on the Applications menu at coordinates x=50, y=8 using desktop_click, ' +
            'then take a desktop_screenshot. Describe what menu items you see.'
        )

        expect(result.response).toBeTruthy()
        const response = result.response.toLowerCase()
        expect(
          response.includes('terminal') ||
            response.includes('file manager') ||
            response.includes('web browser') ||
            response.includes('settings') ||
            response.includes('menu')
        ).toBe(true)
      },
      TASK_TIMEOUT
    )

    it(
      'closes the menu by clicking elsewhere',
      async () => {
        await sendAndWaitForResult(
          'Click at coordinates x=500, y=400 using desktop_click to close any open menus. ' +
            'Just confirm the click was successful.'
        )
        await sleep(1000)
      },
      TASK_TIMEOUT
    )
  })

  describe('browser_open (Playwright)', () => {
    it(
      'opens a URL and describes the page',
      async () => {
        const result = await sendAndWaitForResult(
          'Open the browser and navigate to https://example.com using the browser_open tool. ' +
            'Describe what you see on the page.'
        )

        expect(result.response).toBeTruthy()
        const response = result.response.toLowerCase()
        expect(
          response.includes('example') ||
            response.includes('domain') ||
            response.includes('page') ||
            response.includes('website')
        ).toBe(true)
      },
      TASK_TIMEOUT
    )
  })

  describe('browser_get_content (Playwright)', () => {
    it(
      'extracts text content from a page',
      async () => {
        const result = await sendAndWaitForResult(
          'Open https://example.com using browser_open, then use browser_get_content ' +
            'to get the text content of the page. Tell me the exact heading text.'
        )

        expect(result.response).toBeTruthy()
        const response = result.response.toLowerCase()
        expect(response).toContain('example domain')
      },
      TASK_TIMEOUT
    )
  })

  describe('combined workflow', () => {
    it(
      'creates an HTML file and previews it in the browser',
      async () => {
        const result = await sendAndWaitForResult(
          'Do the following steps:\n' +
            '1. Use shell_exec to create a file at /config/workspace/test.html with content: ' +
            "'<html><body><h1>Hello from Clerum Agent</h1><p>Desktop tools work!</p></body></html>'\n" +
            '2. Use browser_open to open file:///config/workspace/test.html\n' +
            '3. Describe what the page looks like.'
        )

        expect(result.response).toBeTruthy()
        const response = result.response.toLowerCase()
        expect(
          response.includes('hello') ||
            response.includes('clerum') ||
            response.includes('agent') ||
            response.includes('desktop tools')
        ).toBe(true)
      },
      TASK_TIMEOUT
    )
  })
})
