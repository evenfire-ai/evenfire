/**
 * Control UI — External Channels tab tests
 *
 * Validates the CommunicationChannels table which maps to
 * CommunicationChannel CRDs in the cluster.
 *
 * Flow: authedPage → GET /api/v1/admin/communication-channels
 *       → control-api → kubectl list CommunicationChannel CRDs
 *       → Playwright verifies UI matches CRD state
 */
import { expect, test } from '../helpers/auth-fixture'
import { CUI_DASHBOARD } from '../helpers/selectors'
import { adminSessionCookieHeader } from '../helpers/session-cookie'

const CONTROL_API_URL = process.env.CONTROL_API_URL ?? 'http://127.0.0.1:8090'

test.describe('Control UI — External Channels', () => {
  test.beforeEach(async ({ authedPage }) => {
    await expect(authedPage.locator(CUI_DASHBOARD.HEADING)).toBeVisible()
    await authedPage.click(CUI_DASHBOARD.TAB_CHANNELS)
    await expect(
      // Channel rows are plain <tr>s now; the per-row name button
      // (.cu-channel-table__name in CommunicationChannelsTable.tsx) is the
      // stable row marker. '.cu-channel-row' no longer exists.
      authedPage
        .locator('.cu-channel-table__name')
        .first()
        .or(authedPage.getByText('No resources found.'))
    ).toBeVisible({
      timeout: 15_000,
    })
  })

  test('External Channels tab loads without errors', async ({ authedPage }) => {
    const errorEl = authedPage.locator('.cu-banner--error')
    await expect(errorEl).toBeHidden()
  })

  test('CommunicationChannels tab does not show Create/Delete action buttons', async ({
    authedPage,
  }) => {
    // CommunicationChannelsTable has its own CRUD — check what's visible
    // The tab should NOT show the Hosts-specific create button
    await expect(authedPage.locator(CUI_DASHBOARD.CREATE_HOST_BUTTON)).toBeHidden()
  })

  test('shows the CommunicationChannel CRDs returned by the API', async ({ authedPage }) => {
    const res = await fetch(`${CONTROL_API_URL}/api/v1/admin/communication-channels`, {
      headers: adminSessionCookieHeader(),
    })
    const body = (await res.json()) as {
      items?: Array<{ metadata?: { name?: string } }>
    }
    const items = body.items ?? []

    if (items.length === 0) {
      await expect(authedPage.getByText('No resources found.')).toBeVisible()
      return
    }

    for (const item of items) {
      const name = item.metadata?.name
      if (!name) continue
      await expect(authedPage.getByRole('button', { name, exact: true }).first()).toBeVisible({
        timeout: 15_000,
      })
    }
  })

  test('channel count matches CRD count from API', async ({ authedPage }) => {
    const res = await fetch(`${CONTROL_API_URL}/api/v1/admin/communication-channels`, {
      headers: adminSessionCookieHeader(),
    })
    const body = (await res.json()) as { items?: unknown[] }
    const apiCount = body.items?.length ?? 0
    const rows = authedPage.locator('.cu-channel-table__name')

    await expect.poll(async () => rows.count()).toBe(apiCount)
  })
})
