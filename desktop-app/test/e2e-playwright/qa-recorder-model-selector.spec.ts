import { type ElectronApplication, type Locator, type Page, expect, test } from '@playwright/test'
import {
  EXTERNAL_REST_API_BASE_URL,
  RPC_PROXY_BASE_URL,
  assertAllowedTarget,
  configuredHostRef,
  desktopCredentials,
  finalizeRecording,
  launchDesktopApp,
  login,
  openExactAgentChat,
  screenshotAndLog,
} from './qa-recorder-helpers'

/*
 * Model-selector catalog journey (issue #735).
 *
 * Proves, against a real catalog rather than a fixture, that the selector's
 * rows carry the model name and nothing else: the `default` tag and the
 * image-capability tags (`images` / `no images` / `images not verified`) are
 * gone from every row of a multi-model catalog.
 *
 * This is a LOCAL-ONLY lane. It is not wired into CI and must not be: it needs
 * an operator identity and a reachable environment. Two different directories
 * are involved, so spell both out:
 *
 *   - `.env.qa-recorder` goes at the REPOSITORY ROOT, which is what
 *     playwright.qa-recorder.config.ts resolves as `../../..` from this
 *     directory and hands to loadQaRecorderEnv. Not in `desktop-app/`, where it
 *     is never read.
 *   - `npm run qa:recorder:model-selector` runs from `desktop-app/`, the
 *     package that owns the script.
 *
 * Point it at an environment whose catalog has several models — that is the
 * whole point of running this against a shared dev environment rather than the
 * branch-owned local stack, whose catalog is a two-model fixture. A non-local
 * target requires QA_RECORDER_ALLOW_REMOTE=1, enforced by assertAllowedTarget.
 *
 * No confirm flag is required. The journey never sends a message and never
 * incurs model cost. It does change the chat's session model, which is a write,
 * so it restores the original selection before it finishes and asserts that the
 * restore landed.
 */

/** The tag texts this issue retired. Exact matches only — a model whose name
 *  happens to contain one of these words must not trip the assertion. */
const RETIRED_TAG_TEXTS = ['default', 'images', 'no images', 'images not verified'] as const

function modelChip(page: Page): Locator {
  return page.getByTestId('selected-chat-model')
}

function modelMenu(page: Page): Locator {
  return page.getByRole('menu', { name: 'Select model' })
}

/** Open the popover through the visible chip, the way a user does. */
async function openModelMenu(page: Page): Promise<void> {
  const chip = modelChip(page)
  await expect(chip).toBeVisible({ timeout: 20_000 })
  await expect(chip).toHaveAttribute('aria-haspopup', 'menu')
  if ((await chip.getAttribute('aria-expanded')) !== 'true') {
    await chip.click()
  }
  await expect(chip).toHaveAttribute('aria-expanded', 'true')
  await expect(modelMenu(page)).toBeVisible({ timeout: 20_000 })
}

/**
 * Assert the popover is tagless.
 *
 * Every assertion here is negative, so the caller must have proven the menu is
 * open and populated first — `rows` is that witness, and its length is asserted
 * by the caller before this runs.
 */
async function expectCatalogHasNoTags(page: Page, rowCount: number): Promise<void> {
  const menu = modelMenu(page)

  // Class-coupled check: the retired element, by its own class.
  await expect(menu.locator('.model-selector-item-tag')).toHaveCount(0)

  // Class-independent check: a row is exactly one span (the label). A tag
  // reintroduced under any other class name lands here. The active row also
  // renders a check svg, which is not a span and does not affect the count.
  await expect(menu.locator('[role="menuitemradio"] span')).toHaveCount(rowCount)

  // Vocabulary check: catches a tag rendered as something other than a span.
  for (const text of RETIRED_TAG_TEXTS) {
    await expect(menu.getByText(text, { exact: true })).toHaveCount(0)
  }
}

test('optional QA recorder: Desktop model selector lists models without capability tags', async ({}, testInfo) => {
  await assertAllowedTarget('EXTERNAL_REST_API_BASE_URL', EXTERNAL_REST_API_BASE_URL)
  await assertAllowedTarget('RPC_PROXY_BASE_URL', RPC_PROXY_BASE_URL)

  const credentials = desktopCredentials()
  const hostRef = configuredHostRef()
  let app: ElectronApplication | undefined
  let page: Page | undefined

  try {
    const launched = await launchDesktopApp(testInfo)
    app = launched.app
    page = launched.page
    // `page`/`app` exist only so the `finally` can finalize a partial launch.
    // The journey itself uses this non-optional binding, because TypeScript
    // drops the narrowing of a `let` inside the test.step closures below.
    const ui = launched.page

    await login(ui, credentials)
    await openExactAgentChat(ui, hostRef)

    const composer = ui.getByRole('textbox', { name: 'Agent message composer' })
    await expect(composer).toBeVisible({ timeout: 20_000 })

    // The selection this journey must hand back. Broker-backed hosts invent no
    // default, so an absent value is legitimate and only disables the restore.
    const originalModel = await modelChip(ui).getAttribute('data-model-id')

    let rowCount = 0
    let otherModel = ''

    await test.step('the catalog lists several models and none of them is tagged', async () => {
      await openModelMenu(ui)

      const rows = modelMenu(ui).getByRole('menuitemradio')
      rowCount = await rows.count()

      // A single-model catalog cannot prove the claim this journey exists to
      // prove. Fail loudly rather than passing on a catalog that says nothing:
      // point the lane at an environment with a real multi-model catalog.
      expect(
        rowCount,
        'this journey needs a catalog with at least two models; point the lane at an environment that has one'
      ).toBeGreaterThanOrEqual(2)

      // Witness: every row rendered a non-empty label. The absence assertions
      // below cannot be satisfied by an empty or unopened popover.
      for (let index = 0; index < rowCount; index += 1) {
        await expect(rows.nth(index)).toBeVisible()
        await expect(rows.nth(index)).not.toHaveText('')
      }

      await expectCatalogHasNoTags(ui, rowCount)
      await screenshotAndLog(ui, testInfo, 'desktop-model-selector-catalog-untagged')
    })

    await test.step('picking a model still works and the picked row stays untagged', async () => {
      const rows = modelMenu(ui).getByRole('menuitemradio')

      // Pick a row that is not the current selection, so the chip has to change.
      for (let index = 0; index < rowCount; index += 1) {
        const row = rows.nth(index)
        if ((await row.getAttribute('aria-checked')) === 'true') continue
        const testId = await row.getAttribute('data-testid')
        if (!testId) continue
        otherModel = testId.replace(/^model-option-/, '')
        await row.click()
        break
      }
      expect(
        otherModel,
        'the catalog offered no selectable model other than the current one'
      ).not.toBe('')

      // Business signal: the host accepted the pick and the chip reports it.
      await expect(modelChip(ui)).toHaveAttribute('data-model-id', otherModel, { timeout: 30_000 })

      // Reopen: the pick persisted, and the ACTIVE row — the only one that also
      // renders the check svg — is untagged too.
      await openModelMenu(ui)
      const activeRow = modelMenu(ui).getByTestId(`model-option-${otherModel}`)
      await expect(activeRow).toHaveAttribute('aria-checked', 'true')
      await expectCatalogHasNoTags(ui, await rows.count())
      await screenshotAndLog(ui, testInfo, 'desktop-model-selector-active-row-untagged')
    })

    await test.step('restore the original selection', async () => {
      if (!originalModel || originalModel === otherModel) {
        // Broker-backed host with no prior selection, or the pick was already
        // the original. Nothing to hand back.
        await ui.keyboard.press('Escape')
        await expect(modelMenu(ui)).toBeHidden({ timeout: 20_000 })
        return
      }
      await openModelMenu(ui)
      await modelMenu(ui).getByTestId(`model-option-${originalModel}`).click()
      await expect(modelChip(ui)).toHaveAttribute('data-model-id', originalModel, {
        timeout: 30_000,
      })
    })
  } finally {
    await finalizeRecording(app, page)
  }
})
