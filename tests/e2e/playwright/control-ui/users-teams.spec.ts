/**
 * Control UI — Users and Teams tab tests
 *
 * Validates the profile-admin section: teams list, users list, search, navigation.
 */
import { E2E_TEST_EMAIL } from '../../testUser.js'
import { controlApi } from '../helpers/api-client'
import { expect, test } from '../helpers/auth-fixture'
import { CUI_DASHBOARD, CUI_USERS_TEAMS } from '../helpers/selectors'

const TEST_USER_EMAIL = E2E_TEST_EMAIL

test.describe('Control UI — Users and Teams', () => {
  test.beforeEach(async ({ authedPage }) => {
    await expect(authedPage.locator(CUI_DASHBOARD.HEADING)).toBeVisible()
    await authedPage.click(CUI_DASHBOARD.TAB_USERS_TEAMS)
    await expect(authedPage.locator(CUI_USERS_TEAMS.SECTION_HEADING)).toBeVisible()
  })

  test("shows 'Members and Teams' section heading", async ({ authedPage }) => {
    await expect(authedPage.locator(CUI_USERS_TEAMS.SECTION_HEADING)).toBeVisible()
  })

  test('Teams sub-tab is active by default', async ({ authedPage }) => {
    const table = authedPage.locator(CUI_USERS_TEAMS.TEAM_TABLE)
    await expect(table).toBeVisible({ timeout: 15_000 })
    await expect(authedPage.locator('th:text-is("Team name")')).toBeVisible()
  })

  test('Create Team button is visible on Teams tab', async ({ authedPage }) => {
    await expect(authedPage.locator(CUI_USERS_TEAMS.CREATE_TEAM_BUTTON)).toBeVisible()
  })

  test('clicking Create Team opens inline creation form', async ({ authedPage }) => {
    await authedPage.click(CUI_USERS_TEAMS.CREATE_TEAM_BUTTON)
    await expect(authedPage.locator('input[placeholder="Team name"]')).toBeVisible({
      timeout: 5_000,
    })
  })

  test('switching to Users tab shows users table', async ({ authedPage }) => {
    await authedPage.click(CUI_USERS_TEAMS.USERS_TAB)
    const table = authedPage.locator(CUI_USERS_TEAMS.USER_TABLE)
    await expect(table).toBeVisible({ timeout: 15_000 })
    // Use :text-is() for exact match — avoids "Display Name" matching "Name" substring
    await expect(authedPage.locator('th:text-is("Name")')).toBeVisible()
    await expect(authedPage.locator('th:text-is("Email")')).toBeVisible()
  })

  test('search input is visible on Members tab', async ({ authedPage }) => {
    await authedPage.click(CUI_USERS_TEAMS.USERS_TAB)
    await expect(authedPage.locator(CUI_USERS_TEAMS.SEARCH_INPUT)).toBeVisible({ timeout: 10_000 })
  })

  test('searching for test user shows results', async ({ authedPage }) => {
    // Check via API if test user is seeded before touching UI
    const { items } = await controlApi.getUsers(TEST_USER_EMAIL)
    if (items.length === 0) {
      test.skip() // User not seeded — run: make minikube-seed-test-data
      return
    }

    await authedPage.click(CUI_USERS_TEAMS.USERS_TAB)
    await authedPage.locator(CUI_USERS_TEAMS.SEARCH_INPUT).waitFor({ state: 'visible' })
    await authedPage.fill(CUI_USERS_TEAMS.SEARCH_INPUT, TEST_USER_EMAIL)

    // Wait for API response and re-render
    await expect(authedPage.getByRole('cell', { name: TEST_USER_EMAIL, exact: true })).toBeVisible({
      timeout: 15_000,
    })
  })

  test('clicking a user name navigates to user detail', async ({ authedPage }) => {
    const { items } = await controlApi.getUsers(TEST_USER_EMAIL)
    if (items.length === 0) {
      test.skip()
      return
    }

    await authedPage.click(CUI_USERS_TEAMS.USERS_TAB)
    await authedPage.locator(CUI_USERS_TEAMS.SEARCH_INPUT).waitFor({ state: 'visible' })
    await authedPage.fill(CUI_USERS_TEAMS.SEARCH_INPUT, TEST_USER_EMAIL)

    const emailCell = authedPage.getByRole('cell', { name: TEST_USER_EMAIL, exact: true })
    await expect(emailCell).toBeVisible({ timeout: 15_000 })

    const row = authedPage.getByRole('row').filter({ has: emailCell }).first()
    await row.locator('td:first-child .cu-link').click()
    await authedPage.waitForURL('**/profile-admin/users/**', { timeout: 10_000 })
    expect(authedPage.url()).toMatch(/\/profile-admin\/users\/.+/)
  })
})
