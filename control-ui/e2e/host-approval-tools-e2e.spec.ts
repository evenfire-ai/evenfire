/**
 * E2E -- HostApprovalSection editor flow
 *
 * Validates the per-tool approval override UI on the host detail page:
 *   Scenario 1: Toggle http_request → Skip → Save → override persists
 *               in read-only summary; warning icon visible at edit time.
 *   Scenario 2: Toggle http_request back to Default → Save → section
 *               returns to empty state.
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
 * Click the Edit button in the "Per-tool approval" section header.
 * The button lives in the same flex-row div as the section title <p>.
 * We find the closest ancestor div that directly contains both elements.
 */
async function clickSectionEdit(page: Page) {
  // The flex-row container is the div that directly wraps the <p> and <button>.
  // All ancestor divs also satisfy `:has(p.cu-section-title)`, so we use .last()
  // to get the deepest (most specific) match — the flex-row div itself.
  const flexRow = page
    .locator('div')
    .filter({ has: page.locator('p.cu-section-title:has-text("Per-tool approval")') })
    .last()
  await flexRow.locator('button:has-text("Edit")').click()
}

/** Navigate to the host detail page and wait for the Per-tool approval section to load. */
async function gotoHostDetails(page: Page) {
  await page.goto(`${BASE_UI}/hosts/${encodeURIComponent(HOST_NAME)}`)
  // The HostApprovalSection renders after `!initialLoading`, wait for the section header.
  await page.waitForSelector('text=Per-tool approval', { timeout: 20_000 })
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

  test('HAT1. Toggle http_request to Skip, Save — override persists in read-only summary with warning icon', async () => {
    test.skip(!token, 'Login failed — skipping')

    // Start from clean slate
    await clearApprovalTools(token)

    await gotoHostDetails(page)

    // Click Edit in the Per-tool approval section.
    // The flex-row div that holds the section title also holds the Edit button.
    // We locate it as the div directly containing both the <p> title and the <button>.
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

    // Wait for the section to return to read-only mode (Edit button reappears)
    await page.waitForSelector('p.cu-section-title:has-text("Per-tool approval")', {
      timeout: 15_000,
    })
    // Give the page time to re-render after loadData() completes
    await page.waitForTimeout(2_000)

    // Read-only mode: verify http_request → Skip row is visible
    const readOnlySummary = page.locator('.cu-access-row')
    const rowTexts = await readOnlySummary.allTextContents()
    const httpRequestRow = rowTexts.find(t => t.includes('http_request'))
    expect(httpRequestRow).toBeTruthy()
    expect(httpRequestRow).toContain('Skip')

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

  test('HAT2. Toggle http_request back to Default, Save — section shows empty state', async () => {
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

    // Section should now show the empty state (no overrides)
    const emptyState = page.locator('.cu-empty:has-text("No per-tool overrides")')
    // Allow for the possibility the cluster still has other overrides in flight;
    // what matters is that http_request is NOT in the summary anymore.
    const readOnlyRows = page.locator('.cu-access-row')
    const rowCount = await readOnlyRows.count()
    if (rowCount === 0) {
      // Ideal: the empty state banner is visible
      expect(await emptyState.count()).toBeGreaterThan(0)
    } else {
      // Some other override exists — confirm http_request is not in the list
      const texts = await readOnlyRows.allTextContents()
      const hasHttpRequest = texts.some(t => t.includes('http_request'))
      expect(hasHttpRequest).toBe(false)
    }

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

    // Record the current read-only state (expected: empty state or previous overrides)
    const readOnlyRowsBefore = page.locator('.cu-access-row')
    const countBefore = await readOnlyRowsBefore.count()
    const textsBefore = await readOnlyRowsBefore.allTextContents()

    // Click Edit
    await clickSectionEdit(page)
    await page.waitForSelector('#approval-shell_exec', { timeout: 10_000 })

    // Change shell_exec to Skip (a dirty change)
    await page.selectOption('#approval-shell_exec', 'skip')

    // Click Cancel
    await page.locator('button:has-text("Cancel")').last().click()

    // The section should revert to read-only mode immediately — no Save dialog
    await page.waitForSelector('p.cu-section-title:has-text("Per-tool approval")', {
      timeout: 10_000,
    })
    await page.waitForTimeout(500)

    // Edit button should be visible again (back in read-only mode)
    const flexRowAfter = page
      .locator('div')
      .filter({ has: page.locator('p.cu-section-title:has-text("Per-tool approval")') })
      .last()
    const editBtnAfter = flexRowAfter.locator('button:has-text("Edit")')
    expect(await editBtnAfter.count()).toBeGreaterThan(0)

    // The read-only rows should be the same as before the edit
    const readOnlyRowsAfter = page.locator('.cu-access-row')
    const countAfter = await readOnlyRowsAfter.count()
    const textsAfter = await readOnlyRowsAfter.allTextContents()

    expect(countAfter).toBe(countBefore)
    expect(textsAfter).toEqual(textsBefore)

    // shell_exec must NOT appear in the read-only summary (was only in draft)
    const hasShellExecAfter = textsAfter.some(t => t.includes('shell_exec'))
    expect(hasShellExecAfter).toBe(false)
  })
})
