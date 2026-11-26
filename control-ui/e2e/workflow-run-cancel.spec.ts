import { type Locator, type Page, expect, test } from '@playwright/test'

// Operator cancel of a run from the plugin runs table, against a live cluster.
//
// Required environment (the spec fails when one is unset; it has no defaults so
// that it carries no URL or credential literal):
// - CONTROL_UI_URL: the Control UI origin.
// - ADMIN_USER, ADMIN_PASS: a Control UI administrator.
// - WORKFLOW_CANCEL_RECIPE_NAMESPACE, WORKFLOW_CANCEL_RECIPE_NAME: an installed,
//   active workflow recipe with an on-demand trigger that allows operator runs
//   and whose run stays `Running` for well over 10 seconds, so the cancel lands
//   while the runtime is still executing (a `Pending` run without a child goes
//   straight to `Canceled` and never shows `Canceling`).

type CancelJourneyEnv = {
  baseUrl: string
  username: string
  password: string
  namespace: string
  recipeName: string
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} must be set for the workflow run cancel journey.`)
  return value
}

// Read inside the test, not at module scope, so `playwright test --list` works
// without the environment.
function journeyEnv(): CancelJourneyEnv {
  return {
    baseUrl: requiredEnv('CONTROL_UI_URL').replace(/\/+$/, ''),
    username: requiredEnv('ADMIN_USER'),
    password: requiredEnv('ADMIN_PASS'),
    namespace: requiredEnv('WORKFLOW_CANCEL_RECIPE_NAMESPACE'),
    recipeName: requiredEnv('WORKFLOW_CANCEL_RECIPE_NAME'),
  }
}

function runsTabPath(env: CancelJourneyEnv): string {
  return `/plugins/${encodeURIComponent(env.namespace)}/${encodeURIComponent(env.recipeName)}/runs`
}

async function login(page: Page, env: CancelJourneyEnv) {
  await page.goto(env.baseUrl)
  await expect(page.getByRole('button', { name: /^Sign in$/ })).toBeVisible({ timeout: 20_000 })
  await page.getByLabel('Username or email').fill(env.username)
  await page.getByLabel('Password').fill(env.password)
  await page.getByRole('button', { name: /^Sign in$/ }).click()
  await expect(page.getByRole('navigation', { name: 'Main sections' })).toBeVisible({
    timeout: 60_000,
  })
  const remindLater = page.getByRole('button', { name: 'Remind me later' })
  if (await remindLater.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await remindLater.click()
  }
}

async function openRunsTab(page: Page, env: CancelJourneyEnv) {
  await page.goto(`${env.baseUrl}${runsTabPath(env)}`)
  await expect(page.getByRole('heading', { name: env.recipeName })).toBeVisible({
    timeout: 60_000,
  })
  await expect(page.getByRole('tab', { name: /^Runs/ })).toHaveAttribute('aria-selected', 'true')
}

async function startOperatorRun(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Run…' }).click()
  const modal = page.getByRole('dialog', { name: /as operator/ })
  await expect(modal).toBeVisible()
  await modal.getByRole('button', { name: 'Run as operator' }).click()
  const started = page.getByText(/^Run started: [0-9a-f-]{36}\.$/)
  await expect(started).toBeVisible({ timeout: 60_000 })
  const match = (await started.innerText()).match(/^Run started: ([0-9a-f-]{36})\.$/)
  if (!match) throw new Error('The run-started toast did not carry a run id.')
  return match[1]
}

function runRow(page: Page, runId: string): Locator {
  return page.getByRole('link', { name: `Open run ${runId.slice(0, 8)}` })
}

function phaseCell(row: Locator): Locator {
  return row.locator('td').nth(1)
}

async function openRowActions(page: Page, runId: string): Promise<Locator> {
  await page.getByRole('button', { name: `Actions for run ${runId.slice(0, 8)}` }).click()
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  return menu
}

test.describe('workflow run cancel from the plugin runs table', () => {
  test('an operator cancels a running run and sees it reach Canceled', async ({ page }) => {
    test.setTimeout(600_000)
    const env = journeyEnv()

    await login(page, env)
    await openRunsTab(page, env)
    const runId = await startOperatorRun(page)

    const row = runRow(page, runId)
    await expect(row).toBeVisible({ timeout: 60_000 })
    // The table refreshes every 5 seconds while a run is pending or running.
    await expect(phaseCell(row)).toHaveText('Running', { timeout: 300_000 })

    const menu = await openRowActions(page, runId)
    await menu.getByRole('menuitem', { name: 'Cancel run' }).click()
    const confirm = page.getByRole('alertdialog', { name: `Cancel run ${runId.slice(0, 8)}?` })
    await expect(confirm).toBeVisible()
    await confirm.getByRole('button', { name: 'Cancel run' }).click()

    await expect(page.getByText(`Cancel requested for run ${runId.slice(0, 8)}.`)).toBeVisible()
    await expect(phaseCell(row)).toHaveText('Running · Canceling')
    // The runtime stops at its next signal poll (about 5 seconds), then reports.
    await expect(phaseCell(row)).toHaveText('Canceled', { timeout: 180_000 })

    // Opening the runs tab directly offers no cancel on the canceled run.
    await openRunsTab(page, env)
    const reloadedRow = runRow(page, runId)
    await expect(phaseCell(reloadedRow)).toHaveText('Canceled', { timeout: 60_000 })
    const reloadedMenu = await openRowActions(page, runId)
    await expect(reloadedMenu.getByRole('menuitem', { name: 'View details' })).toBeVisible()
    await expect(reloadedMenu.getByRole('menuitem', { name: 'Cancel run' })).toHaveCount(0)
  })
})
