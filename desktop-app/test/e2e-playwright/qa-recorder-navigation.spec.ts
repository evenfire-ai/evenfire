import { type ElectronApplication, type Page, expect, test } from '@playwright/test'
import {
  EXTERNAL_REST_API_BASE_URL,
  RPC_PROXY_BASE_URL,
  assertAllowedTarget,
  desktopCredentials,
  finalizeRecording,
  launchDesktopApp,
  login,
  openAgentsPage,
  openResourcesNavItem,
  screenshotAndLog,
} from './qa-recorder-helpers'

// Read-only global shell navigation journey. It exercises the primary sidebar,
// the footer Settings/Resources menus, and each Resources destination page so
// the recording proves the Desktop shell routes between its top-level views.
// No confirm flag is required: nothing here writes, messages, or pays.

test('optional QA recorder: Desktop navigation journey — primary sidebar', async ({}, testInfo) => {
  await assertAllowedTarget('EXTERNAL_REST_API_BASE_URL', EXTERNAL_REST_API_BASE_URL)
  await assertAllowedTarget('RPC_PROXY_BASE_URL', RPC_PROXY_BASE_URL)

  const credentials = desktopCredentials()
  let app: ElectronApplication | undefined
  let page: Page | undefined

  try {
    const launched = await launchDesktopApp(testInfo)
    app = launched.app
    page = launched.page
    await login(page, credentials)

    // Both primary sidebar items are present. The `active` class lives on the
    // wrapping div around the data-testid button, so assert against its parent.
    const chatNav = page.getByTestId('nav-chat')
    const sandboxNav = page.getByTestId('nav-sandbox-ui')
    await expect(chatNav).toBeVisible({ timeout: 20_000 })
    await expect(sandboxNav).toBeVisible({ timeout: 20_000 })

    // Clicking Apps marks the sandbox-ui nav item active and renders the Apps shell.
    await sandboxNav.click()
    await expect(sandboxNav.locator('xpath=..')).toHaveClass(/active/)
    await expect(page.getByRole('heading', { name: 'Apps', exact: true })).toBeVisible({
      timeout: 20_000,
    })

    // Clicking Chat restores the chat nav item as the active destination.
    await chatNav.click()
    await expect(chatNav.locator('xpath=..')).toHaveClass(/active/)

    await screenshotAndLog(page, testInfo, 'desktop-nav-primary-sidebar')
  } finally {
    await finalizeRecording(app, page)
  }
})

test('optional QA recorder: Desktop navigation journey — footer settings menu', async ({}, testInfo) => {
  await assertAllowedTarget('EXTERNAL_REST_API_BASE_URL', EXTERNAL_REST_API_BASE_URL)
  await assertAllowedTarget('RPC_PROXY_BASE_URL', RPC_PROXY_BASE_URL)

  const credentials = desktopCredentials()
  let app: ElectronApplication | undefined
  let page: Page | undefined

  try {
    const launched = await launchDesktopApp(testInfo)
    app = launched.app
    page = launched.page
    await login(page, credentials)

    // Footer Settings menu opens (aria-expanded flips to true).
    const settingsMenu = page.getByTestId('nav-settings-menu')
    await expect(settingsMenu).toBeVisible({ timeout: 20_000 })
    if ((await settingsMenu.getAttribute('aria-expanded')) !== 'true') {
      await settingsMenu.click()
    }
    await expect(settingsMenu).toHaveAttribute('aria-expanded', 'true')

    // Resources submenu expands and exposes the data-route destinations.
    const resourcesMenu = page.getByTestId('nav-data-menu')
    await expect(resourcesMenu).toBeVisible({ timeout: 20_000 })
    if ((await resourcesMenu.getAttribute('aria-expanded')) !== 'true') {
      await resourcesMenu.click()
    }
    await expect(resourcesMenu).toHaveAttribute('aria-expanded', 'true')

    for (const itemTestId of ['nav-agents', 'nav-contexts', 'nav-teams', 'nav-mcp-servers']) {
      await expect(page.getByTestId(itemTestId)).toBeVisible({ timeout: 20_000 })
    }

    // The Settings menu item opens the Settings page heading.
    await page.getByTestId('nav-settings').click()
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({
      timeout: 20_000,
    })

    await screenshotAndLog(page, testInfo, 'desktop-nav-footer-menu')
  } finally {
    await finalizeRecording(app, page)
  }
})

test('optional QA recorder: Desktop navigation journey — resources pages', async ({}, testInfo) => {
  await assertAllowedTarget('EXTERNAL_REST_API_BASE_URL', EXTERNAL_REST_API_BASE_URL)
  await assertAllowedTarget('RPC_PROXY_BASE_URL', RPC_PROXY_BASE_URL)

  const credentials = desktopCredentials()
  let app: ElectronApplication | undefined
  let page: Page | undefined

  try {
    const launched = await launchDesktopApp(testInfo)
    app = launched.app
    page = launched.page
    await login(page, credentials)

    // Agents — FleetBoard and the empty state both surface the "Agents" heading.
    await openAgentsPage(page)
    await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible({
      timeout: 20_000,
    })

    // Contexts page shell.
    await openResourcesNavItem(page, 'nav-contexts')
    await expect(page.getByRole('heading', { name: 'Contexts', exact: true })).toBeVisible({
      timeout: 20_000,
    })

    // Teams page heading reads "Members & Teams".
    await openResourcesNavItem(page, 'nav-teams')
    await expect(page.getByRole('heading', { name: /Members & Teams/ })).toBeVisible({
      timeout: 20_000,
    })

    // Connectors (MCP servers) page shell.
    await openResourcesNavItem(page, 'nav-mcp-servers')
    await expect(page.getByRole('heading', { name: 'Connectors', exact: true })).toBeVisible({
      timeout: 20_000,
    })

    await screenshotAndLog(page, testInfo, 'desktop-nav-resources-pages')
  } finally {
    await finalizeRecording(app, page)
  }
})
