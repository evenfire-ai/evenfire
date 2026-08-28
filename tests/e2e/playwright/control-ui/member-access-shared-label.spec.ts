/**
 * Control UI — Member Access tab shared-scope label
 *
 * A single access scope (Context) may back multiple hosts. The member
 * "Access" tab must render that shared scope as ONE row labelled with both
 * agent display names joined by ", " (lib/accessScopeLabels sorts the owner
 * names), never as two rows and never as the raw wire contextId. The remove
 * flow's confirm dialog repeats the same joined label.
 */
import { controlApi } from '../helpers/api-client'
import { expect, test } from '../helpers/auth-fixture'

const RUN = Date.now()
const CONTEXT_NAME = `e2e-member-shared-ctx-${RUN}`
const CONTEXT_ID = `e2e-member-shared-scope-${RUN}`
const HOST_NAME_A = `e2e-member-shared-host-a-${RUN}`
const HOST_NAME_B = `e2e-member-shared-host-b-${RUN}`
const HOST_DISPLAY_A = `e2e-member-shared-agent-a-${RUN}`
const HOST_DISPLAY_B = `e2e-member-shared-agent-b-${RUN}`
// accessScopeLabels joins the sorted owner names with ", " — the "a" agent
// sorts before the "b" agent, so the joined label is deterministic.
const JOINED_LABEL = `${HOST_DISPLAY_A}, ${HOST_DISPLAY_B}`

let userId = ''
let originalContextIds: string[] = []

test.describe('Control UI — Member Access shared scope label', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeAll(async () => {
    const { items } = await controlApi.getUsers('')
    if (items.length === 0) {
      test.skip(true, 'no users seeded — run: make minikube-seed-test-data')
      return
    }
    userId = items[0].id
    originalContextIds = (await controlApi.getUserContexts(userId)).contextIds ?? []

    // One scope shared by two hosts.
    await controlApi.createContext({
      metadata: { name: CONTEXT_NAME },
      spec: { contextId: CONTEXT_ID, description: 'E2E member shared access scope' },
    })
    for (const [hostName, hostDisplay] of [
      [HOST_NAME_A, HOST_DISPLAY_A],
      [HOST_NAME_B, HOST_DISPLAY_B],
    ] as const) {
      await controlApi.createHost({
        metadata: { name: hostName },
        spec: {
          host: hostDisplay,
          contextRef: CONTEXT_ID,
          secretRef: '',
          channels: [],
        },
      })
    }
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
    await controlApi.ensureHostDeleted(HOST_NAME_A)
    await controlApi.ensureHostDeleted(HOST_NAME_B)
    await controlApi.ensureContextDeleted(CONTEXT_NAME)
  })

  test('renders one row with the joined agent names, not two rows or raw ids', async ({
    authedPage,
  }) => {
    await authedPage.goto(`/users-and-teams/users/${encodeURIComponent(userId)}/access`)
    await expect(
      authedPage.getByText('Agents and connector scopes this member may access.')
    ).toBeVisible({ timeout: 15_000 })

    // Exactly one row carries the joined "A, B" label…
    const row = authedPage
      .getByRole('row')
      .filter({ has: authedPage.getByRole('cell', { name: JOINED_LABEL, exact: true }) })
    await expect(row).toHaveCount(1)
    await expect(row).not.toContainText(CONTEXT_ID)

    // …and neither agent appears as its own row (shared scope, not two scopes).
    await expect(authedPage.getByRole('cell', { name: HOST_DISPLAY_A, exact: true })).toHaveCount(0)
    await expect(authedPage.getByRole('cell', { name: HOST_DISPLAY_B, exact: true })).toHaveCount(0)
  })

  test('remove confirm dialog shows the joined label', async ({ authedPage }) => {
    await authedPage.goto(`/users-and-teams/users/${encodeURIComponent(userId)}/access`)
    const row = authedPage
      .getByRole('row')
      .filter({ has: authedPage.getByRole('cell', { name: JOINED_LABEL, exact: true }) })
    await expect(row).toBeVisible({ timeout: 15_000 })

    await row.getByLabel('Remove access').click()

    const confirmDialog = authedPage.getByRole('alertdialog', { name: 'Remove Access' })
    await expect(confirmDialog).toBeVisible()
    await expect(confirmDialog).toContainText(JOINED_LABEL)
    await expect(confirmDialog).not.toContainText(CONTEXT_ID)

    await confirmDialog.getByRole('button', { name: 'Remove access', exact: true }).click()

    await expect(authedPage.getByRole('status').filter({ hasText: 'Access updated.' })).toBeVisible(
      { timeout: 15_000 }
    )
    await expect(row).toHaveCount(0)

    const { contextIds } = await controlApi.getUserContexts(userId)
    expect(contextIds ?? []).not.toContain(CONTEXT_ID)
  })
})
