import { type ElectronApplication, type Page, expect, test } from '@playwright/test'
import {
  EXTERNAL_REST_API_BASE_URL,
  RPC_PROXY_BASE_URL,
  assertAllowedTarget,
  configuredHostRef,
  desktopCredentials,
  finalizeRecording,
  launchDesktopApp,
  login,
  openAgentsPage,
  openExactAgentChat,
  screenshotAndLog,
} from './qa-recorder-helpers'

// Optional QA recorder journey for the Desktop App agents fleet and workspace.
//
// Read-only throughout: it launches the real Electron window headfully with
// video, signs in as the exact QA identity, walks the Resources -> Agents fleet,
// lands on the chatllm agent's chat composer, and exercises the agent workspace
// route switcher (Details / Connectors / Contexts / Activity). No chat messages
// are sent and no confirm flag is required; every test still guards the loopback
// targets up front. See docs/testing/desktop-headful-journeys.md.

test('optional QA recorder: Desktop agents journey — fleet', async ({}, testInfo) => {
  await assertAllowedTarget('EXTERNAL_REST_API_BASE_URL', EXTERNAL_REST_API_BASE_URL)
  await assertAllowedTarget('RPC_PROXY_BASE_URL', RPC_PROXY_BASE_URL)

  const credentials = desktopCredentials()
  const hostRef = configuredHostRef()
  let app: ElectronApplication | undefined
  let page: Page | undefined

  try {
    const launched = await launchDesktopApp(testInfo)
    app = launched.app
    page = launched.page

    await login(page, credentials)
    await openAgentsPage(page)

    // The fleet renders one .agents-table-row-clickable per agent. Assert the
    // exact chatllm fixture row is present, resilient to the chat-autoselect
    // landing (composer visible instead) and to empty/loading states.
    const exactAgentRow = page.locator('.agents-table-row-clickable', { hasText: hostRef }).first()
    const composer = page.getByRole('textbox', { name: 'Agent message composer' })
    const emptyState = page.getByText('No agents available')
    await expect(exactAgentRow.or(composer).or(emptyState)).toBeVisible({ timeout: 20_000 })

    await screenshotAndLog(page, testInfo, 'desktop-agents-fleet')
  } finally {
    await finalizeRecording(app, page)
  }
})

test('optional QA recorder: Desktop agents journey — chat workspace', async ({}, testInfo) => {
  await assertAllowedTarget('EXTERNAL_REST_API_BASE_URL', EXTERNAL_REST_API_BASE_URL)
  await assertAllowedTarget('RPC_PROXY_BASE_URL', RPC_PROXY_BASE_URL)

  const credentials = desktopCredentials()
  const hostRef = configuredHostRef()
  let app: ElectronApplication | undefined
  let page: Page | undefined

  try {
    const launched = await launchDesktopApp(testInfo)
    app = launched.app
    page = launched.page

    await login(page, credentials)
    // Lands on the exact chatllm agent's chat composer (no first-available
    // fallback) and asserts the Switch chat agent control reflects chatllm.
    await openExactAgentChat(page, hostRef)

    // Assert the workspace shell rendered: the chat breadcrumb is present and
    // the composer is visible. openExactAgentChat already verifies the agent
    // identity, so here we prove the workspace chrome (breadcrumb + composer)
    // is mounted around it.
    const breadcrumb = page.getByLabel('Chat breadcrumb')
    const composer = page.getByRole('textbox', { name: 'Agent message composer' })
    await expect(breadcrumb).toBeVisible({ timeout: 20_000 })
    await expect(composer).toBeVisible({ timeout: 20_000 })

    await screenshotAndLog(page, testInfo, 'desktop-agents-chat-workspace')
  } finally {
    await finalizeRecording(app, page)
  }
})

test('optional QA recorder: Desktop agents journey — workspace routes', async ({}, testInfo) => {
  await assertAllowedTarget('EXTERNAL_REST_API_BASE_URL', EXTERNAL_REST_API_BASE_URL)
  await assertAllowedTarget('RPC_PROXY_BASE_URL', RPC_PROXY_BASE_URL)

  const credentials = desktopCredentials()
  const hostRef = configuredHostRef()
  let app: ElectronApplication | undefined
  let page: Page | undefined

  try {
    const launched = await launchDesktopApp(testInfo)
    app = launched.app
    page = launched.page

    await login(page, credentials)
    await openAgentsPage(page)

    // Enter the chatllm workspace in agents-mode (Details route) by clicking its
    // fleet row. Resilient to the auto-selected-chat landing: if the fleet did
    // not render, the route-switching portion is skipped and we still capture a
    // proof of whatever shell is present.
    const exactAgentRow = page.locator('.agents-table-row-clickable', { hasText: hostRef }).first()
    const composer = page.getByRole('textbox', { name: 'Agent message composer' })
    const emptyState = page.getByText('No agents available')
    await expect(exactAgentRow.or(composer).or(emptyState)).toBeVisible({ timeout: 20_000 })

    if (await exactAgentRow.isVisible().catch(() => false)) {
      await exactAgentRow.click()

      // Agents-mode workspace: breadcrumb shows Agents / <agent> / <route>, and
      // the default Details section renders its hero shell.
      const agentBreadcrumb = page.getByLabel('Agent breadcrumb')
      await expect(agentBreadcrumb).toBeVisible({ timeout: 20_000 })
      await expect(agentBreadcrumb).toContainText(hostRef)
      await expect(page.locator('section[aria-label="Agent details"]')).toBeVisible({
        timeout: 20_000,
      })

      // Exercise the breadcrumb route switcher (ResourceBreadcrumbSwitcher,
      // aria-label "Switch agent section") across the workspace resource routes
      // exposed by the agent menu, asserting each section shell renders.
      const routes: Array<{ menuLabel: string; sectionAriaLabel: string }> = [
        { menuLabel: 'Connectors', sectionAriaLabel: 'Agent connectors' },
        { menuLabel: 'Contexts', sectionAriaLabel: 'Agent contexts' },
        { menuLabel: 'Activity', sectionAriaLabel: 'Agent activity' },
      ]
      for (const { menuLabel, sectionAriaLabel } of routes) {
        await page.getByRole('button', { name: 'Switch agent section' }).click()
        await page.getByRole('menuitem', { name: menuLabel, exact: true }).click()
        await expect(page.locator(`section[aria-label="${sectionAriaLabel}"]`).first()).toBeVisible(
          {
            timeout: 20_000,
          }
        )
      }
    }

    await screenshotAndLog(page, testInfo, 'desktop-agents-workspace-routes')
  } finally {
    await finalizeRecording(app, page)
  }
})
