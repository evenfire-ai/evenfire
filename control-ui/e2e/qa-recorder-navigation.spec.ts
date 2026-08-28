// control-ui/e2e/qa-recorder-navigation.spec.ts
//
// Optional QA recorder journey that walks the Control UI sidebar's main
// destinations in turn and asserts each destination's page shell renders.
// Read-only: no cluster resources are created or mutated. Uses the shared
// helpers from qa-recorder-helpers.ts and the built-in `page` fixture (the
// headful Chromium + video recording are managed by
// playwright.qa-recorder.config.ts).
//
// Contract: docs/testing/optional-playwright-qa-recorder.md ("Extending the recorder").
import { expect, test } from '@playwright/test'
import {
  CONTROL_API_URL,
  CONTROL_UI_URL,
  adminCredentials,
  assertAllowedTarget,
  loginThroughUi,
  screenshotAndLog,
} from './qa-recorder-helpers'

test.describe('optional QA recorder: Control UI navigation', () => {
  test('optional QA recorder: Control UI navigation journey', async ({ page }, testInfo) => {
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    await loginThroughUi(page, credentials)

    // The sidebar's primary nav region. 'Settings' lives in the footer outside
    // this region, so it is targeted with a global locator below.
    const mainNav = page.getByRole('navigation', { name: 'Main sections' })
    const sidebar = page.locator('.cu-sidebar')
    await expect(sidebar).toHaveCount(1)
    const sidebarElement = await sidebar.elementHandle()
    if (!sidebarElement) throw new Error('Control UI sidebar did not mount')

    async function expectPersistentSidebar() {
      expect(
        await sidebarElement.evaluate(
          element => element.isConnected && element === document.querySelector('.cu-sidebar')
        )
      ).toBe(true)
    }

    // 1) Agents — sidebar href is /agents, which next.config rewrites to the
    //    /hosts page (the browser URL is not stable across rewrites), so assert
    //    page CONTENT (HostTable's TablePanelHeader subtitle), not the URL.
    await mainNav.getByRole('link', { name: 'Agents', exact: true }).click()
    await expect(
      page.getByText('Manage available agents and their host mappings.', { exact: true })
    ).toBeVisible({ timeout: 20_000 })
    await expectPersistentSidebar()
    await screenshotAndLog(page, testInfo, 'control-ui-navigation-agents')

    // 2) Contexts — /contexts is a real App Router segment; URL is stable.
    await mainNav.getByRole('link', { name: 'Contexts', exact: true }).click()
    await expect(page).toHaveURL(/\/contexts$/, { timeout: 20_000 })
    await expect(
      page.getByText('Group connectors into reusable access scopes.', { exact: true })
    ).toBeVisible({ timeout: 20_000 })
    await expectPersistentSidebar()
    await screenshotAndLog(page, testInfo, 'control-ui-navigation-contexts')

    // 3) Connectors — sidebar href is /connectors (rewritten from /mcp-servers);
    //    the browser URL stays /connectors.
    await mainNav.getByRole('link', { name: 'Installed Connectors', exact: true }).click()
    await expect(page).toHaveURL(/\/connectors\/?$/, { timeout: 20_000 })
    await expect(
      page.getByText('Browse connector deployments and context bindings.', { exact: true })
    ).toBeVisible({ timeout: 20_000 })
    await expectPersistentSidebar()
    await screenshotAndLog(page, testInfo, 'control-ui-navigation-connectors')

    // 4) External Channels — sidebar href is /external-channels (rewritten from
    //    /communication-channels); the browser URL stays /external-channels.
    await mainNav.getByRole('link', { name: 'External Channels', exact: true }).click()
    await expect(page).toHaveURL(/\/external-channels$/, { timeout: 20_000 })
    await expect(
      page.getByText('Route channel messages to the selected agent.', { exact: true })
    ).toBeVisible({ timeout: 20_000 })
    await expectPersistentSidebar()
    await screenshotAndLog(page, testInfo, 'control-ui-navigation-external-channels')

    // 5) LLM Models — Catalog and Discovery Review share one tabbed operator
    //    surface, so the sidebar uses one direct link.
    await mainNav.getByRole('link', { name: 'LLM Models', exact: true }).click()
    await expect(page).toHaveURL(/\/llm-models/, { timeout: 20_000 })
    // The subtitle is long; anchor on a unique leading substring.
    await expect(
      page.getByText('The authoritative allowlist of manual and discovered models')
    ).toBeVisible({ timeout: 20_000 })
    await expectPersistentSidebar()
    await screenshotAndLog(page, testInfo, 'control-ui-navigation-llm-models')

    // 6) Users & Teams — sidebar href is /users-and-teams/users (rewritten from
    //    /profile-admin/users); the browser URL stays /users-and-teams/users.
    await mainNav.getByRole('link', { name: 'Users & Teams', exact: true }).click()
    await expect(page).toHaveURL(/\/users-and-teams\/users$/, { timeout: 20_000 })
    await expect(
      page.getByText(
        'Members and teams grant Desktop App access. Admins grant Control UI access.',
        { exact: true }
      )
    ).toBeVisible({ timeout: 20_000 })
    await expectPersistentSidebar()
    await screenshotAndLog(page, testInfo, 'control-ui-navigation-users-teams')

    // 7) Settings — rendered in the sidebar FOOTER (outside 'Main sections').
    //    Sidebar href is /settings/ui (rewritten from /settings); the browser
    //    URL stays /settings/ui. Target the link globally since it is not in the
    //    mainNav region.
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    await expect(page).toHaveURL(/\/settings\/ui/, { timeout: 20_000 })
    await expect(page.getByText('Manage your Control UI admin account and theme.')).toBeVisible({
      timeout: 20_000,
    })
    await expectPersistentSidebar()
    await screenshotAndLog(page, testInfo, 'control-ui-navigation-settings')
  })
})
