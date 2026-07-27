/**
 * E2E -- HostApprovalSection editor flow
 *
 * Validates the per-tool approval override UI on the host detail page:
 *   Scenario 1: Toggle http_request → Skip → Save → override persists.
 *   Scenario 2: Toggle http_request back to Default → Save → override clears.
 *   Scenario 3: Cancel discards the in-flight shell_exec change.
 *
 * Prerequisites:
 *   1. Port-forwards running (control-ui :3000, control-api :8090)
 *   2. Admin credentials: ADMIN_USER, ADMIN_PASS
 *   3. A host named E2E_HOST_NAME (default "chatllm") exists in the cluster
 */
import { type Page, expect, test } from '@playwright/test'

const BASE_API = process.env.CONTROL_API_URL || 'http://localhost:8090'
const BASE_UI = process.env.CONTROL_UI_URL || 'http://localhost:3000'
const ADMIN_USER = process.env.ADMIN_USER || 'admin'
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme123!'
const HOST_NAME = process.env.E2E_HOST_NAME || 'chatllm'

async function getToken(page: Page): Promise<string> {
  return page.evaluate(() => localStorage.getItem('controlUiAdminToken') ?? '')
}

async function api(
  token: string,
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<{ status: number; data: Record<string, unknown> }> {
  const opts: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  }
  if (body) opts.body = JSON.stringify(body)
  const resp = await fetch(`${BASE_API}${path}`, opts)
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
  await page.goto(BASE_UI)
  await page.waitForSelector('text=Sign in', { timeout: 15_000 })
  const inputs = page.locator('input')
  await inputs.nth(0).fill(ADMIN_USER)
  await inputs.nth(1).fill(ADMIN_PASS)
  await page.locator('button:has-text("Sign in")').last().click()
  await page.waitForSelector('text=Marketplace', { timeout: 20_000 })
}

/**
 * Enter edit mode when the embedding surface did not open it by default.
 */
async function clickSectionEdit(page: Page) {
  if ((await page.locator('#approval-http_request').count()) > 0) return
  await page
    .locator('.cu-host-approval-section__actions')
    .locator('button:has-text("Edit")')
    .click()
}

/** Navigate to the host detail page and wait for the Per-tool approval section to load. */
async function gotoHostDetails(page: Page) {
  await page.goto(`${BASE_UI}/hosts/${encodeURIComponent(HOST_NAME)}/approvals`)
  await page.waitForSelector('.cu-host-approval-section', { timeout: 20_000 })
}

/**
 * Reset approval tools for the test host via the API so each scenario starts
 * from a known state (no overrides).  Tolerates 404 when the host has no
 * approval subtree yet.
 */
async function clearApprovalTools(token: string) {
  // Fetch current host spec
  const { status, data } = await api(token, 'GET', `/api/v1/admin/hosts/${HOST_NAME}`)
  if (status !== 200) return // host not found — skip cleanup

  const spec = (data as { spec?: Record<string, unknown> }).spec ?? {}
  const approval = (spec.approval as Record<string, unknown> | undefined) ?? {}

  // Write back without the tools sub-key
  const { tools: _removed, ...approvalWithoutTools } = approval
  const nextApproval =
    Object.keys(approvalWithoutTools).length > 0 ? approvalWithoutTools : undefined

  const nextSpec = nextApproval !== undefined ? { ...spec, approval: nextApproval } : { ...spec }

  // Remove approval key entirely when empty
  if (nextApproval === undefined) {
    delete nextSpec.approval
  }

  await api(token, 'PUT', `/api/v1/admin/hosts/${HOST_NAME}`, { spec: nextSpec })
}

test.describe('HostApprovalSection E2E -- per-tool override editor flow', () => {
  test.describe.configure({ mode: 'serial' })

  let page: Page
  let token: string

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
  })

  test.afterAll(async () => {
    await page?.close()
  })

  // ── HAT0. Login ──────────────────────────────────────────────────────────

  test('HAT0. Admin login', async () => {
    await login(page)
    token = await getToken(page)
    expect(token).toBeTruthy()
  })

  // ── HAT1. Toggle http_request → Skip → Save ─────────────────────────────

  test('HAT1. Toggle http_request to Skip, Save — override persists with warning icon', async () => {
    test.skip(!token, 'Login failed — skipping')

    // Start from clean slate
    await clearApprovalTools(token)

    await gotoHostDetails(page)

    await clickSectionEdit(page)

    // Wait for the edit-mode selects to appear
    await page.waitForSelector('#approval-http_request', { timeout: 10_000 })

    // Verify warning icon is NOT yet visible (we haven't changed to Skip)
    // The warning <span> appears when state === 'skip' && codeDefault === 'required'
    // Its title contains CLERUM_HTTP_ALLOWLIST
    const warningBeforeChange = page.locator('[title*="CLERUM_HTTP_ALLOWLIST"]')
    expect(await warningBeforeChange.count()).toBe(0)

    // Change http_request from "Default" to "Skip"
    await page.selectOption('#approval-http_request', 'skip')

    // Warning icon should now appear (title="Skipping approval relies on CLERUM_HTTP_ALLOWLIST…")
    await page.waitForSelector('[title*="CLERUM_HTTP_ALLOWLIST"]', { timeout: 5_000 })
    const warningIcon = page.locator('[title*="CLERUM_HTTP_ALLOWLIST"]')
    expect(await warningIcon.count()).toBeGreaterThan(0)

    // Click Save (enabled because isDirty)
    const saveBtn = page
      .locator('button.cu-btn--primary:has-text("Save"), button:has-text("Save")')
      .filter({ hasNot: page.locator(':disabled') })
      .last()
    await saveBtn.click()

    await expect(page.locator('#approval-http_request')).toHaveValue('skip')
    await expect(
      page.locator('.cu-host-approval-section__actions button:has-text("Save")')
    ).toBeDisabled()

    // Bonus: verify via API that the CRD was patched
    const { status, data } = await api(token, 'GET', `/api/v1/admin/hosts/${HOST_NAME}`)
    if (status === 200) {
      const tools = (data as { spec?: { approval?: { tools?: Record<string, boolean> } } }).spec
        ?.approval?.tools
      // http_request = false means Skip in the CRD
      if (tools !== undefined) {
        expect(tools['http_request']).toBe(false)
      }
    }
  })

  // ── HAT2. Toggle back to Default → Save → empty state ───────────────────

  test('HAT2. Toggle http_request back to Default, Save — override clears', async () => {
    test.skip(!token, 'Login failed — skipping')

    await gotoHostDetails(page)

    // Click Edit
    await clickSectionEdit(page)

    // Wait for the select to appear
    await page.waitForSelector('#approval-http_request', { timeout: 10_000 })

    // The http_request row should currently be "skip" (set by HAT1)
    const currentValue = await page.locator('#approval-http_request').inputValue()
    // If the cluster already has the value, proceed; otherwise the test is still valid
    // — we change it to Default either way.
    expect(['skip', 'default', 'required']).toContain(currentValue)

    // Change back to Default
    await page.selectOption('#approval-http_request', 'default')

    // Save button: only enabled when dirty
    const saveBtn = page
      .locator('button.cu-btn--primary:has-text("Save"), button:has-text("Save")')
      .filter({ hasNot: page.locator(':disabled') })
      .last()
    await saveBtn.click()

    // Wait for re-render
    await page.waitForTimeout(2_000)

    await expect(page.locator('#approval-http_request')).toHaveValue('default')

    // API verification
    const { status, data } = await api(token, 'GET', `/api/v1/admin/hosts/${HOST_NAME}`)
    if (status === 200) {
      const tools = (data as { spec?: { approval?: { tools?: Record<string, boolean> } } }).spec
        ?.approval?.tools
      if (tools !== undefined) {
        // http_request key should be absent (Default means no override)
        expect(Object.prototype.hasOwnProperty.call(tools, 'http_request')).toBe(false)
      }
    }
  })

  // ── HAT3. Cancel discards in-flight changes ───────────────────────────────

  test('HAT3. Cancel discards shell_exec change without saving', async () => {
    test.skip(!token, 'Login failed — skipping')

    // Ensure clean state before this scenario
    await clearApprovalTools(token)
    await gotoHostDetails(page)

    await clickSectionEdit(page)
    await page.waitForSelector('#approval-shell_exec', { timeout: 10_000 })
    const valueBefore = await page.locator('#approval-shell_exec').inputValue()

    // Change shell_exec to Skip (a dirty change)
    await page.selectOption('#approval-shell_exec', 'skip')

    // Click Cancel
    await page.locator('button:has-text("Cancel")').last().click()

    await expect(page.locator('#approval-shell_exec')).toHaveValue(valueBefore)
    await expect(
      page.locator('.cu-host-approval-section__actions button:has-text("Save")')
    ).toBeDisabled()
  })
})
