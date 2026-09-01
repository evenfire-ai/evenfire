/**
 * Control UI — Member Access tab shared-scope rows (D8)
 *
 * A single access scope (Context) may back multiple hosts. Under the D8
 * agent-centric Access tab the granted set is the member↔agent mapping UNION
 * legacy scope mappings resolved to their owning agents, so a scope shared by
 * two hosts renders as TWO table rows — one per agent display name — never a
 * joined "A, B" label and never the raw wire contextId. Revoking one agent
 * leaves the shared scope mapped for the other, so both rows remain until
 * the scope mapping itself is revoked.
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
// Pre-D8 the shared scope rendered one row with the owners joined by ", ";
// D8 renders one row per agent, so the joined label must never appear.
const JOINED_LABEL = `${HOST_DISPLAY_A}, ${HOST_DISPLAY_B}`

let userId = ''
let originalContextIds: string[] = []
let originalAgentNames: string[] = []

test.describe('Control UI — Member Access shared scope rows', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeAll(async () => {
    const { items } = await controlApi.getUsers('')
    if (items.length === 0) {
      test.skip(true, 'no users seeded — run: make minikube-seed-test-data')
      return
    }
    userId = items[0].id
    originalContextIds = (await controlApi.getUserContexts(userId)).contextIds ?? []
    originalAgentNames = (await controlApi.getUserAgents(userId)).agentNames ?? []

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
        // D8 composite write: the remove flow also rewrote the member↔agent
        // mapping, so restore the original agentNames too (PUT is
        // compare-and-swap: echo the full set we currently observe).
        const current = await controlApi.getUserAgents(userId)
        await controlApi.putUserAgents(userId, originalAgentNames, [
          ...(current.agentNames ?? []),
          ...(current.deletedAgentNames ?? []),
        ])
      } catch {
        // best effort restore — cluster may already be unreachable
      }
    }
    await controlApi.ensureHostDeleted(HOST_NAME_A)
    await controlApi.ensureHostDeleted(HOST_NAME_B)
    await controlApi.ensureContextDeleted(CONTEXT_NAME)
  })

  test('renders one row per owning agent, not a joined label or raw ids', async ({
    authedPage,
  }) => {
    await authedPage.goto(`/users-and-teams/users/${encodeURIComponent(userId)}/access`)
    await expect(
      authedPage.getByText('Agents this member may use — and the connectors each one carries.')
    ).toBeVisible({ timeout: 15_000 })

    // The legacy scope grant resolves to BOTH owning agents: two rows, each
    // labelled with its own agent display name.
    const rowA = authedPage
      .getByRole('row')
      .filter({ has: authedPage.getByRole('cell', { name: HOST_DISPLAY_A, exact: true }) })
    const rowB = authedPage
      .getByRole('row')
      .filter({ has: authedPage.getByRole('cell', { name: HOST_DISPLAY_B, exact: true }) })
    await expect(rowA).toHaveCount(1)
    await expect(rowB).toHaveCount(1)
    await expect(rowA).not.toContainText(CONTEXT_ID)
    await expect(rowB).not.toContainText(CONTEXT_ID)

    // The pre-D8 joined label never renders.
    await expect(authedPage.getByRole('cell', { name: JOINED_LABEL, exact: true })).toHaveCount(0)
  })

  test('remove confirm names the single agent; the shared scope keeps both rows', async ({
    authedPage,
  }) => {
    await authedPage.goto(`/users-and-teams/users/${encodeURIComponent(userId)}/access`)
    const rowA = authedPage
      .getByRole('row')
      .filter({ has: authedPage.getByRole('cell', { name: HOST_DISPLAY_A, exact: true }) })
    await expect(rowA).toBeVisible({ timeout: 15_000 })

    await rowA.getByLabel('Remove access').click()

    const confirmDialog = authedPage.getByRole('alertdialog', { name: 'Remove Access' })
    await expect(confirmDialog).toBeVisible()
    await expect(confirmDialog).toContainText(HOST_DISPLAY_A)
    await expect(confirmDialog).not.toContainText(JOINED_LABEL)
    await expect(confirmDialog).not.toContainText(CONTEXT_ID)
    await expect(confirmDialog).toContainText(
      'This revokes the agent and every connector it carries.'
    )

    await confirmDialog.getByRole('button', { name: 'Remove access', exact: true }).click()

    await expect(authedPage.getByRole('status').filter({ hasText: 'Access updated.' })).toBeVisible(
      { timeout: 15_000 }
    )

    // A's agent mapping is revoked, but the shared scope stays mapped for B
    // and the D8 union resolves it back to BOTH owners — both rows remain.
    await expect(rowA).toHaveCount(1)
    await expect(
      authedPage
        .getByRole('row')
        .filter({ has: authedPage.getByRole('cell', { name: HOST_DISPLAY_B, exact: true }) })
    ).toHaveCount(1)

    const { agentNames } = await controlApi.getUserAgents(userId)
    expect(agentNames ?? []).not.toContain(HOST_NAME_A)
    expect(agentNames ?? []).toContain(HOST_NAME_B)
    const { contextIds } = await controlApi.getUserContexts(userId)
    expect(contextIds ?? []).toContain(CONTEXT_ID)
  })
})
