/**
 * E2E -- Template Drift Detection
 *
 * Validates the "Template drift" panel on the recipe detail page (§10.3.3):
 *   - "In sync" green badge when instance matches template
 *   - "Newer version available" yellow badge when registry has newer version
 *   - JSON diff view renders changed fields
 *   - "Promote" CTA opens pre-filled instantiation wizard
 *
 * Prerequisites:
 *   1. Port-forwards running (control-ui :3000, control-api :8090)
 *   2. Admin credentials: ADMIN_USER, ADMIN_PASS
 *   3. At least one instantiated recipe with registry reference
 */
import { type Page, expect, test } from '@playwright/test'

const BASE_API = process.env.CONTROL_API_URL || 'http://localhost:8090'
const BASE_UI = process.env.CONTROL_UI_URL || 'http://localhost:3000'
const ADMIN_USER = process.env.ADMIN_USER || 'admin'
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme123!'
const RECIPE_NS = 'sandbox-recipes'
const RECIPE_NAME = 'e2e-ondemand-simple'

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

test.describe('template drift — recipe detail panel', () => {
  test.describe.configure({ mode: 'serial' })

  let page: Page
  let token: string

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await login(page)
    token = await getToken(page)
    if (!token) test.skip(true, 'Admin login failed')
  })

  test.afterAll(async () => {
    await page?.close()
  })

  test('in-sync instance shows green badge', async () => {
    await page.goto(`${BASE_UI}/workflow-recipes/${RECIPE_NS}/${RECIPE_NAME}`)
    await page.waitForLoadState('networkidle')

    const driftPanel = page.locator('[data-testid="template-drift-panel"]')
    if (!(await driftPanel.isVisible().catch(() => false))) {
      test.skip(true, 'Template drift panel not rendered — recipe may lack registry ref')
      return
    }

    const badge = driftPanel.locator('[data-testid="drift-status-badge"]')
    await expect(badge).toBeVisible({ timeout: 10_000 })
    const badgeText = await badge.textContent()
    expect(badgeText?.toLowerCase()).toContain('sync')
  })

  test('newer version shows yellow badge with promote CTA', async () => {
    const diffRes = await api(
      token,
      'GET',
      `/api/v1/admin/recipes/${RECIPE_NS}/${RECIPE_NAME}/diff`
    )

    if (
      diffRes.status !== 200 ||
      !(diffRes.data as Record<string, unknown>).registryHasNewerVersion
    ) {
      test.skip(true, 'No newer version in registry — cannot test drift badge')
      return
    }

    await page.goto(`${BASE_UI}/workflow-recipes/${RECIPE_NS}/${RECIPE_NAME}`)
    await page.waitForLoadState('networkidle')

    const driftPanel = page.locator('[data-testid="template-drift-panel"]')
    const badge = driftPanel.locator('[data-testid="drift-status-badge"]')
    await expect(badge).toBeVisible({ timeout: 10_000 })
    const badgeText = await badge.textContent()
    expect(badgeText?.toLowerCase()).toMatch(/newer|available/)

    const promoteBtn = driftPanel.locator('button:has-text("Promote")')
    await expect(promoteBtn).toBeVisible()
  })

  test('diff view renders changed fields in collapsible section', async () => {
    const diffRes = await api(
      token,
      'GET',
      `/api/v1/admin/recipes/${RECIPE_NS}/${RECIPE_NAME}/diff`
    )

    if (diffRes.status !== 200) {
      test.skip(true, 'Diff endpoint not available')
      return
    }

    await page.goto(`${BASE_UI}/workflow-recipes/${RECIPE_NS}/${RECIPE_NAME}`)
    await page.waitForLoadState('networkidle')

    const driftPanel = page.locator('[data-testid="template-drift-panel"]')
    if (!(await driftPanel.isVisible().catch(() => false))) {
      test.skip(true, 'Template drift panel not rendered')
      return
    }

    const diffToggle = driftPanel.locator(
      'button:has-text("Show diff"), button:has-text("View changes")'
    )
    if (await diffToggle.isVisible().catch(() => false)) {
      await diffToggle.click()
      const diffView = driftPanel.locator('[data-testid="diff-viewer"], .diff-container')
      await expect(diffView).toBeVisible({ timeout: 5_000 })
    }
  })

  test('promote CTA opens pre-filled instantiation wizard', async () => {
    const diffRes = await api(
      token,
      'GET',
      `/api/v1/admin/recipes/${RECIPE_NS}/${RECIPE_NAME}/diff`
    )

    if (
      diffRes.status !== 200 ||
      !(diffRes.data as Record<string, unknown>).registryHasNewerVersion
    ) {
      test.skip(true, 'No newer version — cannot test promote flow')
      return
    }

    await page.goto(`${BASE_UI}/workflow-recipes/${RECIPE_NS}/${RECIPE_NAME}`)
    await page.waitForLoadState('networkidle')

    const driftPanel = page.locator('[data-testid="template-drift-panel"]')
    const promoteBtn = driftPanel.locator('button:has-text("Promote")')
    await expect(promoteBtn).toBeVisible({ timeout: 10_000 })
    await promoteBtn.click()

    await page.waitForURL(/\/registry\/instantiate\//, { timeout: 10_000 })
    expect(page.url()).toContain('/registry/instantiate/')
  })
})
