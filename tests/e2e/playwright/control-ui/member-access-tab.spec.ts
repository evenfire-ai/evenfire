/**
 * Control UI — Member detail Access tab tests
 *
 * The member "Access" tab (the former "Contexts" tab) must present host-backed
 * access scopes by their agent display name (spec.host), never by the raw wire
 * contextId, and the add/remove flows must round-trip the admin context API.
 */
import { controlApi } from '../helpers/api-client'
import { expect, test } from '../helpers/auth-fixture'

const RUN = Date.now()
const CONTEXT_NAME = `e2e-member-access-ctx-${RUN}`
const CONTEXT_ID = `e2e-member-access-scope-${RUN}`
const HOST_NAME = `e2e-member-access-host-${RUN}`
const HOST_DISPLAY_NAME = `e2e-member-access-agent-${RUN}`

let userId = ''
let originalContextIds: string[] = []

test.describe('Control UI — Member Access tab', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeAll(async () => {
    const { items } = await controlApi.getUsers('')
    if (items.length === 0) {
      test.skip(true, 'no users seeded — run: make minikube-seed-test-data')
      return
    }
    userId = items[0].id
    originalContextIds = (await controlApi.getUserContexts(userId)).contextIds ?? []

    await controlApi.createContext({
      metadata: { name: CONTEXT_NAME },
      spec: { contextId: CONTEXT_ID, description: 'E2E member access scope' },
    })
    await controlApi.createHost({
      metadata: { name: HOST_NAME },
      spec: {
        host: HOST_DISPLAY_NAME,
        contextRef: CONTEXT_ID,
        secretRef: '',
        channels: [],
        model: { provider: 'openai', name: 'gpt-5.4-mini' },
      },
    })
    await controlApi.updateUserContexts(userId, [...originalContextIds, CONTEXT_ID])
  })

  test.afterAll(async () => {
    if (userId) {
      try {
        await controlApi.updateUserContexts(userId, originalContextIds)
      } catch {
        // best effort restore — cluster may already be unreachable
      }
    }
    await controlApi.ensureHostDeleted(HOST_NAME)
    await controlApi.ensureContextDeleted(CONTEXT_NAME)
  })

  test('shows the agent display name, not the raw scope id', async ({ authedPage }) => {
    await authedPage.goto(`/users-and-teams/users/${encodeURIComponent(userId)}/access`)
    await expect(
      authedPage.getByText('Agents and connector scopes this member may access.')
    ).toBeVisible({ timeout: 15_000 })

    const row = authedPage
      .getByRole('row')
      .filter({ has: authedPage.getByRole('cell', { name: HOST_DISPLAY_NAME, exact: true }) })
    await expect(row).toHaveCount(1)
    await expect(row).not.toContainText(CONTEXT_ID)
  })

  test("'Add access' opens the access picker modal", async ({ authedPage }) => {
    await authedPage.goto(`/users-and-teams/users/${encodeURIComponent(userId)}/access`)
    await expect(
      authedPage.getByText('Agents and connector scopes this member may access.')
    ).toBeVisible({ timeout: 15_000 })

    await authedPage.getByRole('button', { name: 'Add access', exact: true }).click()

    const dialog = authedPage.getByRole('dialog', { name: 'Add access' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByLabel('Access')).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Add access', exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toHaveCount(0)
  })

  test('removing access confirms, toasts, and clears the mapping via the API', async ({
    authedPage,
  }) => {
    await authedPage.goto(`/users-and-teams/users/${encodeURIComponent(userId)}/access`)
    const row = authedPage
      .getByRole('row')
      .filter({ has: authedPage.getByRole('cell', { name: HOST_DISPLAY_NAME, exact: true }) })
    await expect(row).toBeVisible({ timeout: 15_000 })

    await row.getByLabel('Remove access').click()

    const confirmDialog = authedPage.getByRole('alertdialog', { name: 'Remove Access' })
    await expect(confirmDialog).toBeVisible()
    await confirmDialog.getByRole('button', { name: 'Remove access', exact: true }).click()

    await expect(authedPage.getByRole('status').filter({ hasText: 'Access updated.' })).toBeVisible(
      { timeout: 15_000 }
    )
    await expect(row).toHaveCount(0)
    if (originalContextIds.length === 0) {
      await expect(authedPage.getByText('No access assigned yet.')).toBeVisible()
    }

    const { contextIds } = await controlApi.getUserContexts(userId)
    expect(contextIds ?? []).not.toContain(CONTEXT_ID)
  })
})
