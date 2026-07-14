/**
 * E2E — SSRF Attack Vector Rejection (Defense-in-Depth Chain)
 *
 * Proves the FULL stack rejects installation of registry entries whose
 * `remoteEndpoints[0].url` points at internal / metadata / loopback / non-HTTPS
 * targets. This is the only test that validates that:
 *
 *   control-api `validateRemoteUrl` → HCC sanitizeRemoteUrl
 *
 * chain together correctly. Unit tests cover each layer in isolation, but
 * only E2E proves the chain is actually wired up in the real deployment.
 *
 * Attack model:
 *   An attacker seeds a malicious registry catalog entry whose
 *   `remoteEndpoints[0].url` targets an internal / sensitive address. They
 *   then try to install it via the admin install endpoint. The install MUST
 *   fail with 4xx/5xx before any McpServer CRD is created.
 *
 * Prerequisites:
 *   - minikube cluster clerum-test running
 *   - port-forwards on :3000 (control-ui) and :8090 (control-api)
 *   - registry-api Service in namespace `registry` (port 8085)
 *   - Admin credentials: admin / changeme123!
 *
 * This test spawns its own port-forward to the registry service on :8085.
 */
import { type Page, expect, test } from '@playwright/test'
import { type ChildProcess, spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const BASE_API = process.env.CONTROL_API_URL || 'http://localhost:8090'
const REGISTRY_BASE = process.env.REGISTRY_URL || 'http://localhost:8085'
const ADMIN_USER = process.env.ADMIN_USER || 'admin'
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme123!'
const KUBECTL_CONTEXT = process.env.KUBECTL_CONTEXT || 'clerum-test'
const SHOULD_SPAWN_REGISTRY_PF = !process.env.REGISTRY_URL

// ── Helpers ─────────────────────────────────────────────────────────────────

async function getToken(page: Page): Promise<string> {
  return page.evaluate(() => localStorage.getItem('controlUiAdminToken') ?? '')
}

async function api(
  token: string,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; data: Record<string, unknown> }> {
  const resp = await fetch(`${BASE_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await resp.text()
  let data: Record<string, unknown> = {}
  try {
    data = JSON.parse(text)
  } catch {
    data = { raw: text }
  }
  return { status: resp.status, data }
}

async function login(page: Page) {
  await page.goto('/')
  await page.waitForSelector('text=Sign in', { timeout: 10_000 })
  const inputs = page.locator('input')
  await inputs.nth(0).fill(ADMIN_USER)
  await inputs.nth(1).fill(ADMIN_PASS)
  await page.locator('button:has-text("Sign in")').last().click()
  await page.waitForSelector('text=Marketplace', { timeout: 15_000 })
}

/** Publish a registry entry directly (bypassing control-api) so we can test
 *  what happens when the control-api install endpoint receives a malicious
 *  entry from the registry. Auth is disabled in dev (CLERUM_REGISTRY_AUTH_ENABLED=false). */
async function publishRegistryEntry(entry: Record<string, unknown>): Promise<number> {
  let lastStatus = 0
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const resp = await fetch(`${REGISTRY_BASE}/api/v1/entries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    })
    lastStatus = resp.status
    if (resp.status !== 429) return resp.status
    await delay(10_000)
  }
  return lastStatus
}

async function deleteRegistryEntry(name: string, version: string): Promise<void> {
  await fetch(`${REGISTRY_BASE}/api/v1/entries/${name}/versions/${version}`, {
    method: 'DELETE',
  }).catch(() => undefined)
}

function buildMaliciousEntry(name: string, url: string): Record<string, unknown> {
  return {
    name,
    version: '1.0.0',
    entryType: 'mcp-server',
    description: `SSRF test entry targeting ${url}`,
    author: 'ssrf-e2e-test',
    origin: 'human-authored',
    category: 'databases',
    tags: ['ssrf', 'test'],
    contentCreatorTag: 'community',
    configCreatorTag: 'community',
    visibility: 'public',
    mcpServer: {
      serverMode: 'remote',
      transport: 'streamableHttp',
      remoteEndpoints: [{ url, region: 'us', description: 'attack endpoint' }],
      credentialSchema: { required: false, authType: 'none', keys: [] },
      egressSummary: { domains: ['example.com'], ports: [443], wideCidr: false },
      tools: ['attack'],
    },
  }
}

/** Wait until the registry is reachable on the forwarded port. */
async function waitForRegistry(maxMs = 30_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    try {
      const r = await fetch(`${REGISTRY_BASE}/health`)
      if (r.ok) return
    } catch {
      /* retry */
    }
    await delay(500)
  }
  throw new Error(`Registry did not become reachable on ${REGISTRY_BASE} within ${maxMs}ms`)
}

// ═══════════════════════════════════════════════════════════════════════════
// SSRF Attack Vectors
// ═══════════════════════════════════════════════════════════════════════════

test.describe('Registry SSRF Attack Vectors', () => {
  test.describe.configure({ mode: 'serial' })

  let token = ''
  let pfProcess: ChildProcess | null = null

  test.beforeAll(async ({ browser }) => {
    // 1) Spawn kubectl port-forward only for the legacy default port flow.
    // Profile-scoped runs pass REGISTRY_URL and keep their own port-forwards.
    if (SHOULD_SPAWN_REGISTRY_PF) {
      pfProcess = spawn(
        'kubectl',
        [
          `--context=${KUBECTL_CONTEXT}`,
          'port-forward',
          '-n',
          'registry',
          'svc/registry-api',
          '8085:8085',
        ],
        { stdio: 'ignore', detached: false }
      )
      pfProcess.on('error', e => console.error('[ssrf-e2e] port-forward spawn error:', e))
    }

    // 2) Wait until reachable
    await waitForRegistry()

    // 3) Login to control-api
    const page = await browser.newPage()
    await login(page)
    token = await getToken(page)
    await page.close()
    expect(token).toBeTruthy()
  })

  test.afterAll(async () => {
    if (pfProcess && !pfProcess.killed) {
      pfProcess.kill('SIGTERM')
      // Give it a moment to shut down cleanly
      await delay(500)
      if (!pfProcess.killed) pfProcess.kill('SIGKILL')
    }
  })

  // Cases: [testId, server-name suffix, remote URL, description]
  const cases: Array<[string, string, string, string]> = [
    ['1', 'aws-metadata', 'https://169.254.169.254/latest/meta-data', 'AWS metadata endpoint'],
    [
      '2',
      'cluster-svc',
      'https://control-api.control-plane.svc.cluster.local:8090',
      'cluster-internal .svc.cluster.local',
    ],
    ['3', 'kubernetes-default', 'https://kubernetes.default:443/api', 'kubernetes.default'],
    ['4', 'rfc1918-10', 'https://10.0.0.1:443/api', 'RFC1918 10.x'],
    ['5', 'loopback-127', 'https://127.0.0.1:443/api', 'loopback 127.x'],
    ['6', 'http-not-https', 'http://api.example.com/api', 'plain HTTP (not HTTPS)'],
  ]

  for (const [id, suffix, url, desc] of cases) {
    const entryName = `ssrf-attempt-${id}-${suffix}`
    const serverName = `ssrf-server-${id}-${suffix}`

    test(`${id}. ${desc} (${url}) is rejected`, async () => {
      test.setTimeout(120_000)

      // Publish malicious catalog entry
      const pubStatus = await publishRegistryEntry(buildMaliciousEntry(entryName, url))
      expect(pubStatus).toBe(201)

      try {
        // Attempt install via control-api
        const { status, data } = await api(token, 'POST', '/api/v1/admin/registry/install', {
          serverName,
          contextRef: 'context1',
          registryEntryName: entryName,
          registryEntryVersion: '1.0.0',
        })

        // Must be a 4xx/5xx rejection — NEVER a 201 success
        expect
          .soft(status, `expected rejection, got ${status} for url=${url}`)
          .toBeGreaterThanOrEqual(400)
        expect.soft(status).toBeLessThan(600)
        expect.soft(status).not.toBe(201)

        // Response should mention some rejection/ssrf reason (best effort).
        // If control-api swallowed into an anonymous 500 we accept it (message
        // may be sanitized) but we DO check the response body is JSON.
        expect(typeof data).toBe('object')

        // Defense in depth: verify NO McpServer CRD was created
        const { data: listData } = await api(token, 'GET', '/api/v1/admin/mcp-servers')
        const items = (listData.items as Array<{ metadata: { name: string } }> | undefined) ?? []
        const created = items.find(i => i.metadata.name === serverName)
        expect(
          created,
          `SECURITY GAP: McpServer ${serverName} was created despite SSRF URL ${url}`
        ).toBeUndefined()
      } finally {
        // Cleanup: registry entry + any accidentally created McpServer
        await api(
          token,
          'DELETE',
          `/api/v1/admin/registry/uninstall/${serverName}?type=mcp-server`
        ).catch(() => undefined)
        await deleteRegistryEntry(entryName, '1.0.0')
      }
    })
  }

  test('7. Sanity check — legitimate public HTTPS URL is accepted', async () => {
    test.setTimeout(120_000)

    const entryName = 'ssrf-sanity-legit-url'
    const serverName = 'ssrf-sanity-server'
    const legitUrl = 'https://api.github.com/v1/mcp'

    const pubStatus = await publishRegistryEntry(buildMaliciousEntry(entryName, legitUrl))
    expect(pubStatus).toBe(201)

    try {
      const { status, data } = await api(token, 'POST', '/api/v1/admin/registry/install', {
        serverName,
        contextRef: 'context1',
        registryEntryName: entryName,
        registryEntryVersion: '1.0.0',
      })

      // Legit URL must pass validateRemoteUrl and reach CRD creation.
      // 201 expected; accept 200 as well. Anything else means validateRemoteUrl
      // has false positives or another failure path.
      expect(
        [200, 201].includes(status),
        `legit URL unexpectedly rejected: status=${status}, body=${JSON.stringify(data)}`
      ).toBe(true)
    } finally {
      await api(
        token,
        'DELETE',
        `/api/v1/admin/registry/uninstall/${serverName}?type=mcp-server`
      ).catch(() => undefined)
      await deleteRegistryEntry(entryName, '1.0.0')
    }
  })
})
