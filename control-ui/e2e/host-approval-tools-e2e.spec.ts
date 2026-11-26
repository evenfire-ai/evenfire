/**
 * E2E -- Approvals tab: per-tool overrides, the off switch and the version rule
 *
 * Drives the Approvals tab of the agent page (`/hosts/<name>/approval-settings`):
 *   HAT0. Sign in through the UI (session cookie); the old `/approvals` link redirects.
 *   HAT1. http_request -> Skip loosens approval: the confirmation dialog shows, and the
 *         confirmed save stores `tools.http_request: false`.
 *   HAT2. http_request back to Default clears the override.
 *   HAT3. Cancel discards an in-flight shell_exec change.
 *   HAT4. "Set to Manual now" stores `modeCeiling: manual` (or reports "Already Manual").
 *   HAT5. The version rule: a Host PUT without `resourceVersion` that changes
 *         `spec.approval` is refused with 409 `approval_requires_version`; the same body
 *         with the stored version is accepted.
 *
 * Auth: the admin session cookie set by the UI sign-in. API calls go through
 * `page.request` and the Control UI proxy (`/control-api`), so they reuse that cookie.
 *
 * Prerequisites:
 *   1. A reachable Control UI (CONTROL_UI_URL, default http://localhost:3000)
 *   2. Admin credentials: ADMIN_USER and ADMIN_PASSWORD (or the E2E_ variants)
 *   3. A host named E2E_HOST_NAME (default "chatllm") exists in the cluster
 *
 * Lane: the `chromium` project of `control-ui/playwright.config.ts` (testDir
 * `./e2e`), run with `npx playwright test e2e/host-approval-tools-e2e.spec.ts`
 * from `control-ui` against a running cluster. This test changes the named host's
 * `spec.approval`.
 */
import { type Page, expect, test } from '@playwright/test'
import { adminCredentials, api, loginThroughUi } from './qa-recorder-helpers'

const CONTROL_UI_URL = process.env.CONTROL_UI_URL || 'http://localhost:3000'
const HOST_NAME = process.env.E2E_HOST_NAME || 'chatllm'
const HOST_PATH = `/api/v1/admin/hosts/${encodeURIComponent(HOST_NAME)}`

type ApprovalBlock = Record<string, unknown> & { tools?: Record<string, boolean> }
type HostBody = {
  metadata?: { resourceVersion?: string }
  spec?: Record<string, unknown> & { approval?: ApprovalBlock }
}

async function readHost(page: Page): Promise<HostBody> {
  const { status, data } = await api<HostBody>(page.request, 'GET', HOST_PATH)
  expect(status, `GET ${HOST_PATH}`).toBe(200)
  return data
}

/**
 * Start a scenario from a known state: the host has its own approval block (so the
 * tab never opens the first-save dialog) with no per-tool overrides. The write
 * carries the version it just read, as the version rule requires.
 */
async function resetApprovalTools(page: Page): Promise<void> {
  const host = await readHost(page)
  const version = host.metadata?.resourceVersion
  expect(version, 'the host read carries a resourceVersion').toBeTruthy()
  const spec = host.spec ?? {}
  const { tools: _removed, ...approval } = spec.approval ?? {}
  const { status } = await api(page.request, 'PUT', HOST_PATH, {
    metadata: { resourceVersion: version },
    spec: { ...spec, approval: { defaultPolicy: 'channel_users', ...approval } },
  })
  expect(status).toBe(200)
}

async function openApprovalsTab(page: Page): Promise<void> {
  await page.goto(`${CONTROL_UI_URL}/hosts/${encodeURIComponent(HOST_NAME)}/approval-settings`)
  await expect(page.getByRole('tab', { name: 'Approvals', exact: true })).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.getByRole('heading', { name: 'Per-tool overrides' })).toBeVisible({
    timeout: 30_000,
  })
}

async function editTools(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(page.locator('#approval-http_request')).toBeVisible({ timeout: 10_000 })
}

const sectionActions = (page: Page) => page.locator('.cu-host-approval-section__actions')

test.describe('Approvals tab E2E -- per-tool overrides, off switch, version rule', () => {
  test.describe.configure({ mode: 'serial' })

  let page: Page

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
  })

  test.afterAll(async () => {
    await page?.close()
  })

  test('HAT0. Admin signs in through the UI; the old approvals link redirects', async () => {
    await loginThroughUi(page, adminCredentials())
    const session = (await page.context().cookies()).find(
      cookie => cookie.name === 'control_ui_admin_session'
    )
    expect(session, 'the session cookie is set').toBeDefined()

    await page.goto(`${CONTROL_UI_URL}/agents/${encodeURIComponent(HOST_NAME)}/approvals`)
    await expect(page).toHaveURL(/\/approval-settings$/, { timeout: 30_000 })
  })

  test('HAT1. http_request to Skip asks for confirmation, then the override is stored', async () => {
    await resetApprovalTools(page)
    await openApprovalsTab(page)
    await editTools(page)

    await page.selectOption('#approval-http_request', 'skip')
    await sectionActions(page).getByRole('button', { name: 'Save', exact: true }).click()

    // Skip on a tool that asks by default loosens approval: the save waits for a confirmation.
    const dialog = page.getByRole('dialog', { name: 'Confirm looser approval' })
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    await dialog.getByRole('button', { name: 'Save these changes' }).click()

    await expect(page.getByText('Per-tool overrides saved.')).toBeVisible({ timeout: 20_000 })

    const stored = await readHost(page)
    expect(stored.spec?.approval?.tools?.http_request).toBe(false)
  })

  test('HAT2. http_request back to Default clears the override', async () => {
    await openApprovalsTab(page)
    await editTools(page)
    await expect(page.locator('#approval-http_request')).toHaveValue('skip')

    await page.selectOption('#approval-http_request', 'default')
    await sectionActions(page).getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Per-tool overrides saved.')).toBeVisible({ timeout: 20_000 })

    const stored = await readHost(page)
    expect(Object.hasOwn(stored.spec?.approval?.tools ?? {}, 'http_request')).toBe(false)
  })

  test('HAT3. Cancel discards a shell_exec change without saving', async () => {
    await resetApprovalTools(page)
    await openApprovalsTab(page)
    await editTools(page)
    const before = await page.locator('#approval-shell_exec').inputValue()

    await page.selectOption('#approval-shell_exec', 'skip')
    await expect(
      sectionActions(page).getByRole('button', { name: 'Save', exact: true })
    ).toBeEnabled()
    await sectionActions(page).getByRole('button', { name: 'Cancel', exact: true }).click()

    // Back in the read view; editing again shows the stored value, not the draft.
    await editTools(page)
    await expect(page.locator('#approval-shell_exec')).toHaveValue(before)
    const stored = await readHost(page)
    expect(Object.hasOwn(stored.spec?.approval?.tools ?? {}, 'shell_exec')).toBe(false)
  })

  test('HAT4. "Set to Manual now" stores Manual', async () => {
    await openApprovalsTab(page)
    await page.getByRole('button', { name: 'Set to Manual now', exact: true }).click()
    await expect(page.getByText(/Manual is saved\./)).toBeVisible({ timeout: 30_000 })

    // An absent ceiling is Manual.
    const stored = await readHost(page)
    expect(stored.spec?.approval?.modeCeiling ?? 'manual').toBe('manual')
  })

  test('HAT5. A version-less PUT that changes spec.approval is refused with 409', async () => {
    const host = await readHost(page)
    const spec = host.spec ?? {}
    const changed = {
      ...spec,
      approval: {
        ...(spec.approval ?? {}),
        tools: { ...spec.approval?.tools, http_request: true },
      },
    }

    const refused = await api<{ error?: string; reason?: string }>(page.request, 'PUT', HOST_PATH, {
      spec: changed,
    })
    expect(refused.status).toBe(409)
    expect(refused.data).toMatchObject({ error: 'conflict', reason: 'approval_requires_version' })

    // Positive partner: the same body with the stored version is accepted.
    const accepted = await api(page.request, 'PUT', HOST_PATH, {
      metadata: { resourceVersion: host.metadata?.resourceVersion },
      spec: changed,
    })
    expect(accepted.status).toBe(200)

    await resetApprovalTools(page)
  })
})
