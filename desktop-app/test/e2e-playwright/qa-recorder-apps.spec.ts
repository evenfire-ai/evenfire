import { type ElectronApplication, type Page, expect, test } from '@playwright/test'
import {
  EXTERNAL_REST_API_BASE_URL,
  RPC_PROXY_BASE_URL,
  assertAllowedTarget,
  desktopCredentials,
  finalizeRecording,
  launchDesktopApp,
  login,
  screenshotAndLog,
} from './qa-recorder-helpers'

//
// Read-only Apps catalog + embedded session journey. No confirm flag is
// required because this journey sends no messages, triggers no workflows, and
// pays no provider — it only browses. The target guard still runs on every
// test so a recorder can never accidentally hit a non-local env.
//
// Resilience contract: the Apps catalog may load slowly, be empty, surface a
// load error, or hold any number of seeded apps. We hard-assert only the shell
// (the <h2>Apps</h2> header is rendered in every SandboxUiPage branch) and a
// broad union of catalog bodies. The embedded-session and Back steps are
// gated on a ready app card actually being present — we never hard-assert a
// specific app name, because none is guaranteed by the fixture set.
//
test('optional QA recorder: Desktop apps journey', async ({}, testInfo) => {
  assertAllowedTarget('EXTERNAL_REST_API_BASE_URL', EXTERNAL_REST_API_BASE_URL)
  assertAllowedTarget('RPC_PROXY_BASE_URL', RPC_PROXY_BASE_URL)

  const credentials = desktopCredentials()
  let app: ElectronApplication | undefined
  let page: Page | undefined

  try {
    const launched = await launchDesktopApp(testInfo)
    app = launched.app
    page = launched.page

    await login(page, credentials)

    // (1) Open Apps (nav-sandbox-ui) and assert the catalog shell rendered.
    // SandboxUiPage emits <h2>Apps</h2> in its loading, empty, error, and
    // populated branches, so the heading is the stable proof the shell mounted
    // regardless of how much seed data is present.
    await page.getByTestId('nav-sandbox-ui').click()
    const appsHeading = page.getByRole('heading', { name: 'Apps', exact: true })
    await expect(appsHeading).toBeVisible({ timeout: 20_000 })

    // Resilient catalog body union: `.apps-grid` matches both the populated
    // grid and the loading-skeleton grid (`apps-grid apps-grid--skeleton`),
    // and the empty-state copy covers the zero-app branch. Either way the
    // shell is rendering real content — never hard-assert a specific app name.
    const catalogBody = page
      .locator('.apps-grid')
      .or(page.getByText('No available apps yet'))
      .first()
    await expect(catalogBody).toBeVisible({ timeout: 20_000 })

    await screenshotAndLog(page, testInfo, 'desktop-apps-catalog')

    // (2) If a ready app card is present, open the embedded session. A card is
    // only activatable when the backend marked it ready, which is exactly when
    // SandboxUiPage applies the `apps-grid__card--clickable` modifier plus
    // role=button (via clickableRowProps). Take the first ready card — do not
    // pin to a specific app identity.
    const readyCard = page.locator('.apps-grid__card--clickable').first()
    if (await readyCard.isVisible().catch(() => false)) {
      await readyCard.click()

      // The embedded app is a native WebContentsView floated above the DOM, so
      // assert the mounted chrome OR the minting loader OR the parked preview
      // image. The "Back to apps" button is rendered for both the `minting`
      // and `mounted` launch states, so it is the most reliable signal that the
      // open flow actually ran.
      const backButton = page.getByRole('button', { name: 'Back to apps' })
      const loadingApp = page.getByText('Loading app')
      const embedPreview = page.getByTestId('sandbox-ui-embed-preview')
      const mounted = backButton.or(loadingApp).or(embedPreview).first()
      await expect(mounted).toBeVisible({ timeout: 20_000 })

      await screenshotAndLog(page, testInfo, 'desktop-apps-embedded')

      // (3) Back action returns to the catalog. The Back button is part of the
      // mounted union above, so only click it when it is the visible signal —
      // if the open surfaced an error banner instead, the catalog is already
      // showing and there is nothing to return from.
      if (await backButton.isVisible().catch(() => false)) {
        await backButton.click()
        await expect(appsHeading).toBeVisible({ timeout: 20_000 })
        await expect(catalogBody).toBeVisible({ timeout: 20_000 })
        await screenshotAndLog(page, testInfo, 'desktop-apps-back')
      }
    }
  } finally {
    await finalizeRecording(app, page)
  }
})
