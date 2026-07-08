/**
 * User journey (sandbox-ui) for a Plugin Workload SDK recipe.
 *
 * Drives the REAL recipe frontend the operator just installed — the exact
 * sandbox-ui content the Desktop App embeds in its WebContentsView, served by
 * rpc-proxy under /api/v1/sandbox-ui/<ns>/<recipe>/view/. Rendering it in a
 * Playwright browser (instead of the Electron WebContentsView) exercises the
 * identical chain — frontend → recipe backend → mcp-host SDK server
 * (promptBridge + clientNotifications + recipients) — without the
 * WebContentsView injection fragility, so it is a reliable regression gate for
 * the three infra fixes: eager-configure race, runtime-token refresh-on-401,
 * and the grant-driven recipient picker (GET
 * /sdk/v1/client-notifications/recipients) that populates the notify dropdown
 * from the clientNotifications grant on every install path.
 *
 * Sequenced AFTER the operator journey: the recipe must already be installed,
 * its eager mcp-host validated, and the SDK grants configured.
 *
 * Env (branch profile port-forwards):
 *   RPC_PROXY_BASE_URL   (rpc-proxy,          e.g. http://127.0.0.1:25822)
 *   EXT_API              (external-rest-api,  e.g. http://127.0.0.1:25819)
 *   E2E_SANDBOX_UI_RECIPE  the installed recipe name (versioned)
 *   E2E_DESKTOP_USER_EMAIL / E2E_DESKTOP_PASSWORD  the human user
 */
import { expect, test } from '@playwright/test'

const RPC_PROXY = process.env.RPC_PROXY_BASE_URL || 'http://127.0.0.1:25822'
const EXT_API = process.env.EXT_API || 'http://127.0.0.1:25819'
const RECIPE_NS = 'sandbox-recipes'
const SANDBOX_UI_RPC_HOST_REF = 'sandbox-ui'
const RECIPE = process.env.E2E_SANDBOX_UI_RECIPE || ''
const USER_EMAIL = process.env.E2E_DESKTOP_USER_EMAIL || 'test@clerum.io'
const USER_PASSWORD = process.env.E2E_DESKTOP_PASSWORD || 'changeme123!'
/** When set, the journey writes labelled success screenshots here (evidence/demo only). */
const EVIDENCE_DIR = process.env.E2E_EVIDENCE_DIR

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; text: string; headers: Headers }> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: resp.status, text: await resp.text(), headers: resp.headers }
}

async function passwordLogin(): Promise<string> {
  const { status, text } = await postJson(`${EXT_API}/api/v1/auth/password-login`, {
    email: USER_EMAIL,
    password: USER_PASSWORD,
  })
  if (status !== 200) throw new Error(`password-login failed: HTTP ${status} ${text}`)
  const token = (JSON.parse(text) as { token?: string }).token
  if (!token) throw new Error('password-login returned no token')
  return token
}

async function issueSandboxUiRpcToken(sessionToken: string): Promise<string> {
  const { status, text } = await postJson(
    `${EXT_API}/api/v1/rpc/token`,
    { scopes: ['sandbox:ui:view'], hostRefs: [SANDBOX_UI_RPC_HOST_REF] },
    { Authorization: `Bearer ${sessionToken}` }
  )
  if (status !== 200) throw new Error(`rpc token issuance failed: HTTP ${status} ${text}`)
  const token = (JSON.parse(text) as { token?: string }).token
  if (!token) throw new Error('rpc token issuance returned no token')
  return token
}

async function mintSandboxUiSessionCookie(rpcToken: string, recipe: string): Promise<string> {
  const resp = await fetch(
    `${RPC_PROXY}/api/v1/sandbox-ui/${encodeURIComponent(RECIPE_NS)}/${encodeURIComponent(
      recipe
    )}/session`,
    { method: 'POST', headers: { Authorization: `Bearer ${rpcToken}` } }
  )
  const body = await resp.text()
  expect(resp.status, `session mint: ${body}`).toBe(204)
  const setCookie = resp.headers.get('set-cookie') ?? ''
  expect(setCookie).toContain('clerum_sandbox_ui_session=')
  return setCookie.split(';', 1)[0]
}

test.describe('Plugin Workload SDK — user journey (sandbox-ui prompt + notification)', () => {
  test.skip(!RECIPE, 'E2E_SANDBOX_UI_RECIPE not set — pass the installed recipe name')

  test('user runs a prompt and sends a notification from the recipe sandbox-ui', async ({
    browser,
  }) => {
    test.setTimeout(180_000)

    // Mint the sandbox-ui session the Desktop App's WebContentsView would mint.
    const sessionToken = await passwordLogin()
    const rpcToken = await issueSandboxUiRpcToken(sessionToken)
    const cookie = await mintSandboxUiSessionCookie(rpcToken, RECIPE)

    const cookieValue = cookie.split('=').slice(1).join('=')
    const rpcUrl = new URL(RPC_PROXY)
    const context = await browser.newContext()
    await context.addCookies([
      {
        name: 'clerum_sandbox_ui_session',
        value: cookieValue,
        domain: rpcUrl.hostname,
        path: '/',
      },
    ])
    const page = await context.newPage()

    try {
      const viewUrl = `${RPC_PROXY}/api/v1/sandbox-ui/${encodeURIComponent(
        RECIPE_NS
      )}/${encodeURIComponent(RECIPE)}/view/`
      await page.goto(viewUrl, { waitUntil: 'domcontentloaded' })

      // The sandbox-ui frontend loaded (relative-paths fix). The prompt panel
      // and notify panel must be present.
      await expect(page.locator('#prompt')).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('#run')).toBeVisible()

      // 1. promptBridge: type a prompt, run it, read the LLM completion.
      // The frontend shows 'Running…' synchronously then replaces it with the
      // real promptBridge content — wait for that replacement, NOT just any text,
      // so the assertion can't pass on the loading placeholder.
      const promptOut = page.locator('#prompt-out')
      await page.locator('#prompt').fill('Reply with a single short word.')
      await page.locator('#run').click()
      await expect(promptOut).toContainText('Running', { timeout: 10_000 })
      await expect(promptOut).not.toContainText('Running', { timeout: 90_000 })
      const promptText = ((await promptOut.textContent()) ?? '').trim()
      expect(promptText.length, `prompt output was empty: "${promptText}"`).toBeGreaterThan(0)
      expect(promptText.toLowerCase()).not.toContain('unauthorized')
      expect(promptText.toLowerCase()).not.toContain('provider_unavailable')
      if (EVIDENCE_DIR) await page.screenshot({ path: `${EVIDENCE_DIR}/sandbox-ui-1-prompt.png` })

      // 2. clientNotifications — replicate a real user PICKING A RECIPIENT BY
      // ITS VISIBLE EMAIL (the human handle EvenFire shows), never by the opaque
      // UUID value. The dropdown is populated from the grant via the SDK
      // recipients endpoint (GET /sdk/v1/client-notifications/recipients), loaded
      // async on page load — the grant-driven picker fix, so this leg is a hard
      // requirement, not an optional skip.
      const userSelect = page.locator('#userRef')
      const realOptions = userSelect.locator('option[value]:not([value=""])')
      await expect
        .poll(() => realOptions.count(), {
          timeout: 25_000,
          message: 'recipient dropdown never populated from the SDK grant',
        })
        .toBeGreaterThan(0)
      // The label the user reads must be the EMAIL handle — never the opaque
      // UUID. This both replicates the real choice and proves the handle
      // resolution end-to-end (control-api → SDK → recipe).
      const userOption = userSelect.locator('option').filter({ hasText: USER_EMAIL })
      await expect(userOption.first()).toBeAttached({ timeout: 10_000 })
      const recipientLabel = ((await userOption.first().textContent()) ?? '').trim()
      expect(
        recipientLabel,
        `recipient must be shown by email, not UUID: "${recipientLabel}"`
      ).toMatch(/@/)
      expect(recipientLabel).toContain(USER_EMAIL)
      expect(recipientLabel).not.toMatch(/^[0-9a-f-]{36}$/i)

      const notifyOut = page.locator('#notify-out')
      // Pick the recipient the way a human does: by the visible email label.
      await userSelect.selectOption({ label: recipientLabel })
      await expect(userSelect).toHaveValue(/.+/) // a real userRef is now selected
      if (EVIDENCE_DIR)
        await page.screenshot({ path: `${EVIDENCE_DIR}/sandbox-ui-2-recipient-by-email.png` })
      await page.locator('#title').fill('E2E SDK notification')
      await page.locator('#message').fill('Sent from the sandbox-ui user journey.')
      await page.locator('#notify').click()
      // Wait for the TERMINAL result, never the transient 'Sending…' phase — a
      // fast SDK accept races right past it, making a 'Sending' assertion flaky.
      await expect(notifyOut).toContainText(/notificationId|accepted|delivered|error/i, {
        timeout: 30_000,
      })
      const notifyText = ((await notifyOut.textContent()) ?? '').trim()
      expect(notifyText.toLowerCase()).not.toContain('unauthorized')
      // The SDK returns a notificationId + status (accepted|delivered) on success.
      expect(notifyText).toMatch(/notificationId|accepted|delivered/i)
      if (EVIDENCE_DIR)
        await page.screenshot({ path: `${EVIDENCE_DIR}/sandbox-ui-3-notify-sent.png` })
    } finally {
      await context.close()
    }
  })
})
