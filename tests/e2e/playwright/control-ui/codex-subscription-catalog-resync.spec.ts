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
 * and nowhere else, the click really issues the write, the write is RECORDED,
 * and the window settles on the answer the API gave instead of leaving the
 * operator with a spinner and no verdict.
 *
 * Its honest limit: control-api collapses "proxy admin URL unset", "proxy
 * unreachable" and "chatgpt.com answered badly" into the same
 * `503 / catalog_sync_failed / unavailable`, so no assertion at this lane's
 * HTTP surface can separate a vendor outage from a broken deployment. Those two
 * are deployment preconditions and are checked fail-closed by the lane runner
 * (`scripts/e2e/e2e-codex-subscription-playwright.sh`) BEFORE Playwright
 * starts, which is why the 503 branch below can stay green on `unavailable`.
 *
 * Auth: `/` + loginControlUiVisible. No terminal `goto`. No test.skip.
 */
import { type Page, expect, test } from '@playwright/test'
import { controlApi } from '../helpers/api-client'
import { loginControlUiVisible } from '../helpers/visible-login'
import { ControlUiShell, SecretsLlmSubscriptionsPage } from '../pages/codex-subscription'

const SYNC_PATH =
  /\/api\/v1\/admin\/llm\/providers\/codex-subscription\/connections\/[^/]+\/catalog\/sync$/

// The closed set of outcomes a CORRECTLY PROVISIONED lane can answer with
// (control-api/src/routes/admin/codexSubscription.ts). A status outside it
// means either the contract moved or this lane's own environment is broken,
// and both must be red.
//
// What is deliberately absent, and why an error banner alone is not enough to
// pass:
// - 401/403: the lane's admin session was refused. Not an outcome of this
//   feature at all.
// - 404: `disabled` is unreachable because the list route answers 404 too, so
//   `listCodexConnections()` would have thrown before the click; `no_grant`
//   means the connection row exists without its secrets, i.e. lane state
//   corruption.
// - 503 with any outcome other than `unavailable`: `auth-rejected` (dead grant
//   token or a broken proxy permit), `never_synced` (row disconnected under
//   us, DB error) and `configmap_write_failed` are all this lane's own
//   breakage wearing a product-shaped banner.
const DOCUMENTED_SYNC_STATUS = [200, 409, 503]

// One spelling, shared by the affordance assertion in R1 and the ABSENCE
// assertion in R2. Two literals would let a rename leave R2 asserting that a
// button nobody renders is not rendered — green, and proving nothing.
const SYNC_BUTTON = 'Sync catalog'

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
    const syncButton = dialog.getByRole('button', { name: SYNC_BUTTON })
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
      // `ok: true` carries `catalogStatus: 'ready'` and nothing else
      // (codexSubscriptionOAuth.ts CodexCatalogSyncResult), so a 200 with any
      // other outcome is a contract move, not a degraded sync. The old
      // non-ready arm here was unreachable.
      const body = (await syncRes.json()) as { outcome?: string }
      expect(body.outcome).toBe('ready')
      // A recorded outcome always advances catalog_revision
      // (codexSubscriptionConnection.ts:692), so this is the business signal
      // that the write landed rather than the UI merely redrawing.
      expect(await catalogRevisionOf(grantKey)).toBeGreaterThan(revisionBefore)
      await expect(successToast).toBeVisible()
      await expect(errorBanner).toHaveCount(0)
    } else if (syncRes.status() === 409) {
      // A concurrent writer won the revision or refresh-lock fence — the
      // reconciliation cron runs the very same runCodexCatalogSync on Codex
      // grants, so it can race this click. The click still issued the write;
      // this request recorded nothing, so the revision is NOT asserted.
      const body = (await syncRes.json()) as { error?: string }
      expect(['stale_revision', 'refresh_in_flight']).toContain(body.error)
      await expect(errorBanner).toBeVisible()
      await expect(errorBanner).not.toHaveText('')
      await expect(successToast).toHaveCount(0)
    } else {
      // 503 is accepted for exactly one outcome: the vendor answered badly.
      // That is the only non-200 this lane cannot control, because the catalog
      // origin is frozen to chatgpt.com by codex-llm-proxy/src/originPolicy.ts
      // and this lane deploys no fake upstream.
      expect(syncRes.status()).toBe(503)
      const body = (await syncRes.json()) as { error?: string; outcome?: string }
      expect(body.error).toBe('catalog_sync_failed')
      expect(body.outcome).toBe('unavailable')
      // The outcome was RECORDED, so the revision advanced: the sync ran end to
      // end and only the upstream failed. A transport that never ran — a dead
      // grant token, a disconnected row, a failed ConfigMap write — cannot
      // produce this, which is what keeps the branch from passing on breakage.
      expect(await catalogRevisionOf(grantKey)).toBeGreaterThan(revisionBefore)
      // The operator must be told, and told WHAT: an empty or generic banner is
      // the failure this guards, because the modal would otherwise look
      // identical to a successful sync.
      await expect(errorBanner).toBeVisible()
      await expect(errorBanner).toContainText('unavailable')
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

    await expect(dialog.getByRole('button', { name: SYNC_BUTTON })).toHaveCount(0)

    await hub.closeConnectModal()
  })
})
