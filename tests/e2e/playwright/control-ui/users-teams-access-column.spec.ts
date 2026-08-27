/**
 * Control UI — Users and Teams Access column tests
 *
 * The Teams table exposes a sortable "Access" column (the former "Contexts"
 * count column) and neither the Teams nor the Users table keeps a "Contexts"
 * header anywhere.
 */
import { expect, test } from '../helpers/auth-fixture'

test.describe('Control UI — Users and Teams Access column', () => {
  test('Teams table has a sortable Access column and no Contexts header', async ({
    authedPage,
  }) => {
    await authedPage.goto('/users-and-teams/teams')

    const accessHeader = authedPage.getByRole('button', { name: /^Sort by access/ })
    await expect(accessHeader).toBeVisible({ timeout: 15_000 })
    // Let the skeleton table swap for real data before counting rows.
    await expect(authedPage.locator('.cu-skeleton')).toHaveCount(0, { timeout: 15_000 })
    await expect(authedPage.locator('th', { hasText: 'Contexts' })).toHaveCount(0)

    const rows = authedPage.getByRole('row')
    const rowCountBefore = await rows.count()

    // First click: inactive → descending (aria-label announces the next direction)
    await accessHeader.click()
    await expect(accessHeader).toHaveAttribute('aria-label', 'Sort by access ascending')
    const rowCountAfterFirst = await rows.count()
    expect(rowCountAfterFirst).toBe(rowCountBefore)

    // Second click: descending → ascending
    await accessHeader.click()
    await expect(accessHeader).toHaveAttribute('aria-label', 'Sort by access descending')
    const rowCountAfterSecond = await rows.count()
    expect(rowCountAfterSecond).toBe(rowCountBefore)
  })

  test('Users table has no Contexts header', async ({ authedPage }) => {
    await authedPage.goto('/users-and-teams/users')

    await expect(authedPage.locator('th', { hasText: 'Name' }).first()).toBeVisible({
      timeout: 15_000,
    })
    await expect(authedPage.locator('th', { hasText: 'Contexts' })).toHaveCount(0)
  })
})
