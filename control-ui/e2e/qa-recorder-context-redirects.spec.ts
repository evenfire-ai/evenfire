// control-ui/e2e/qa-recorder-context-redirects.spec.ts
//
// Optional QA recorder journey (MUTATING). Requires QA_RECORDER_CONFIRM_MUTATIONS=1.
// Video-tours the legacy /contexts link story now that the Contexts section is
// gone from the UI: the sidebar has no Contexts item, unknown legacy deep
// links land on the Agents list, and a seeded context's deep links resolve to
// the owning agent's Connectors tab. The throwaway context and host are
// deleted via the Control API in a finally (host before context).
//
// Contract: docs/testing/optional-playwright-qa-recorder.md ("Extending the recorder").
import { expect, test } from '@playwright/test'
import {
  CONTROL_API_URL,
  CONTROL_UI_URL,
  adminCredentials,
  api,
  assertAllowedTarget,
  loginThroughUi,
  requireRecorderConfirm,
  screenshotAndLog,
  uniqueE2EName,
} from './qa-recorder-helpers'

test.describe('optional QA recorder: Control UI context redirects', () => {
  test('optional QA recorder: Control UI context redirects journey', async ({ page }, testInfo) => {
    requireRecorderConfirm(
      'QA_RECORDER_CONFIRM_MUTATIONS',
      'This journey creates and deletes a throwaway context and host.'
    )
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    const contextName = uniqueE2EName('qa-ctx-redir')
    const hostName = uniqueE2EName('qa-ctx-redir-host')
    const unknownSlug = uniqueE2EName('qa-ctx-redir-unknown')

    try {
      await loginThroughUi(page, credentials)

      // (a) The sidebar must not offer a Contexts destination anymore.
      await expect(page.locator('.cu-sidebar__item', { hasText: 'Contexts' })).toHaveCount(0)
      await expect(
        page.getByRole('navigation', { name: 'Main sections' }).getByRole('link', {
          name: 'Contexts',
          exact: true,
        })
      ).toHaveCount(0)
      await screenshotAndLog(page, testInfo, 'context-redirects-sidebar')

      // (b) Bare /contexts redirects to the Agents list.
      await page.goto(`${CONTROL_UI_URL}/contexts`)
      await expect(page).toHaveURL(/\/agents\/?$/, { timeout: 20_000 })
      await expect(
        page.getByText('Manage available agents and their host mappings.', { exact: true })
      ).toBeVisible({ timeout: 20_000 })
      await screenshotAndLog(page, testInfo, 'context-redirects-legacy-root')

      // (c) The legacy create-page deep link also lands on the Agents list.
      await page.goto(`${CONTROL_UI_URL}/contexts/new`)
      await expect(page).toHaveURL(/\/agents\/?$/, { timeout: 20_000 })
      await screenshotAndLog(page, testInfo, 'context-redirects-legacy-new')

      // (d) An unknown context slug still resolves instead of dead-ending.
      await page.goto(`${CONTROL_UI_URL}/contexts/${encodeURIComponent(unknownSlug)}`)
      await expect(page).toHaveURL(/\/agents\/?$/, { timeout: 20_000 })
      await screenshotAndLog(page, testInfo, 'context-redirects-legacy-unknown')

      // (e) Seed a throwaway context + host so the legacy detail links have a
      // real owner to resolve to: the owning agent's Connectors tab.
      const ctxRes = await api(page.request, 'POST', '/api/v1/admin/contexts', {
        metadata: { name: contextName },
        spec: {
          contextId: contextName,
          description: 'QA recorder legacy-link redirect fixture',
          mcpServers: [],
        },
      })
      expect(ctxRes.status, `create context: ${JSON.stringify(ctxRes.data)}`).toBeLessThan(300)

      const hostRes = await api(page.request, 'POST', '/api/v1/admin/hosts', {
        metadata: { name: hostName },
        spec: {
          host: hostName,
          contextRef: contextName,
          secretRef: '',
          channels: [],
          model: { provider: 'openai', name: 'gpt-5.4-mini' },
        },
      })
      expect(hostRes.status, `create host: ${JSON.stringify(hostRes.data)}`).toBeLessThan(300)

      await page.goto(`${CONTROL_UI_URL}/contexts/${encodeURIComponent(contextName)}`)
      await expect(page).toHaveURL(new RegExp(`/agents/${hostName}/connectors/?$`), {
        timeout: 20_000,
      })
      await expect(page.getByText(`Agent: ${hostName}`)).toBeVisible({ timeout: 20_000 })
      await screenshotAndLog(page, testInfo, 'context-redirects-legacy-detail')

      // Deep link carrying a tab suffix resolves to the same destination.
      await page.goto(`${CONTROL_UI_URL}/contexts/${encodeURIComponent(contextName)}/connectors`)
      await expect(page).toHaveURL(new RegExp(`/agents/${hostName}/connectors/?$`), {
        timeout: 20_000,
      })
      await expect(page.getByText(`Agent: ${hostName}`)).toBeVisible({ timeout: 20_000 })
      await screenshotAndLog(page, testInfo, 'context-redirects-landed-connectors-tab')
    } finally {
      // Best-effort cleanup; the disposable environment tolerates leftovers.
      // Hosts must go before their contexts.
      try {
        await api(page.request, 'DELETE', `/api/v1/admin/hosts/${encodeURIComponent(hostName)}`)
        await api(
          page.request,
          'DELETE',
          `/api/v1/admin/contexts/${encodeURIComponent(contextName)}`
        )
      } catch {
        // Ignore cleanup failures.
      }
    }
  })
})
