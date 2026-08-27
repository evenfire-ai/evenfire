/**
 * Control UI — global "context" vocabulary sweep
 *
 * None of the surviving top-level sections may mention contexts in their
 * chrome or copy after the Contexts-section removal.
 *
 * Approach (chosen deliberately, one rule): every swept route renders through
 * DashboardLayout's <main>, so each page is asserted on its main-content text
 * (body as fallback). The single exception is /plugins, whose table rows show
 * user-authored recipe names we do not control — for that page only, the
 * assertion is scoped to product-owned static chrome (sidebar, panel titles,
 * subtitles, headings), which cannot be polluted by data-derived names.
 *
 * Lines containing "context window" (legitimate LLM copy) are allowed.
 */
import type { Page } from '@playwright/test'
import { expect, test } from '../helpers/auth-fixture'

const CONTEXT_WORD_RE = /\bcontexts?\b/i

const SWEPT_ROUTES = [
  '/agents',
  '/connectors',
  '/users-and-teams/users',
  '/users-and-teams/teams',
  '/marketplace/connectors',
  '/agent-files',
  '/cost-and-usage/token-budgets',
] as const

// Product-owned chrome for the /plugins exception (see header comment).
const STATIC_CHROME_SELECTOR = '.cu-sidebar, .cu-panel-title, .cu-table-panel__subtitle, h1, h2, h3'

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

for (const route of SWEPT_ROUTES) {
  test(`"${route}" shows no context vocabulary`, async ({ authedPage }) => {
    await authedPage.goto(route)
    await expect(authedPage.locator('main').first()).toBeVisible({ timeout: 15_000 })

    const text = await mainText(authedPage)
    const offending = offendingLines(text)
    expect(
      offending,
      `"${route}" must not use context vocabulary; offending lines: ${offending.join(' | ')}`
    ).toEqual([])
  })
}

test('"/plugins" static chrome shows no context vocabulary', async ({ authedPage }) => {
  await authedPage.goto('/plugins')
  await expect(authedPage.locator('main').first()).toBeVisible({ timeout: 15_000 })
  await expect(authedPage.locator('.cu-panel-title').first()).toBeVisible({ timeout: 15_000 })

  const chrome = authedPage.locator(STATIC_CHROME_SELECTOR)
  const count = await chrome.count()
  const texts: string[] = []
  for (let i = 0; i < count; i++) {
    texts.push(await chrome.nth(i).innerText())
  }

  const offending = offendingLines(texts.join('\n'))
  expect(
    offending,
    `"/plugins" chrome must not use context vocabulary; offending lines: ${offending.join(' | ')}`
  ).toEqual([])
})
