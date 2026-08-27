/**
 * Control UI — Contexts section removal tests
 *
 * The /contexts section is gone from the UI; legacy deep links resolve
 * client-side to user-facing destinations instead of dead-ending.
 */
import { controlApi } from '../helpers/api-client'
import { expect, test } from '../helpers/auth-fixture'
import { CUI_DASHBOARD } from '../helpers/selectors'

const CONTROL_UI_URL = process.env.CONTROL_UI_URL ?? 'http://127.0.0.1:3000'

test.describe('Control UI — Contexts removal', () => {
  test.beforeEach(async ({ authedPage }) => {
    await expect(authedPage.locator(CUI_DASHBOARD.HEADING)).toBeVisible()
  })

  test('sidebar has no Contexts item', async ({ authedPage }) => {
    await expect(authedPage.locator('.cu-sidebar__item', { hasText: 'Contexts' })).toHaveCount(0)
  })

  test('/contexts redirects to the Agents list', async ({ authedPage }) => {
    // authedPage runs in a manual browser context without baseURL, so
    // navigation needs the absolute URL (see helpers/auth-fixture.ts).
    await authedPage.goto(`${CONTROL_UI_URL}/contexts`)
    await authedPage.waitForURL('**/agents', { timeout: 15_000 })
    expect(authedPage.url()).toContain('/agents')
    await expect(
      authedPage
        .locator('main')
        .getByText(/^Agents( \(\d+\))?$/)
        .first()
    ).toBeVisible({ timeout: 15_000 })
  })

  test('/contexts/<unknown-slug> redirects to the Agents list', async ({ authedPage }) => {
    await authedPage.goto(`${CONTROL_UI_URL}/contexts/nonexistent-slug-xyz`)
    await authedPage.waitForURL('**/agents', { timeout: 15_000 })
    expect(authedPage.url()).toContain('/agents')
    await expect(
      authedPage
        .locator('main')
        .getByText(/^Agents( \(\d+\))?$/)
        .first()
    ).toBeVisible({ timeout: 15_000 })
  })

  test('/contexts/<private-slug> resolves to the owning agent Connectors tab', async ({
    authedPage,
  }) => {
    const runId = Date.now()
    const ctxName = `e2e-pw-resolver-ctx-${runId}`
    const hostName = `e2e-pw-resolver-host-${runId}`
    try {
      await controlApi.ensureContextDeleted(ctxName)
      await controlApi.createContext({
        metadata: { name: ctxName },
        spec: { contextId: ctxName, description: 'contexts.spec.ts redirect fixture' },
      })
      await controlApi.ensureHostDeleted(hostName)
      await controlApi.createHost({
        metadata: { name: hostName },
        spec: {
          host: hostName,
          contextRef: ctxName,
          secretRef: '',
          channels: [],
          model: { provider: 'openai', name: 'gpt-5.4-mini' },
        },
      })

      await authedPage.goto(`${CONTROL_UI_URL}/contexts/${encodeURIComponent(ctxName)}`)
      await authedPage.waitForURL(`**/agents/${hostName}/connectors`, { timeout: 15_000 })
      expect(authedPage.url()).toContain(`/agents/${hostName}/connectors`)

      // Deep link carrying a tab suffix resolves to the same destination.
      await authedPage.goto(`${CONTROL_UI_URL}/contexts/${encodeURIComponent(ctxName)}/connectors`)
      await authedPage.waitForURL(`**/agents/${hostName}/connectors`, { timeout: 15_000 })
    } finally {
      await controlApi.ensureHostDeleted(hostName)
      await controlApi.ensureContextDeleted(ctxName)
    }
  })
})
