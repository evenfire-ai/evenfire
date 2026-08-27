// control-ui/e2e/qa-recorder-context-vocab-sweep.spec.ts
//
// Optional QA recorder journey (READ-ONLY): a video tour across the
// surviving top-level sections asserting none of them mention contexts in
// their chrome or copy after the Contexts-section removal. Ports the sweep
// from tests/e2e/playwright/control-ui/global-no-context-vocab.spec.ts, but
// navigates through the sidebar where an operator would (Users & Teams ->
// Teams tab, Cost & Usage group -> Token Budgets) and only falls back to a
// direct URL for /agent-files, which is hidden from the sidebar.
//
// Approach (one rule): every swept route renders through DashboardLayout's
// <main>, so each page is asserted on its main-content text (body as
// fallback). The single exception is /plugins, whose table rows show
// user-authored recipe names we do not control — for that page only, the
// assertion is scoped to product-owned static chrome (sidebar, panel
// subtitles, headings), which cannot be polluted by data-derived names.
//
// Lines containing "context window" (legitimate LLM copy) are allowed.
import { type Page, expect, test } from '@playwright/test'
import {
  CONTROL_API_URL,
  CONTROL_UI_URL,
  adminCredentials,
  assertAllowedTarget,
  loginThroughUi,
  screenshotAndLog,
} from './qa-recorder-helpers'

const CONTEXT_WORD_RE = /\bcontexts?\b/i

const SWEPT_ROUTES = {
  agents: '/agents',
  connectors: '/connectors',
  users: '/users-and-teams/users',
  teams: '/users-and-teams/teams',
  marketplace: '/marketplace/connectors',
  agentFiles: '/agent-files',
  tokenBudgets: '/cost-and-usage/token-budgets',
  plugins: '/plugins',
} as const

// Product-owned chrome for the /plugins exception (see header comment).
const STATIC_CHROME_SELECTOR = '.cu-sidebar, .cu-table-panel__subtitle, h1, h2, h3'

function offendingLines(text: string): string[] {
  return text
    .split('\n')
    .filter(line => CONTEXT_WORD_RE.test(line) && !/context window/i.test(line))
    .map(line => line.trim())
    .filter(Boolean)
}

async function mainText(page: Page): Promise<string> {
  const main = page.locator('main')
  if ((await main.count()) > 0) return main.first().innerText()
  return page.locator('body').innerText()
}

function screenshotName(route: string): string {
  return `control-ui-context-vocab-sweep${route.replace(/\//g, '-')}`
}

test.describe('optional QA recorder: Control UI context vocabulary sweep', () => {
  test('records a sidebar-driven tour with no context vocabulary', async ({ page }, testInfo) => {
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    await loginThroughUi(page, credentials)

    const mainNav = page.getByRole('navigation', { name: 'Main sections' })

    async function recordAndSweep(route: string): Promise<void> {
      await expect(page.locator('main').first()).toBeVisible({ timeout: 20_000 })
      await screenshotAndLog(page, testInfo, screenshotName(route))
      const text = await mainText(page)
      const offending = offendingLines(text)
      expect(
        offending,
        `"${route}" must not use context vocabulary; offending lines: ${offending.join(' | ')}`
      ).toEqual([])
    }

    // /agents — the sidebar href is rewritten to the /hosts page (the browser
    // URL is not stable across rewrites), so readiness is the page subtitle.
    await mainNav.getByRole('link', { name: 'Agents', exact: true }).click()
    await expect(
      page.getByText('Manage available agents and their host mappings.', { exact: true })
    ).toBeVisible({ timeout: 20_000 })
    await recordAndSweep(SWEPT_ROUTES.agents)

    // /connectors
    await mainNav.getByRole('link', { name: 'Installed Connectors', exact: true }).click()
    await expect(page).toHaveURL(/\/connectors\/?$/, { timeout: 20_000 })
    await expect(
      page.getByText('Browse connector deployments and agent access.', { exact: true })
    ).toBeVisible({ timeout: 20_000 })
    await recordAndSweep(SWEPT_ROUTES.connectors)

    // /users-and-teams/users
    await mainNav.getByRole('link', { name: 'Users & Teams', exact: true }).click()
    await expect(page).toHaveURL(/\/users-and-teams\/users$/, { timeout: 20_000 })
    await expect(
      page.getByText(
        'Members and teams grant Desktop App access. Admins grant Control UI access.',
        { exact: true }
      )
    ).toBeVisible({ timeout: 20_000 })
    await recordAndSweep(SWEPT_ROUTES.users)

    // /users-and-teams/teams — the Teams section is a tab on the Users page.
    const teamsTab = page.getByRole('tab', { name: 'Teams', exact: true })
    await expect(teamsTab).toBeEnabled({ timeout: 20_000 })
    await teamsTab.click()
    await expect(page).toHaveURL(/\/users-and-teams\/teams$/, { timeout: 20_000 })
    await recordAndSweep(SWEPT_ROUTES.teams)

    // /marketplace/connectors
    await mainNav.getByRole('link', { name: 'Marketplace', exact: true }).click()
    await expect(page).toHaveURL(/\/marketplace\/connectors$/, { timeout: 20_000 })
    await expect(
      page.getByText('Discover and install connectors from the Marketplace.')
    ).toBeVisible({ timeout: 20_000 })
    await recordAndSweep(SWEPT_ROUTES.marketplace)

    // /agent-files — hidden from the sidebar (the Files group's children do
    // not include it), so reach it the way a bookmarked link would.
    await page.goto(`${CONTROL_UI_URL}/agent-files`)
    await expect(
      page.getByText('Workspace volumes that agents can mount read-only into their pods.')
    ).toBeVisible({ timeout: 20_000 })
    await recordAndSweep(SWEPT_ROUTES.agentFiles)

    // /cost-and-usage/token-budgets — Cost & Usage is an expandable sidebar
    // group rendered as a <button>; expand it (guarded on aria-expanded),
    // then take the Token Budgets child link.
    const costToggle = page.getByRole('button', { name: 'Cost & Usage', exact: true })
    await expect(costToggle).toBeVisible({ timeout: 20_000 })
    if ((await costToggle.getAttribute('aria-expanded')) !== 'true') {
      await costToggle.click()
    }
    const tokenBudgetsLink = page.getByRole('link', { name: 'Token Budgets', exact: true })
    await expect(tokenBudgetsLink).toBeVisible({ timeout: 20_000 })
    await tokenBudgetsLink.click()
    await expect(page).toHaveURL(/\/cost-and-usage\/token-budgets/, { timeout: 20_000 })
    await recordAndSweep(SWEPT_ROUTES.tokenBudgets)

    // /plugins — rows show user-authored recipe names, so the sweep is scoped
    // to product-owned static chrome instead of the table rows.
    await mainNav.getByRole('link', { name: 'Installed Plugins', exact: true }).click()
    await expect(page).toHaveURL(/\/plugins\/?$/, { timeout: 20_000 })
    await expect(page.locator('main').first()).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.cu-panel-title').first()).toBeVisible({ timeout: 20_000 })
    await screenshotAndLog(page, testInfo, screenshotName(SWEPT_ROUTES.plugins))

    const chrome = page.locator(STATIC_CHROME_SELECTOR)
    const count = await chrome.count()
    const texts: string[] = []
    for (let i = 0; i < count; i += 1) {
      texts.push(await chrome.nth(i).innerText())
    }

    const chromeOffending = offendingLines(texts.join('\n'))
    expect(
      chromeOffending,
      `"${SWEPT_ROUTES.plugins}" chrome must not use context vocabulary; offending lines: ${chromeOffending.join(' | ')}`
    ).toEqual([])
  })
})
