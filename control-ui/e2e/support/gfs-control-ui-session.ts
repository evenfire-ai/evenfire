import { type Locator, type Page, expect } from '@playwright/test'

export const CONTROL_UI_BASE_URL =
  process.env.CONTROL_UI_BASE_URL || process.env.CONTROL_UI_URL || 'http://localhost:3000'

function localAdminCredentials(): { password: string; username: string } {
  const url = new URL(CONTROL_UI_BASE_URL)
  const isLocal = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
  const password =
    process.env.E2E_ADMIN_PASSWORD ||
    process.env.ADMIN_PASSWORD ||
    process.env.ADMIN_PASS ||
    process.env.TEST_ADMIN_PASSWORD ||
    (isLocal ? 'changeme123!' : '')
  const username =
    process.env.E2E_ADMIN_USERNAME ||
    process.env.ADMIN_USER ||
    process.env.ADMIN_USERNAME ||
    process.env.TEST_ADMIN_USERNAME ||
    (isLocal ? 'admin' : '')
  if (!password || !username) {
    throw new Error(
      'Control UI E2E credentials are required for non-local URLs; set E2E_ADMIN_PASSWORD and E2E_ADMIN_USERNAME'
    )
  }
  return { password, username }
}

export async function loginControlUi(page: Page): Promise<void> {
  const credentials = localAdminCredentials()
  await page.goto(CONTROL_UI_BASE_URL)
  const signIn = page.getByRole('button', { name: 'Sign in' })
  const navigation = page.getByRole('navigation', { name: 'Main sections' })
  const entryState = await Promise.race([
    signIn
      .last()
      .waitFor({ state: 'visible', timeout: 60_000 })
      .then(() => 'login' as const),
    navigation.waitFor({ state: 'visible', timeout: 60_000 }).then(() => 'authenticated' as const),
  ])
  if (entryState === 'login') {
    await expect(page.getByLabel('Username or email')).toBeVisible()
    await page.getByLabel('Username or email').fill(credentials.username)
    await expect(page.getByLabel('Password')).toBeVisible()
    await page.getByLabel('Password').fill(credentials.password)
    await expect(signIn.last()).toBeEnabled({ timeout: 10_000 })
    await signIn.last().click()
  }
  await expect(navigation).toBeVisible({ timeout: 20_000 })
  const sessionCookie = (await page.context().cookies()).find(
    cookie => cookie.name === 'control_ui_admin_session'
  )
  expect(sessionCookie).toBeDefined()
  expect(sessionCookie?.httpOnly).toBe(true)
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem('controlUiAdminToken')))
    .toBeNull()

  const accountAlert = page
    .getByRole('status')
    .filter({ hasText: /Set up your admin email|Confirm your admin email/ })
  const remindLater = accountAlert.getByRole('button', {
    name: 'Remind me later',
    exact: true,
  })

  // The account reminder is allowed to arrive after the shell becomes ready.
  // Register a user-visible dismissal handler so it cannot intercept a later
  // GFS action, while retaining an immediate dismissal for the already-rendered
  // case. This is test setup only; it does not mutate account state or mock the
  // Control UI request path.
  await page.addLocatorHandler(accountAlert, async () => {
    if (await remindLater.isVisible().catch(() => false)) await remindLater.click()
  })
  if (await accountAlert.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await remindLater.click()
    await expect(accountAlert).toBeHidden({ timeout: 10_000 })
  }
}

export async function openGlobalFileSystemFromSidebar(page: Page): Promise<void> {
  const directoriesSection = page.getByRole('button', { name: 'Files', exact: true })
  await expect(directoriesSection).toBeVisible()
  await directoriesSection.click()
  const globalFileSystem = page.getByRole('link', {
    name: 'Global File System',
    exact: true,
  })
  await expect(globalFileSystem).toBeVisible()
  await globalFileSystem.click()
}

export async function openGfsFilePanel(
  page: Page,
  fixture: { fileName: string; name: string }
): Promise<Locator> {
  await loginControlUi(page)
  await openGlobalFileSystemFromSidebar(page)
  await expect(page).toHaveURL(/\/global-file-system(?:$|\?)/, { timeout: 15_000 })
  await expect(page.getByRole('region', { name: 'Global File System browser' })).toBeVisible()
  const resources = page.getByRole('list', { name: 'Current folder resources' })
  await resources.getByRole('button', { name: fixture.name, exact: true }).click()
  const actions = resources.getByRole('button', {
    name: `Actions for ${fixture.fileName}`,
    exact: true,
  })
  await expect(actions).toBeVisible({ timeout: 20_000 })
  await actions.click()
  const manageAccess = resources.getByRole('menuitem', { name: 'Manage access', exact: true })
  await expect(manageAccess).toBeVisible()
  await manageAccess.click()
  const panel = page.getByRole('dialog', {
    name: `Manage file ${fixture.fileName}`,
    exact: true,
  })
  await expect(panel).toBeVisible()
  return panel
}
