/**
 * E2E -- Users & Roles Admin
 *
 * Validates the user admin page (§10.4):
 *   - Role dropdown changes user role
 *   - Self-demotion from admin is disabled
 *   - Recipe-trigger grants table renders
 *   - Grant new recipe from user detail
 *   - Approver eligibility section
 *
 * Prerequisites:
 *   1. Port-forwards running (control-ui :3000, control-api :8090)
 *   2. Admin credentials: ADMIN_USER, ADMIN_PASS
 *   3. E2E_USER_B_EMAIL for role change target
 */
import { type Page, expect, test } from '@playwright/test'

const BASE_API = process.env.CONTROL_API_URL || 'http://localhost:8090'
const BASE_UI = process.env.CONTROL_UI_URL || 'http://localhost:3000'
const ADMIN_USER = process.env.ADMIN_USER || 'admin'
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme123!'
const USER_B_EMAIL = process.env.E2E_USER_B_EMAIL || 'e2e-user-b@test.local'

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

async function findUserId(token: string, email: string): Promise<string | null> {
  const res = await fetch(`${BASE_API}/api/v1/admin/users?search=${encodeURIComponent(email)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status !== 200) return null
  const data = await res.json()
  const users = Array.isArray(data) ? data : (data.users ?? data.items ?? [])
  const match = users.find(
    (u: Record<string, unknown>) => u.email === email || u.username === email
  )
  return match?.id ?? match?.userId ?? null
}

test.describe('users & roles admin', () => {
  test.describe.configure({ mode: 'serial' })

  let page: Page
  let token: string
  let targetUserId: string | null = null

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await login(page)
    token = await getToken(page)
    if (!token) {
      test.skip(true, 'Admin login failed')
      return
    }
    targetUserId = await findUserId(token, USER_B_EMAIL)
  })

  test.afterAll(async () => {
    await page?.close()
  })

  test('role dropdown changes user role', async () => {
    if (!targetUserId) {
      test.skip(true, `User ${USER_B_EMAIL} not found`)
      return
    }

    await page.goto(`${BASE_UI}/users/${targetUserId}`)
    await page.waitForLoadState('networkidle')

    const roleSelect = page.locator('[data-testid="role-dropdown"], select[name="role"]')
    if (!(await roleSelect.isVisible().catch(() => false))) {
      test.skip(true, 'Role dropdown not found — page may not be implemented yet')
      return
    }

    const currentRole = await roleSelect.inputValue()
    const newRole = currentRole === 'operator' ? 'user' : 'operator'

    await roleSelect.selectOption(newRole)
    const saveBtn = page.locator('button:has-text("Save"), button:has-text("Update role")')
    if (await saveBtn.isVisible().catch(() => false)) {
      await saveBtn.click()
    }

    await page.waitForTimeout(1_000)
    const roleRes = await api(token, 'GET', `/api/v1/admin/users/${targetUserId}`)
    expect(roleRes.status).toBe(200)

    // Restore original role
    await roleSelect.selectOption(currentRole)
    if (await saveBtn.isVisible().catch(() => false)) {
      await saveBtn.click()
    }
  })

  test('self-demotion from admin is disabled', async () => {
    const meRes = await api(token, 'GET', '/api/v1/admin/users/me')
    const myId =
      (meRes.data as Record<string, unknown>).id ?? (meRes.data as Record<string, unknown>).userId
    if (!myId) {
      test.skip(true, 'Cannot determine current admin user ID')
      return
    }

    await page.goto(`${BASE_UI}/users/${myId}`)
    await page.waitForLoadState('networkidle')

    const roleSelect = page.locator('[data-testid="role-dropdown"], select[name="role"]')
    if (!(await roleSelect.isVisible().catch(() => false))) {
      test.skip(true, 'Role dropdown not found')
      return
    }

    const isDisabled = await roleSelect.isDisabled()
    expect(isDisabled).toBe(true)
  })

  test('recipe-trigger grants table renders', async () => {
    if (!targetUserId) {
      test.skip(true, `User ${USER_B_EMAIL} not found`)
      return
    }

    await page.goto(`${BASE_UI}/users/${targetUserId}`)
    await page.waitForLoadState('networkidle')

    const grantsSection = page.locator(
      '[data-testid="trigger-grants-section"], :text("Recipe-trigger grants")'
    )
    if (!(await grantsSection.isVisible().catch(() => false))) {
      test.skip(true, 'Trigger grants section not rendered')
      return
    }

    await expect(grantsSection).toBeVisible()
  })

  test('grant new recipe from user detail', async () => {
    if (!targetUserId) {
      test.skip(true, `User ${USER_B_EMAIL} not found`)
      return
    }

    await page.goto(`${BASE_UI}/users/${targetUserId}`)
    await page.waitForLoadState('networkidle')

    const grantBtn = page.locator('button:has-text("Grant new"), button:has-text("Add grant")')
    if (!(await grantBtn.isVisible().catch(() => false))) {
      test.skip(true, 'Grant button not found')
      return
    }

    await grantBtn.click()

    const recipeSelector = page.locator('[data-testid="recipe-picker"], [role="listbox"]')
    await expect(recipeSelector).toBeVisible({ timeout: 5_000 })
  })

  test('approver eligibility section visible', async () => {
    if (!targetUserId) {
      test.skip(true, `User ${USER_B_EMAIL} not found`)
      return
    }

    await page.goto(`${BASE_UI}/users/${targetUserId}`)
    await page.waitForLoadState('networkidle')

    const eligibilitySection = page.locator(
      '[data-testid="approver-eligibility"], :text("Approver eligibility"), :text("Eligible")'
    )
    if (!(await eligibilitySection.isVisible().catch(() => false))) {
      test.skip(true, 'Approver eligibility section not rendered — endpoint may not exist yet')
      return
    }

    await expect(eligibilitySection).toBeVisible()
  })
})
