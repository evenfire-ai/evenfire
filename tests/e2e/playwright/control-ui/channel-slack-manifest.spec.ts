/**
 * Control UI — Slack App Manifest E2E journey (PR #1640, /e2e-test-guardian).
 *
 * Proves the real operator flow without storageState shortcuts, direct
 * happy-path navigation, or API mocks:
 *   1. Negative route guard: unauthenticated direct access to
 *      /communication-channels/new renders the login gate, never the wizard.
 *   2. Happy path (public-style `app.localhost` loopback origin): visible
 *      admin login -> External Channels -> Add channel -> Channel Identity
 *      -> Continue -> Provider = Slack -> Slack App Name -> generated YAML
 *      manifest renders with `files:read`, event subscriptions, and the
 *      channel-specific Request URL, and the Copy action succeeds.
 *   3. Fail-closed boundary (`127.0.0.1` loopback origin without public
 *      webhook base): the exact same journey refuses to emit an invalid
 *      relative-URL manifest and displays the operator warning banner.
 */
import { type Page, expect, test } from '@playwright/test'
import { CUI_DASHBOARD } from '../helpers/selectors'
import { loginControlUiVisible } from '../helpers/visible-login'

const RAW_CONTROL_UI_URL = process.env.CONTROL_UI_URL ?? 'http://127.0.0.1:3000'

function buildOriginVariants(rawUrl: string): {
  loopbackOrigin: string
  publicAppOrigin: string
  expectedWebhookPrefix: string
} {
  const parsed = new URL(rawUrl)
  const portSuffix = parsed.port ? `:${parsed.port}` : ''
  const loopbackOrigin = `${parsed.protocol}//127.0.0.1${portSuffix}`
  const publicAppOrigin = `${parsed.protocol}//app.localhost${portSuffix}`
  const expectedWebhookPrefix = `${parsed.protocol}//webhook.localhost/webhooks/slack/`
  return { loopbackOrigin, publicAppOrigin, expectedWebhookPrefix }
}

function expectedSlackTargetId(channelName: string, namespace = 'channels'): string {
  const encoded = Buffer.from(JSON.stringify({ namespace, name: channelName }), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return `slack:${encoded}`
}

async function advanceWizardToSlackManifestStep(
  page: Page,
  opts: { channelName: string; agentName: string; slackAppName: string }
): Promise<void> {
  await test.step('navigate to External Channels via sidebar', async () => {
    await page.locator(CUI_DASHBOARD.TAB_CHANNELS).click()
    await expect(page).toHaveURL(/\/external-channels/, { timeout: 20_000 })
    await expect(page.locator('.cu-panel-title')).toContainText('Communication channels', {
      timeout: 20_000,
    })
    await expect(page.getByRole('button', { name: 'Add channel' })).toBeEnabled({
      timeout: 20_000,
    })
  })

  await test.step('open Create communication channel wizard', async () => {
    await page.getByRole('button', { name: 'Add channel' }).click()
    await expect(page).toHaveURL(/\/(external-channels|communication-channels)\/new/, {
      timeout: 20_000,
    })
    await expect(page.getByRole('heading', { name: 'Create communication channel' })).toBeVisible({
      timeout: 20_000,
    })
    await expect(page.locator('#ch-name')).toBeVisible()
  })

  await test.step('fill channel identity and select live agent', async () => {
    await page.locator('#ch-name').fill(opts.channelName)
    await expect(page.locator('#ch-host')).toBeVisible({ timeout: 20_000 })
    await page.locator('#ch-host').click()
    const agentOption = page.getByRole('option', { name: opts.agentName, exact: true }).first()
    await expect(agentOption).toBeVisible({ timeout: 15_000 })
    await agentOption.click()
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.locator('#ch-provider')).toBeVisible({ timeout: 15_000 })
  })

  await test.step('select Slack provider and enter Slack App Name', async () => {
    await page.locator('#ch-provider').click()
    const slackOption = page.getByRole('option', { name: /Slack/i }).first()
    await expect(slackOption).toBeVisible({ timeout: 10_000 })
    await slackOption.click()
    await expect(page.locator('#slack-bot-handle')).toBeVisible({ timeout: 10_000 })
    await page.locator('#slack-bot-handle').fill(opts.slackAppName)
  })
}

test.describe('Control UI — Slack App Manifest E2E (#1640)', () => {
  const { loopbackOrigin, publicAppOrigin, expectedWebhookPrefix } =
    buildOriginVariants(RAW_CONTROL_UI_URL)
  const targetAgent = process.env.E2E_HOST_REF ?? 'chatllm'

  test('negative route guard: unauthenticated direct visit to /communication-channels/new blocks wizard access', async ({
    browser,
  }) => {
    const context = await browser.newContext()
    const page = await context.newPage()
    try {
      await page.goto(`${loopbackOrigin}/communication-channels/new`, {
        waitUntil: 'domcontentloaded',
      })
      await expect(page.getByLabel('Username or email')).toBeVisible({ timeout: 20_000 })
      await expect(page.getByLabel('Password')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
      await expect(page.locator('#ch-name')).toBeHidden()
      await expect(page.locator('pre.cu-slack-manifest__pre')).toBeHidden()
    } finally {
      await context.close()
    }
  })

  test('real operator flow generates Slack App Manifest with files:read scope and channel-bound Request URL', async ({
    browser,
  }) => {
    const channelName = 'e2e-slack-files-test'
    const slackAppName = 'Evenfire E2E Files Bot'
    const expectedTargetEncoded = encodeURIComponent(expectedSlackTargetId(channelName))
    const expectedRequestUrl = `${expectedWebhookPrefix}${expectedTargetEncoded}`

    const context = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
    })
    const page = await context.newPage()
    try {
      await test.step('log in visibly through the Control UI login form', async () => {
        await page.goto(`${publicAppOrigin}/`, { waitUntil: 'domcontentloaded' })
        await loginControlUiVisible(page)
      })

      await advanceWizardToSlackManifestStep(page, {
        channelName,
        agentName: targetAgent,
        slackAppName,
      })

      await test.step('verify generated Slack App Manifest YAML includes files:read and channel Request URL', async () => {
        const manifestCode = page.locator('pre.cu-slack-manifest__pre code')
        await expect(manifestCode).toBeVisible({ timeout: 15_000 })
        await expect(manifestCode).toContainText(`name: "${slackAppName}"`)
        await expect(manifestCode).toContainText('- files:read')
        await expect(manifestCode).toContainText('- app_mention')
        await expect(manifestCode).toContainText('- message.channels')
        await expect(manifestCode).toContainText('- message.im')
        await expect(manifestCode).toContainText(`request_url: ${expectedRequestUrl}`)

        const copyButton = page.getByRole('button', { name: 'Copy Slack app manifest' })
        await expect(copyButton).toBeEnabled()
        await copyButton.click()
        await expect(page.getByText('Slack app manifest copied.')).toBeVisible({ timeout: 10_000 })
        await expect(page.locator('.cu-banner--error')).toBeHidden()
      })
    } finally {
      await context.close()
    }
  })

  test('fail-closed boundary: loopback origin without public webhook address refuses to render an invalid relative manifest', async ({
    browser,
  }) => {
    const context = await browser.newContext()
    const page = await context.newPage()
    try {
      await test.step('log in visibly on 127.0.0.1 loopback origin', async () => {
        await page.goto(`${loopbackOrigin}/`, { waitUntil: 'domcontentloaded' })
        await loginControlUiVisible(page)
      })

      await advanceWizardToSlackManifestStep(page, {
        channelName: 'e2e-slack-loopback-guard',
        agentName: targetAgent,
        slackAppName: 'Evenfire Loopback Guard Bot',
      })

      await test.step('assert fail-closed operator warning banner and absent manifest block', async () => {
        await expect(
          page.locator('.cu-banner--warning', {
            hasText: 'No app manifest: this deployment has no public webhook address',
          })
        ).toBeVisible({ timeout: 15_000 })
        await expect(page.locator('pre.cu-slack-manifest__pre')).toBeHidden()
      })
    } finally {
      await context.close()
    }
  })
})
