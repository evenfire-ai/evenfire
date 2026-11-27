import { expect, test } from '@playwright/test'
import { CONTROL_ROUTES } from '../app/constants/routes'

// Hermetic inventory: all API requests are intercepted, including mutations.
// Run with playwright.qa-recorder.config.ts against a local Control UI server.
test('distinguishes installed instances on hover, keyboard focus, and touch', async ({
  browser,
}) => {
  for (const touch of [false, true]) {
    const context = await browser.newContext({
      baseURL: test.info().project.use.baseURL,
      hasTouch: touch,
      isMobile: touch,
      viewport: touch ? { width: 390, height: 844 } : { width: 1280, height: 720 },
    })
    try {
      const page = await context.newPage()
      await page.route('**/control-api/**', async route => {
        const pathname = new URL(route.request().url()).pathname
        let body: unknown = { items: [], data: [] }
        if (pathname.endsWith('/auth/me')) {
          body = { me: { id: 'fixture-admin', username: 'Fixture admin', role: 'admin' } }
        } else if (pathname.endsWith('/admin/mcp-servers')) {
          body = {
            items: ['airtable-sales', 'airtable-research'].map(name => ({
              metadata: {
                name,
                namespace: 'mcp-server',
                annotations: { 'clerum.io/catalog-id': '@evenfire/mcp-airtable' },
              },
              spec: { managed: true, enabled: true },
            })),
          }
        }
        await route.fulfill({ json: body })
      })
      await page.goto(CONTROL_ROUTES.connectors.root)
      await expect(page.getByText('Airtable', { exact: true })).toHaveCount(2)
      for (const name of ['airtable-sales', 'airtable-research']) {
        const identity = page.locator('.cu-connector-identity__instance', { hasText: name })
        const row = page.locator('tbody tr').filter({ has: identity })
        if (touch) {
          // Visible before any tap: touching a navigable row must still open it.
          await expect(identity).toBeVisible()
        } else {
          await page.mouse.move(0, 0)
          await expect(identity).toBeHidden()
          await row.hover()
          await expect(identity).toBeVisible()
          await page.mouse.move(0, 0)
          await expect(identity).toBeHidden()
          // Reach the row using actual Tab navigation, with no extra identity tab stop.
          for (
            let i = 0;
            i < 30 && !(await row.evaluate(el => el === document.activeElement));
            i++
          ) {
            await page.keyboard.press('Tab')
          }
          await expect(row).toBeFocused()
          await expect(identity).toBeVisible()
        }
      }
      await expect(page.getByRole('columnheader', { name: 'Instance', exact: true })).toHaveCount(0)
    } finally {
      await context.close()
    }
  }
})
