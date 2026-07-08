import { type Page, expect, test } from '@playwright/test'

const BASE_UI = process.env.CONTROL_UI_URL || 'http://localhost:3000'
const ADMIN_USER = process.env.ADMIN_USER || 'admin'
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme123!'
const RECIPE_NAMESPACE = process.env.WORKFLOW_DETAIL_RECIPE_NAMESPACE || 'sandbox-recipes'
const RECIPE_NAME = process.env.WORKFLOW_DETAIL_RECIPE_NAME || 'due-diligence-package'
const RECIPE_TEMPLATE =
  process.env.WORKFLOW_DETAIL_RECIPE_TEMPLATE || 'Due Diligence Package (PDF+Excel)'

type WorkloadCounts = {
  panel: number
  tab: number
}

type DetailScrollMetrics = {
  cardBodyScrollers: string[]
  mainCanScroll: boolean
  mainOverflowY: string
  mainScrollTopAfter: number
  tableWrapScrollers: string[]
}

function workflowRecipesNav(page: Page) {
  return page.getByRole('button', { name: 'Workflow Recipes', exact: true })
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseCount(label: string, source: string): number {
  const match = source.match(/\((\d+)\)/)
  if (!match) throw new Error(`Could not parse ${label} count from: ${source}`)
  return Number(match[1])
}

function parseOptionalCount(source: string): number {
  const match = source.match(/\((\d+)\)/)
  return match ? Number(match[1]) : 0
}

async function login(page: Page) {
  await page.goto(BASE_UI)
  await expect(page.getByLabel('Username')).toBeVisible({ timeout: 20_000 })
  await page.getByLabel('Username').fill(ADMIN_USER)
  await page.getByLabel('Password').fill(ADMIN_PASS)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(workflowRecipesNav(page)).toBeVisible({
    timeout: 20_000,
  })
}

async function openRecipeDetailFromList(page: Page) {
  await workflowRecipesNav(page).click()
  await expect(page).toHaveURL(/\/workflow-recipes/)
  await expect(page.getByLabel('Search workflow recipes')).toBeVisible({ timeout: 20_000 })
  await page.getByLabel('Search workflow recipes').fill(RECIPE_NAME)

  const recipeLink = page.getByRole('link', { name: `Open ${RECIPE_NAME}` })
  await expect(recipeLink).toBeVisible({ timeout: 20_000 })
  await recipeLink.click()

  await expect(page).toHaveURL(
    new RegExp(
      `/workflow-recipes/${escapeRegExp(RECIPE_NAMESPACE)}/${escapeRegExp(RECIPE_NAME)}(?:\\?|$)`
    )
  )
  await expect(page.getByRole('heading', { name: RECIPE_NAME })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText(/Loading recipe/)).toBeHidden({ timeout: 120_000 })
  await expect(page.getByRole('tab', { name: /Workloads\s*\(\d+\)/ })).toBeVisible({
    timeout: 120_000,
  })
}

async function ensureRecipeInstalled(page: Page) {
  await workflowRecipesNav(page).click()
  await expect(page).toHaveURL(/\/workflow-recipes/)
  await expect(page.getByLabel('Search workflow recipes')).toBeVisible({ timeout: 20_000 })
  await page.getByLabel('Search workflow recipes').fill(RECIPE_NAME)

  const recipeLink = page.getByRole('link', { name: `Open ${RECIPE_NAME}` })
  await expect(
    recipeLink.or(page.getByText('No workflow recipes match this search.')).first()
  ).toBeVisible({ timeout: 20_000 })
  if (await recipeLink.isVisible()) return

  await page.getByRole('button', { name: 'Install Recipe' }).click()
  await expect(page.getByRole('heading', { name: 'Install Recipe' })).toBeVisible({
    timeout: 20_000,
  })

  await page.getByLabel('Load recipe template').selectOption(RECIPE_TEMPLATE)
  await expect(page.getByLabel('Recipe JSON (WorkflowRecipe manifest)')).toHaveValue(
    new RegExp(`"name"\\s*:\\s*"${escapeRegExp(RECIPE_NAME)}"`),
    { timeout: 20_000 }
  )

  await page.getByRole('button', { name: 'Review manifest' }).click()
  await expect(page.getByText(/Manifest review passed/)).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Apply defaults' }).click()
  await page.getByRole('button', { name: 'Continue to access' }).click()

  await expect(page.getByRole('button', { name: 'Deploy plugin' })).toBeEnabled({
    timeout: 20_000,
  })
  await page.getByRole('button', { name: 'Deploy plugin' }).click()
  await expect(page.getByLabel('Search workflow recipes')).toBeVisible({ timeout: 120_000 })
  await page.getByLabel('Search workflow recipes').fill(RECIPE_NAME)
  await expect(recipeLink).toBeVisible({ timeout: 120_000 })
}

async function readWorkloadCounts(page: Page): Promise<WorkloadCounts> {
  const tabText = (await page.getByRole('tab', { name: /Workloads/ }).innerText()).trim()
  const panelText = (
    await page
      .locator('.cu-table-panel__heading')
      .filter({ hasText: /Workloads\s*\(\d+\)/ })
      .first()
      .innerText()
  ).trim()

  return {
    panel: parseCount('Workloads panel', panelText),
    tab: parseCount('Workloads tab', tabText),
  }
}

async function ensureActiveWorkflowMonitor(page: Page) {
  const runsTab = page.getByRole('tab', { name: /Runs/ })
  await runsTab.click()
  await expect(page).toHaveURL(/[?&]tab=runs/)
  const hasExistingActiveMonitor = await expect
    .poll(
      async () => {
        const liveStatus = page.locator('#live-status')
        if ((await liveStatus.count()) === 0) return false
        if (!(await liveStatus.isVisible())) return false
        const phaseText = (await page.getByTestId('wf-execution-phase').innerText()).trim()
        return /pending|initializing|running|recovering/i.test(phaseText)
      },
      { timeout: 10_000 }
    )
    .toBe(true)
    .then(() => true)
    .catch(() => false)
  if (hasExistingActiveMonitor) return

  const runsBefore = parseOptionalCount((await runsTab.innerText()).trim())
  const runButton = page.getByRole('button', { name: /^Run/ })
  await expect(runButton).toBeVisible({ timeout: 20_000 })
  await expect(runButton).toBeEnabled({ timeout: 180_000 })
  await runButton.click()
  const dialog = page.getByRole('dialog', {
    name: new RegExp(`Run\\s+${escapeRegExp(RECIPE_NAME)}\\s+as operator`),
  })
  await expect(dialog).toBeVisible({ timeout: 20_000 })
  await dialog.getByRole('button', { name: 'Run as operator' }).click()
  await expect(dialog).toBeHidden({ timeout: 30_000 })
  await expect
    .poll(async () => parseOptionalCount((await runsTab.innerText()).trim()), {
      timeout: 60_000,
    })
    .toBeGreaterThan(runsBefore)

  await expect(page).toHaveURL(/[?&]tab=runs/)
  await expect(page.locator('#live-status')).toBeVisible({ timeout: 120_000 })
  await expect(page.getByText('Workflow Execution')).toBeVisible({ timeout: 120_000 })
  await expect(page.getByTestId('wf-execution-phase')).toHaveText(
    /pending|initializing|running|recovering/i,
    { timeout: 120_000 }
  )
}

async function readDetailScrollMetrics(page: Page): Promise<DetailScrollMetrics> {
  return page.evaluate(() => {
    const main = document.querySelector('.cu-main.cu-detail-layout') as HTMLElement | null
    if (!main) throw new Error('Missing detail layout main container')

    main.scrollTop = 0
    main.scrollTop = 360

    const isVerticalScroller = (node: HTMLElement) => {
      const style = window.getComputedStyle(node)
      return /auto|scroll/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1
    }

    const cardBodyScrollers = Array.from(
      document.querySelectorAll('.cu-main.cu-detail-layout .cu-card > .cu-card__body')
    )
      .filter((node): node is HTMLElement => node instanceof HTMLElement)
      .filter(isVerticalScroller)
      .map(node => node.className)

    const tableWrapScrollers = Array.from(
      document.querySelectorAll('.cu-main.cu-detail-layout .cu-card > .cu-table-wrap')
    )
      .filter((node): node is HTMLElement => node instanceof HTMLElement)
      .filter(isVerticalScroller)
      .map(node => node.className)

    return {
      cardBodyScrollers,
      mainCanScroll: main.scrollHeight > main.clientHeight + 1,
      mainOverflowY: window.getComputedStyle(main).overflowY,
      mainScrollTopAfter: main.scrollTop,
      tableWrapScrollers,
    }
  })
}

async function assertDetailPageOwnsVerticalScroll(page: Page) {
  await expect
    .poll(
      async () => {
        const metrics = await readDetailScrollMetrics(page)
        return (
          /auto|scroll/.test(metrics.mainOverflowY) &&
          metrics.mainCanScroll &&
          metrics.mainScrollTopAfter > 0 &&
          metrics.cardBodyScrollers.length === 0 &&
          metrics.tableWrapScrollers.length === 0
        )
      },
      { timeout: 120_000 }
    )
    .toBe(true)

  const metrics = await readDetailScrollMetrics(page)

  expect(metrics.mainOverflowY).toMatch(/auto|scroll/)
  expect(metrics.mainCanScroll).toBe(true)
  expect(metrics.mainScrollTopAfter).toBeGreaterThan(0)
  expect(metrics.cardBodyScrollers).toEqual([])
  expect(metrics.tableWrapScrollers).toEqual([])
}

test.describe('Workflow detail layout and live run monitor', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 640 })
    await login(page)
    await ensureRecipeInstalled(page)
    await openRecipeDetailFromList(page)
  })

  test('keeps the Workloads tab count aligned with the rendered workloads panel', async ({
    page,
  }) => {
    await page.getByRole('tab', { name: /Workloads/ }).click()
    await expect(
      page
        .locator('.cu-table-panel__heading')
        .filter({ hasText: /Workloads\s*\(\d+\)/ })
        .first()
    ).toBeVisible({ timeout: 20_000 })

    await expect
      .poll(
        async () => {
          const counts = await readWorkloadCounts(page)
          return counts.tab === counts.panel && counts.panel > 0
        },
        { timeout: 60_000 }
      )
      .toBe(true)

    const counts = await readWorkloadCounts(page)
    expect(counts.tab).toBe(counts.panel)
  })

  test('keeps the recipe action menu inside the viewport at compact desktop widths', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 904, height: 420 })
    await page.getByRole('button', { name: 'More plugin actions' }).click()

    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Edit' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Uninstall' })).toBeVisible()

    const rect = await menu.evaluate(node => {
      const box = node.getBoundingClientRect()
      return {
        bottom: box.bottom,
        left: box.left,
        right: box.right,
        top: box.top,
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
      }
    })

    expect(rect.left).toBeGreaterThanOrEqual(0)
    expect(rect.right).toBeLessThanOrEqual(rect.viewportWidth)
    expect(rect.top).toBeGreaterThanOrEqual(0)
    expect(rect.bottom).toBeLessThanOrEqual(rect.viewportHeight)
  })

  test('keeps edit mode scrollable for existing workflow recipes', async ({ page }) => {
    await page.setViewportSize({ width: 904, height: 420 })
    await page.getByRole('button', { name: 'More plugin actions' }).click()
    await page.getByRole('menuitem', { name: 'Edit' }).click()

    await expect(page).toHaveURL(/[?&]edit=1/)
    await expect(page.getByRole('heading', { name: `Edit Recipe: ${RECIPE_NAME}` })).toBeVisible({
      timeout: 20_000,
    })
    await assertDetailPageOwnsVerticalScroll(page)
    await expect(page.getByLabel('Recipe JSON (WorkflowRecipe manifest)')).toBeVisible()
  })

  test('keeps the install editor scrollable through validation and workflow access setup', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 904, height: 420 })
    await page.getByRole('button', { name: 'Back to recipes' }).click()
    await expect(page).toHaveURL(/\/workflow-recipes$/)
    await expect(page.getByLabel('Search workflow recipes')).toBeVisible({ timeout: 20_000 })

    await page.getByRole('button', { name: 'Install Recipe' }).click()
    await expect(page.getByRole('heading', { name: 'Install Recipe' })).toBeVisible({
      timeout: 20_000,
    })
    await assertDetailPageOwnsVerticalScroll(page)

    await page.getByLabel('Load recipe template').selectOption(RECIPE_TEMPLATE)
    await expect(page.getByLabel('Recipe JSON (WorkflowRecipe manifest)')).toHaveValue(
      new RegExp(`"name"\\s*:\\s*"${escapeRegExp(RECIPE_NAME)}"`),
      { timeout: 20_000 }
    )
    await page.getByRole('button', { name: 'Review manifest' }).click()
    await expect(page.getByText(/Manifest review passed/)).toBeVisible({ timeout: 20_000 })
    await page.getByRole('button', { name: 'Apply defaults' }).click()
    await page.getByRole('button', { name: 'Continue to access' }).click()

    const metrics = await readDetailScrollMetrics(page)
    expect(metrics.mainOverflowY).toMatch(/auto|scroll/)
    expect(metrics.mainCanScroll).toBe(true)
    expect(metrics.cardBodyScrollers).toEqual([])
    expect(metrics.tableWrapScrollers).toEqual([])
    await expect(page.getByTestId('workflow-access-panel')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole('button', { name: 'Deploy plugin' })).toBeVisible()
  })

  test('keeps active run monitoring scroll on the workflow detail page, not inside cards', async ({
    page,
  }) => {
    test.setTimeout(420_000)

    await ensureActiveWorkflowMonitor(page)
    await assertDetailPageOwnsVerticalScroll(page)

    const currentExecutionLink = page.getByRole('link', { name: 'Open current execution status' })
    if ((await currentExecutionLink.count()) > 0) {
      await currentExecutionLink.click()
      await expect(page).toHaveURL(/#live-status$/)
      await expect(page.locator('#live-status')).toBeFocused()
    }
  })
})
