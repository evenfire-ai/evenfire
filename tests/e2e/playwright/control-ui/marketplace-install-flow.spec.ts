/**
 * Control UI — Marketplace install flow tests
 *
 * The connector install wizard is Package → Credentials → Install with no
 * context-selection step left anywhere: access is granted after install from
 * the Installed Connectors list. The install itself is never clicked here —
 * this spec must not mutate the cluster.
 */
import { expect, test } from '../helpers/auth-fixture'
import { adminSessionCookieHeader } from '../helpers/session-cookie'

const CONTROL_API_URL = process.env.CONTROL_API_URL ?? 'http://127.0.0.1:8090'

type RegistryEntrySummary = {
  name: string
  version: string
  entry_type: string
  server_mode?: string | null
}

async function fetchMcpEntries(): Promise<RegistryEntrySummary[]> {
  const res = await fetch(`${CONTROL_API_URL}/api/v1/admin/registry/entries`, {
    headers: adminSessionCookieHeader(),
  })
  if (!res.ok) {
    throw new Error(`GET /api/v1/admin/registry/entries → ${res.status}: ${await res.text()}`)
  }
  const payload = (await res.json()) as { data?: RegistryEntrySummary[] }
  return (payload.data ?? []).filter(entry => entry.entry_type === 'mcp-server')
}

test.describe('Control UI — Marketplace install flow', () => {
  test('connector install wizard walks Package → Credentials → Install with no context step', async ({
    authedPage,
  }) => {
    test.setTimeout(120_000)

    let entries: RegistryEntrySummary[] = []
    try {
      entries = await fetchMcpEntries()
    } catch {
      test.skip(true, 'registry API unavailable')
    }
    if (entries.length === 0) {
      test.skip(true, 'no registry entries deployed')
    }
    // Prefer a local connector: remote entries require egress before Continue.
    const entry = entries.find(item => item.server_mode === 'local') ?? entries[0]

    await authedPage.goto(
      `/marketplace/install?entry=${encodeURIComponent(entry.name)}&version=${encodeURIComponent(entry.version)}`
    )

    await expect(
      authedPage.getByRole('heading', { name: 'Install Connector from Marketplace' })
    ).toBeVisible({ timeout: 30_000 })

    // Step rail is exactly Package / Credentials / Install — no Context step.
    const rail = authedPage.locator('.cu-agent-step-rail')
    await expect(rail.locator('.cu-agent-step-rail__title')).toHaveText([
      'Package',
      'Credentials',
      'Install',
    ])
    await expect(rail.getByText(/context/i)).toHaveCount(0)
    await expect(authedPage.getByRole('button').filter({ hasText: /context/i })).toHaveCount(0)
    await expect(authedPage.locator('body')).not.toContainText(/Select a context|Context access/)

    // Package → Credentials
    const continueButton = authedPage.getByRole('button', { name: 'Continue', exact: true })
    await expect(continueButton).toBeEnabled({ timeout: 30_000 })
    await continueButton.click()
    await expect(rail.locator('.cu-agent-step-rail__item').nth(1)).toHaveAttribute(
      'data-state',
      'current'
    )
    await expect(authedPage.locator('body')).not.toContainText(/Select a context|Context access/)

    // Credentials → Install
    await expect(continueButton).toBeEnabled({ timeout: 30_000 })
    await continueButton.click()
    await expect(rail.locator('.cu-agent-step-rail__item').nth(2)).toHaveAttribute(
      'data-state',
      'current'
    )

    // Install summary names the connector; the button is armed but never clicked.
    const summary = authedPage.getByRole('region', { name: 'Install summary' })
    await expect(summary).toBeVisible({ timeout: 15_000 })
    await expect(summary).toContainText(entry.name)
    const installButton = authedPage.getByRole('button', { name: 'Install', exact: true })
    await expect(installButton).toBeEnabled({ timeout: 30_000 })
    await expect(authedPage.locator('body')).not.toContainText(/Select a context|Context access/)

    // Navigate away without installing.
    await authedPage.goto('/marketplace')
    await authedPage.waitForURL('**/marketplace/connectors', { timeout: 15_000 })
  })
})
