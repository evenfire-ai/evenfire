import { type Page, expect, test } from '@playwright/test'
import {
  type GovernedTraceCostUiFixture,
  cleanupGovernedTraceCostUiFixture,
  seedGovernedTraceCostUiFixture,
} from '../../tests/e2e/governedTraceCostUiFixtures'

const BASE_UI = process.env.CONTROL_UI_URL || 'http://localhost:3000'
const ADMIN_USER = process.env.ADMIN_USER || 'admin'
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme123!'

async function loginControlUi(page: Page): Promise<void> {
  await page.goto(BASE_UI)
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible({ timeout: 15_000 })
  await page.getByLabel('Username or email').fill(ADMIN_USER)
  await page.getByLabel('Password').fill(ADMIN_PASS)
  await page.getByRole('button', { name: 'Sign in' }).last().click()
  await expect(page.getByRole('navigation', { name: 'Main sections' })).toBeVisible({
    timeout: 20_000,
  })

  const remindLater = page.getByRole('button', { name: 'Remind me later' })
  if (await remindLater.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await remindLater.click()
    await expect(remindLater).toBeHidden({ timeout: 10_000 })
  }
}

async function openInfrastructureCosts(
  page: Page,
  fixture: GovernedTraceCostUiFixture
): Promise<void> {
  await page.goto(`${BASE_UI}/traces`)
  await expect(page).toHaveURL(/\/traces$/)
  await expect(page.locator('.cu-panel-title').filter({ hasText: /^Run replay$/ })).toBeVisible()

  const scopeResponsePromise = page.waitForResponse(
    response =>
      response.request().method() === 'GET' &&
      response.url().includes('/api/v1/admin/tracing/costs/infrastructure/scopes')
  )
  await page.getByRole('link', { name: 'Infrastructure', exact: true }).click()
  const scopeResponse = await scopeResponsePromise
  expect(scopeResponse.status(), `${scopeResponse.url()} ${await scopeResponse.text()}`).toBe(200)
  await expect.poll(() => new URL(page.url()).pathname).toBe('/traces/infrastructure')
  await expect(
    page.locator('.cu-panel-title').filter({ hasText: /^Infrastructure telemetry$/ })
  ).toBeVisible()

  const workload = page.getByLabel('Workload *', { exact: true })
  await expect(workload).toBeEnabled()
  await expect(workload.getByRole('option', { name: fixture.workloadLabel })).toBeAttached()
  await workload.selectOption({ label: fixture.workloadLabel })
  const selectedWorkloadValue = await workload.inputValue()
  await page.getByLabel('Date').fill(fixture.anchorDate)
  await page.getByLabel('Cost view').selectOption('variance')

  await expect
    .poll(() => {
      const url = new URL(page.url())
      const scope = JSON.parse(url.searchParams.get('costScope') ?? '{}') as {
        workloadRef?: string
      }
      return {
        path: url.pathname,
        period: url.searchParams.get('costPeriod'),
        date: url.searchParams.get('costDate'),
        valuation: url.searchParams.get('costValuation'),
        workloadRef: scope.workloadRef,
      }
    })
    .toEqual({
      path: '/traces/infrastructure',
      period: 'day',
      date: fixture.anchorDate,
      valuation: 'variance',
      workloadRef: fixture.workloadRef,
    })

  const restoredScopeResponsePromise = page.waitForResponse(
    response =>
      response.request().method() === 'GET' &&
      response.url().includes('/api/v1/admin/tracing/costs/infrastructure/scopes')
  )
  await page.reload()
  expect((await restoredScopeResponsePromise).status()).toBe(200)
  await expect(page.getByLabel('Workload *', { exact: true })).toHaveValue(selectedWorkloadValue)
  await expect(page.getByLabel('Time range')).toHaveValue('day')
  await expect(page.getByLabel('Date')).toHaveValue(fixture.anchorDate)
  await expect(page.getByLabel('Cost view')).toHaveValue('variance')

  const costResponsePromise = page.waitForResponse(
    response =>
      response.request().method() === 'GET' &&
      response.url().includes('/api/v1/admin/tracing/costs/infrastructure?')
  )
  await page.getByRole('button', { name: 'View costs' }).click()
  const costResponse = await costResponsePromise
  expect(costResponse.status(), `${costResponse.url()} ${await costResponse.text()}`).toBe(200)
  const costBody = (await costResponse.json()) as {
    dimensions?: { workloadRef?: string }
    variance?: { netAmount?: string }
  }
  expect(costBody.dimensions?.workloadRef).toBe(fixture.workloadRef)
  expect(costBody.variance?.netAmount).toBe('0.050000000')

  await expect(page.getByRole('region', { name: 'Infrastructure cost results' })).toBeVisible()
  await expect(page.getByLabel('Estimated requested capacity cost summary')).toContainText(
    'Final / complete'
  )
  await expect(page.getByLabel('GCP billed cost summary')).toContainText('Final / complete')
  const comparisonChart = page.getByRole('img', { name: /Net cost comparison/ })
  await expect(comparisonChart).toBeVisible()
  const chartSurface = comparisonChart.getByRole('application')
  await expect(chartSurface).toBeVisible()
  await expect
    .poll(async () => {
      const box = await chartSurface.boundingBox()
      return box !== null && box.width >= 200 && box.height >= 100
    })
    .toBe(true)
  await expect(
    page.getByRole('region', { name: 'Historical cost run-rate forecast' })
  ).toBeVisible()
  await expect(page.getByText('pricing-export:e2e-fixture:cpu')).toBeVisible()
  await expect(page.getByText('kube:system-overhead')).toBeVisible()
}

test.describe('route-only Traces access', () => {
  test('hides Traces from navigation but preserves authenticated direct access', async ({
    page,
  }) => {
    await loginControlUi(page)
    const mainNavigation = page.getByRole('navigation', { name: 'Main sections' })

    await test.step('operator cannot discover or click Traces in main navigation', async () => {
      await expect(mainNavigation.getByRole('link', { name: 'Traces', exact: true })).toHaveCount(0)
      await expect(
        mainNavigation.getByRole('link', { name: 'Cost & Usage', exact: true })
      ).toBeVisible()
      await expect(
        mainNavigation.getByRole('link', { name: 'Settings', exact: true })
      ).toBeVisible()
    })

    await test.step('operator enters the Traces URL manually and the route still renders', async () => {
      await page.goto(`${BASE_UI}/traces`)
      await expect(page).toHaveURL(/\/traces$/)
      await expect(
        page.locator('.cu-panel-title').filter({ hasText: /^Run replay$/ })
      ).toBeVisible()
      await expect(mainNavigation.getByRole('link', { name: 'Traces', exact: true })).toHaveCount(0)
    })
  })
})

test.describe('governed trace infrastructure cost operator journey', () => {
  test.setTimeout(90_000)

  test('direct infrastructure trace access requires an authenticated operator', async ({
    page,
  }) => {
    await page.goto(`${BASE_UI}/traces/infrastructure`)
    await expect(page).toHaveURL(/\/?next=%2Ftraces%2Finfrastructure$/)
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
    await expect(page.getByText('Infrastructure telemetry', { exact: true })).toHaveCount(0)
  })

  test('operator compares provisioned and billed evidence with usable charts in both themes', async ({
    page,
  }) => {
    const fixture = seedGovernedTraceCostUiFixture()
    try {
      await test.step('operator logs in and reaches infrastructure tracing through its direct URL', async () => {
        await loginControlUi(page)
        await page.getByRole('link', { name: 'Settings', exact: true }).click()
        await expect(page).toHaveURL(/\/settings$/)
        await page.getByText('Dark', { exact: true }).click()
        await expect(page.getByRole('radio', { name: /Dark/ })).toBeChecked()
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
        await openInfrastructureCosts(page, fixture)
      })

      await test.step('operator reads limitations and least-privilege GCP setup guidance', async () => {
        await expect(page.getByText('Cost evidence limitations', { exact: true })).toBeVisible()
        await page.getByText('Connect GCP billing evidence', { exact: true }).click()
        await expect(page.getByText(/Do not grant Billing Account Viewer/)).toBeVisible()
        await expect(page.getByText(/public Cloud Billing Catalog\/Pricing API/)).toBeVisible()
        await expect(
          page.getByText(/Do not upload or store a service-account JSON key/)
        ).toBeVisible()
      })

      await test.step('operator switches to light mode through Settings and the chart remains usable', async () => {
        await page.getByRole('link', { name: 'Settings', exact: true }).click()
        await expect(page).toHaveURL(/\/settings$/)
        await page.getByText('Light', { exact: true }).click()
        await expect(page.getByRole('radio', { name: /Light/ })).toBeChecked()
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
        await openInfrastructureCosts(page, fixture)
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
      })
    } finally {
      cleanupGovernedTraceCostUiFixture(fixture.workloadRef)
    }
  })
})

test.describe('tracing operations operator journey', () => {
  test.setTimeout(90_000)

  test('direct tracing operations access requires an authenticated operator', async ({ page }) => {
    await page.goto(`${BASE_UI}/traces/operations`)
    await expect(page).toHaveURL(/\/?next=%2Ftraces%2Foperations$/)
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
    await expect(page.getByText('Tracing dashboard', { exact: true })).toHaveCount(0)
  })

  test('operator sees the real oversized tracing rejection prepared by the runtime gate', async ({
    page,
  }, testInfo) => {
    const expectedBodyLimitCount = Number(process.env.E2E_TRACING_BODY_TOO_LARGE_COUNT || '0')
    const requestStartedAt = Number(process.env.E2E_TRACING_BODY_TOO_LARGE_STARTED_AT_MS || '0')
    test.skip(
      !Number.isSafeInteger(expectedBodyLimitCount) ||
        expectedBodyLimitCount < 1 ||
        !Number.isSafeInteger(requestStartedAt) ||
        requestStartedAt < 1,
      'Run through scripts/e2e/e2e-governed-tracing-operations.sh to create runtime evidence.'
    )

    let snapshotCount = 0
    let snapshotTimestamp: string | null = null
    await test.step('operator signs in and reaches Dashboard through the direct tracing URL', async () => {
      await loginControlUi(page)
      await page.goto(`${BASE_UI}/traces`)
      await expect(page).toHaveURL(/\/traces$/)
      await expect(
        page.locator('.cu-panel-title').filter({ hasText: /^Run replay$/ })
      ).toBeVisible()

      const operationsResponsePromise = page.waitForResponse(
        response =>
          response.request().method() === 'GET' &&
          response.url().includes('/api/v1/admin/tracing/operations')
      )
      await page.getByRole('link', { name: 'Dashboard', exact: true }).click()
      const operationsResponse = await operationsResponsePromise
      expect(
        operationsResponse.status(),
        `${operationsResponse.url()} ${await operationsResponse.text()}`
      ).toBe(200)
      const snapshot = (await operationsResponse.json()) as {
        errors: Array<{
          reason: string
          countSinceRestart: number
          lastOccurredAt: string | null
        }>
      }
      const bodyError = snapshot.errors.find(error => error.reason === 'body_too_large')
      expect(bodyError).toBeDefined()
      snapshotCount = bodyError?.countSinceRestart ?? 0
      snapshotTimestamp = bodyError?.lastOccurredAt ?? null
      expect(snapshotCount).toBe(expectedBodyLimitCount)
      expect(snapshotTimestamp).not.toBeNull()
      expect(Date.parse(snapshotTimestamp ?? '')).toBeGreaterThanOrEqual(requestStartedAt)

      await expect(page).toHaveURL(/\/traces\/operations$/)
      await expect(
        page.locator('.cu-trace-ops-scope').getByText('Since control-api restart', { exact: true })
      ).toBeVisible()
      await expect(page.getByRole('group', { name: 'Tracing operations summary' })).toBeVisible()
      await expect(
        page.getByRole('img', { name: /^Current event processing outcomes:/ })
      ).toBeVisible()
      await expect(
        page.getByRole('img', { name: /^Current tracing pipeline pressure:/ })
      ).toBeVisible()
    })

    await test.step('snapshot and Control UI show the same bounded operator signal', async () => {
      await expect(page.getByText(/^Tracing health (healthy|warning|critical)$/i)).toBeVisible()
      await expect(page.getByText('Rejected requests', { exact: true })).toBeVisible()

      const row = page
        .getByRole('row')
        .filter({ hasText: 'Tracing request exceeded 512 KiB and was rejected.' })
      await expect(row).toBeVisible()
      await expect(row.getByText('body_too_large', { exact: true })).toBeVisible()
      await expect(row.locator('td[data-label="Count"]')).toHaveText(snapshotCount.toLocaleString())
      await expect(row).toContainText('512 KiB hard ceiling (not ENV-configurable)')
      await expect(row).toContainText('Effective value: 512 KiB')
      await expect(row.locator('td[data-label="Last occurrence"]')).not.toHaveText('Not recorded')
    })

    await test.step('operations remains legible in light, dark, and mobile layouts', async () => {
      await page.screenshot({
        path: testInfo.outputPath('tracing-operations-light.png'),
        fullPage: true,
      })

      await page.getByRole('link', { name: 'Settings', exact: true }).click()
      await page.getByText('Dark', { exact: true }).click()
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
      await page.goto(`${BASE_UI}/traces/operations`)
      await expect(
        page.getByRole('img', { name: /^Current event processing outcomes:/ })
      ).toBeVisible()
      await page.screenshot({
        path: testInfo.outputPath('tracing-operations-dark.png'),
        fullPage: true,
      })

      await page.setViewportSize({ width: 390, height: 844 })
      await expect(page.locator('.cu-sidebar')).not.toBeInViewport()
      await expect(page.getByRole('group', { name: 'Tracing operations summary' })).toBeVisible()
      const chartBounds = await page.locator('.cu-trace-ops-chart').evaluateAll(elements =>
        elements.map(element => {
          const rect = element.getBoundingClientRect()
          return { bottom: rect.bottom, top: rect.top }
        })
      )
      expect(chartBounds).toHaveLength(2)
      expect(chartBounds[1]!.top - chartBounds[0]!.bottom).toBeLessThan(32)
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
        )
      ).toBe(true)
      await page.screenshot({
        path: testInfo.outputPath('tracing-operations-mobile.png'),
        fullPage: true,
      })
    })
  })
})
