/**
 * Codex subscription — on-demand catalog re-sync from the grant modal.
 *
 * Scope note, so the next reader does not look here for a claim this lane
 * cannot carry. The catalog upstream is frozen to chatgpt.com by
 * `codex-llm-proxy/src/originPolicy.ts` and this lane deploys no fake upstream,
 * so "a model published after the handshake becomes visible" is NOT provable
 * here. That claim lives one layer down, in
 * `codex-llm-proxy/test/runtimePath.hermetic.e2e.test.ts` ("hermetic catalog
 * re-read"), which is the only place that redirects the frozen origin at a
 * fixture, and one layer down again in
 * `control-api/test/services.subscriptionCatalogSyncCron.realPostgres.integration.test.ts`
 * for the rows and the union allowlist.
 *
 * What this lane uniquely proves: the affordance exists on a connected grant
 * and nowhere else, the click really issues the write, and the window settles
 * on the answer the API gave instead of leaving the operator with a spinner
 * and no verdict.
 *
 * Auth: `/` + loginControlUiVisible. No terminal `goto`. No test.skip.
 */
import { type Page, expect, test } from '@playwright/test'
import { controlApi } from '../helpers/api-client'
import { loginControlUiVisible } from '../helpers/visible-login'
import { ControlUiShell, SecretsLlmSubscriptionsPage } from '../pages/codex-subscription'

const SYNC_PATH =
  /\/api\/v1\/admin\/llm\/providers\/codex-subscription\/connections\/[^/]+\/catalog\/sync$/

// The closed set the route answers with (control-api/src/routes/admin/
// codexSubscription.ts:734-770). A status outside it means the contract moved
// and the mapping in CodexSubscriptionHub is stale, which is worth failing on
// even though the operator-visible outcome would still be "an error banner".
const DOCUMENTED_SYNC_STATUS = [200, 401, 403, 404, 409, 503]

async function loginFromHome(page: Page) {
  await page.goto('/')
  await loginControlUiVisible(page)
  await expect(page.getByLabel('Main navigation')).toBeVisible()
}

async function catalogRevisionOf(connectionKey: string): Promise<number> {
  const row = (await controlApi.listCodexConnections()).find(
    item => item.connectionKey === connectionKey
  )
  expect(row, `grant ${connectionKey} must still be listed`).toBeTruthy()
  return row!.catalogRevision
}

test.describe('Codex subscription catalog re-sync', () => {
  test('R1 Sync catalog issues the write and the modal settles on the API outcome', async ({
    page,
  }) => {
    const shell = new ControlUiShell(page)
    const hub = new SecretsLlmSubscriptionsPage(page)
    await loginFromHome(page)
    await shell.openSecretsLlmSubscriptions()

    const connected = (await controlApi.listCodexConnections()).find(
      row => row.status === 'connected'
    )
    expect(
      connected,
      'R1 named precondition: a connected grant provisioned by the profile lane'
    ).toBeTruthy()
    const grantKey = connected!.connectionKey
    const displayName = connected!.displayName || grantKey
    const revisionBefore = await catalogRevisionOf(grantKey)

    const modelsGet = page.waitForResponse(
      response =>
        new RegExp(
          `/api/v1/admin/llm/providers/codex-subscription/connections/${grantKey}/models$`
        ).test(new URL(response.url()).pathname) && response.request().method() === 'GET'
    )
    await hub.openGrant(displayName)
    await modelsGet

    const dialog = page.getByRole('dialog')
    const syncButton = dialog.getByRole('button', { name: 'Sync catalog' })
    await expect(syncButton).toBeVisible()
    await expect(syncButton).toBeEnabled()

    const syncPost = page.waitForResponse(
      response =>
        SYNC_PATH.test(new URL(response.url()).pathname) && response.request().method() === 'POST'
    )
    await syncButton.click()
    const syncRes = await syncPost
    expect(new URL(syncRes.url()).pathname).toBe(
      `/api/v1/admin/llm/providers/codex-subscription/connections/${grantKey}/catalog/sync`
    )
    expect(
      DOCUMENTED_SYNC_STATUS,
      `catalog sync answered ${syncRes.status()}, outside the documented set`
    ).toContain(syncRes.status())

    const successToast = page.getByRole('status').filter({ hasText: 'Catalog synced' })
    const errorBanner = dialog.locator('.cu-banner--error')

    if (syncRes.status() === 200) {
      const body = (await syncRes.json()) as { outcome?: string }
      // A recorded outcome always advances catalog_revision
      // (codexSubscriptionConnection.ts:692), so this is the business signal
      // that the write landed rather than the UI merely redrawing.
      expect(await catalogRevisionOf(grantKey)).toBeGreaterThan(revisionBefore)
      if (body.outcome === 'ready') {
        await expect(successToast).toBeVisible()
        await expect(errorBanner).toHaveCount(0)
      } else {
        await expect(
          page.getByRole('status').filter({ hasText: 'Catalog sync failed' })
        ).toBeVisible()
      }
    } else {
      // The operator must be told. An empty banner is the failure this guards:
      // the modal would otherwise look identical to a successful sync.
      await expect(errorBanner).toBeVisible()
      await expect(errorBanner).not.toHaveText('')
      await expect(successToast).toHaveCount(0)
    }

    // Whatever the outcome, the control comes back: a stuck busy state would
    // leave the operator unable to retry, and both branches above are
    // satisfied by a modal frozen mid-request.
    await expect(syncButton).toBeEnabled()
  })

  test('R2 a grant that is not connected offers no Sync catalog', async ({ page }) => {
    const shell = new ControlUiShell(page)
    const hub = new SecretsLlmSubscriptionsPage(page)
    const displayName = `e2e-resync-guard-${Date.now().toString(36)}`
    await loginFromHome(page)
    await shell.openSecretsLlmSubscriptions()

    const grantKey = await hub.createGrant(displayName)
    const dialog = page.getByRole('dialog')
    // Liveness witness for the negative below: this is the connect modal of a
    // real grant that exists and is not connected, not an empty dialog and not
    // an unrendered one.
    await expect(dialog.getByRole('button', { name: 'Sign in with ChatGPT' })).toBeVisible()
    const created = (await controlApi.listCodexConnections()).find(
      row => row.connectionKey === grantKey
    )
    expect(created, 'the grant under test must be listed').toBeTruthy()
    expect(created!.status).not.toBe('connected')

    await expect(dialog.getByRole('button', { name: 'Sync catalog' })).toHaveCount(0)

    await hub.closeConnectModal()
  })
})
