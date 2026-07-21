/**
 * E2E - GFS operator journey
 *
 * Setup creates isolated fixtures. Grant behavior is exercised through visible
 * Control UI login, navigation, resource selection, confirmation, and persisted
 * business signals.
 */
import { expect, test } from '@playwright/test'
import {
  assertGfsFixtureCleaned,
  cleanupGfsFixture,
  seedGfsDirectoryFixture,
  uniqueGfsFixtureName,
} from '../../tests/e2e/gfsUiFixtures'
import { exerciseGfsBulkOperatorJourney } from './support/gfs-bulk-operator-journey.test'
import { loginControlUi, openGlobalFileSystemFromSidebar } from './support/gfs-control-ui-session'

test.describe('GFS operator journey', () => {
  test.setTimeout(600_000)

  test('authenticated operator reaches Global File System without a 401 logout redirect', async ({
    page,
  }) => {
    const fixtureName = uniqueGfsFixtureName('e2e-gfs-auth')

    try {
      const fixture = seedGfsDirectoryFixture(fixtureName)
      await test.step('operator logs in through the visible Control UI form', async () => {
        await loginControlUi(page)
      })

      await test.step('operator opens Global File System from the sidebar and the GFS tree request is authorized', async () => {
        const treeResponsePromise = page.waitForResponse(
          response =>
            response.request().method() === 'GET' &&
            response.url().includes('/control-api/api/v1/gfs/tree')
        )
        await openGlobalFileSystemFromSidebar(page)
        const treeResponse = await treeResponsePromise
        expect(treeResponse.status(), `${treeResponse.url()} ${await treeResponse.text()}`).toBe(
          200
        )
      })

      await test.step('operator remains on the GFS page with the seeded folder visible', async () => {
        await expect(page).toHaveURL(/\/global-file-system(?:$|\?)/, { timeout: 15_000 })
        await expect(page).not.toHaveURL(/\?next=%2Fgfs/)
        await expect(page.getByRole('region', { name: 'Global File System browser' })).toBeVisible()
        await expect(
          page
            .getByRole('list', { name: 'Current folder resources' })
            .getByRole('button', { name: fixture.name, exact: true })
        ).toBeVisible({ timeout: 20_000 })
        await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0)
      })
    } finally {
      cleanupGfsFixture(fixtureName)
      assertGfsFixtureCleaned(fixtureName)
    }
  })

  test('operator grants folder access from Control UI using the cluster subject picker', async ({
    browserName,
    page,
  }) => {
    test.skip(
      browserName === 'firefox',
      'Full CRUD and delegation coverage runs in Chromium; Firefox runs the focused GFS auth-boundary journey.'
    )
    await exerciseGfsBulkOperatorJourney(page)
  })
})
