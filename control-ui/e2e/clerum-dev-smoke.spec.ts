/**
 * E2E — example-dev smoke test
 *
 * Non-destructive health check for the example-dev GKE cluster. Validates that:
 *   - Control UI is reachable on :3000 (via port-forward)
 *   - Admin login issues a valid JWT
 *   - Control API is reachable on :8090 (via port-forward)
 *   - Registry namespace is healthy: catalog endpoints return data
 *   - GFS is visible through Control UI and backed by live cluster resources
 *   - Core namespaces are reachable through the admin API surface
 *
 * This spec does NOT install, upgrade, or uninstall anything. It is safe to
 * run repeatedly against a live dev cluster without polluting state.
 *
 * Prerequisites:
 *   1. `make gcp-dev-pf-all` running in a separate terminal (or invoked by
 *      scripts/e2e/run-e2e-example-dev.sh) so that:
 *        - http://localhost:3000 → control-ui svc (example-dev)
 *        - http://localhost:8090 → control-api svc (example-dev)
 *   2. Admin credentials in env: ADMIN_USER, ADMIN_PASS (defaults: admin / changeme123!)
 *
 * This suite is the minimum-viable validation required before trusting the
 * example-dev cluster for downstream test work (registry install lifecycle,
 * Desktop App flows, recipes). If it fails, the cluster is not
 * ready; investigate the specific step before running heavier suites.
 */
import { type Page, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'

const BASE_API = process.env.CONTROL_API_URL || 'http://localhost:8090'
const BASE_UI = process.env.CONTROL_UI_URL || 'http://localhost:3000'
const ADMIN_USER = process.env.ADMIN_USER || 'admin'
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme123!'
const K8S_CONTEXT =
  process.env.KUBECONTEXT || process.env.CONTEXT || 'gke_${GCP_PROJECT}_us-central1-a_example-dev'
const EXPECTED_GFS_STORAGE_CLASS = process.env.GFS_STORAGE_CLASS || 'standard-rwo'

// Minimum entries we expect the registry to serve. The registry base seed is
// 17 — we assert >= 1 to survive a pruned dev registry without being flaky.
const MIN_REGISTRY_ENTRIES = 1

async function getToken(page: Page): Promise<string> {
  return page.evaluate(() => localStorage.getItem('controlUiAdminToken') ?? '')
}

async function api(
  token: string,
  method: string,
  path: string
): Promise<{ status: number; data: Record<string, unknown> }> {
  const resp = await fetch(`${BASE_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
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

function kubectl(args: string[]): string {
  return execFileSync('kubectl', ['--context', K8S_CONTEXT, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

async function login(page: Page) {
  await page.goto(BASE_UI)
  const authState = await Promise.race([
    page.waitForSelector('text=Sign in', { timeout: 15_000 }).then(() => 'login'),
    page.waitForSelector('text=Marketplace', { timeout: 15_000 }).then(() => 'shell'),
  ])
  if (authState === 'shell') {
    return
  }
  const inputs = page.locator('input')
  await inputs.nth(0).fill(ADMIN_USER)
  await inputs.nth(1).fill(ADMIN_PASS)
  await page.locator('button:has-text("Sign in")').last().click()
  await page.waitForSelector('text=Marketplace', { timeout: 20_000 })
}

test.describe('example-dev — cluster smoke', () => {
  test.describe.configure({ mode: 'serial' })

  let page: Page
  let token: string

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
  })

  test.afterAll(async () => {
    await page?.close()
  })

  test('S1. Control UI — root responds on :3000', async () => {
    // Hitting BASE_UI directly (not via page.goto) keeps the check independent
    // of the browser context and verifies the port-forward is healthy before
    // we attempt a login flow.
    const resp = await fetch(BASE_UI)
    expect(resp.status).toBe(200)
    const html = await resp.text()
    expect(html).toContain('<html')
  })

  test('S2. Admin login — issues a non-empty JWT', async () => {
    await login(page)
    token = await getToken(page)
    // Why .toBeTruthy() and a length check separately: localStorage can return
    // "" (the spec says falsy → empty string) which .toBeTruthy would catch,
    // but an explicit length assertion guards against a future refactor that
    // serialises an empty object literal instead of undefined.
    expect(token).toBeTruthy()
    expect(token.length).toBeGreaterThan(20)
  })

  test('S3. Control API — authed ping via admin/users list', async () => {
    // There's no dedicated health endpoint behind admin auth; listing the
    // admin users table is the cheapest round-trip that proves the API
    // validates our JWT AND can reach its own database.
    const { status } = await api(token, 'GET', '/api/v1/admin/users')
    expect(status).toBeLessThan(500)
    expect(status).not.toBe(401)
  })

  test('S4. Registry catalog — GET /entries returns >= 1 entry', async () => {
    const { status, data } = await api(token, 'GET', '/api/v1/admin/registry/entries')
    expect(status).toBe(200)
    // Shape (verified against control-api/src/services/registryClient.ts:48):
    //   PaginatedResponse<T> = { data: T[], meta: { total, limit, offset } }
    // NOT { items: [...] } — that earlier guess conflated this endpoint with
    // the raw registry API at :8085 used in minikube e2e scripts. We're
    // hitting control-api's proxied shape at :8090/api/v1/admin/registry/*.
    const entries = (data as { data?: unknown[] }).data
    expect(Array.isArray(entries)).toBe(true)
    expect((entries as unknown[]).length).toBeGreaterThanOrEqual(MIN_REGISTRY_ENTRIES)
    const meta = (data as { meta?: { total?: number } }).meta
    expect(meta?.total).toBeGreaterThanOrEqual(MIN_REGISTRY_ENTRIES)
  })

  test('S5. Registry catalog — GET /categories returns filter options', async () => {
    const { status, data } = await api(token, 'GET', '/api/v1/admin/registry/categories')
    expect(status).toBe(200)
    // Categories respond as an object with facet arrays. We don't assert
    // specific names because the registry content may evolve; we only
    // check the endpoint is reachable and well-formed.
    expect(typeof data).toBe('object')
    expect(data).not.toBeNull()
  })

  test('S6. Registry catalog — GET /entries with filters returns 200', async () => {
    // Non-empty filter exercises the query parser; a well-formed empty result
    // is still a pass — we only care that the API does not 500 or 401.
    const { status } = await api(
      token,
      'GET',
      '/api/v1/admin/registry/entries?entryType=mcp-server&serverMode=local'
    )
    expect(status).toBe(200)
  })

  test('S7. GFS — sidebar navigation loads through Control UI proxy and live cluster resources exist', async () => {
    await login(page)
    await page.goto(BASE_UI)
    const globalFilesLink = page.getByRole('link', { name: /Global Files/i })
    await expect(globalFilesLink).toBeVisible()

    const treeResponse = page.waitForResponse(
      response =>
        response.url().includes('/control-api/api/v1/gfs/tree') &&
        response.request().method() === 'GET'
    )

    await globalFilesLink.click()
    await expect(page).toHaveURL(/\/gfs$/)
    await expect(page.getByRole('heading', { name: 'Global File System' })).toBeVisible()
    await expect(page.getByText('Drive', { exact: true })).toBeVisible()
    await expect(page.getByText('main', { exact: true }).first()).toBeVisible()

    const response = await treeResponse
    expect(response.status()).toBe(200)
    await expect(page.getByText('404')).toHaveCount(0)

    const treeBody = (await response.json()) as { items?: unknown[] }
    expect(Array.isArray(treeBody.items)).toBe(true)

    expect(
      kubectl(['-n', 'gfs', 'get', 'globalfilesystem', 'gfs', '-o', 'jsonpath={.status.phase}'])
    ).toBe('Ready')
    expect(
      kubectl(['-n', 'gfs', 'get', 'pvc', 'gfs-drive', '-o', 'jsonpath={.status.phase}'])
    ).toBe('Bound')
    expect(
      kubectl(['-n', 'gfs', 'get', 'pvc', 'gfs-drive', '-o', 'jsonpath={.spec.storageClassName}'])
    ).toBe(EXPECTED_GFS_STORAGE_CLASS)
    expect(
      kubectl([
        '-n',
        'gfs',
        'get',
        'endpoints',
        'gfsc',
        '-o',
        'jsonpath={.subsets[*].addresses[*].ip}',
      ])
    ).not.toBe('')
    expect(
      kubectl([
        '-n',
        'gfs',
        'get',
        'endpoints',
        'gfsc-writer',
        '-o',
        'jsonpath={.subsets[*].addresses[*].ip}',
      ])
    ).not.toBe('')
  })
})
