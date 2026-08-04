// desktop-app/test/e2e-playwright/qa-recorder-helpers.ts
//
// Shared primitives for the optional Desktop App QA recorder journeys.
//
// Contract: see docs/testing/optional-playwright-qa-recorder.md ("Extending the
// recorder"). Every recorder journey is self-contained: it launches the real
// Electron app headfully with video, signs in with the exact identity from
// .env.qa-recorder, guards non-local targets, and requires an explicit opt-in
// confirmation variable for any write, message, or paid provider call.
//
// These helpers hold only the genuinely shared plumbing (launch, login,
// credentials, guards, screenshots/video finalization, and a few navigation
// primitives reused across journeys). Journey-specific interactions stay inside
// their own specs so each remains independently readable.
import {
  type ElectronApplication,
  type Page,
  type TestInfo,
  _electron as electron,
  expect,
} from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

export const DESKTOP_APP_ROOT = path.resolve(__dirname, '../..')
export const MAIN_ENTRY = path.join(DESKTOP_APP_ROOT, 'dist/main.js')
export const EXTERNAL_REST_API_BASE_URL =
  process.env.EXTERNAL_REST_API_BASE_URL ||
  process.env.EXTERNAL_REST_API_URL ||
  process.env.E2E_EXTERNAL_REST_API_URL ||
  'http://127.0.0.1:8091'
export const RPC_PROXY_BASE_URL =
  process.env.RPC_PROXY_BASE_URL ||
  process.env.RPC_PROXY_URL ||
  process.env.E2E_RPC_PROXY_URL ||
  'http://127.0.0.1:8094'
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const DEFAULT_DESKTOP_EMAIL = 'test@clerum.io'
const DEFAULT_DESKTOP_PASSWORD = 'changeme123!'

/** Require an explicit opt-in confirmation variable before a journey that writes, messages, or pays. */
export function requireRecorderConfirm(flag: string, description: string): void {
  if (process.env[flag] !== '1') {
    throw new Error(
      `${description} Set ${flag}=1 in .env.qa-recorder to run this recorder journey.`
    )
  }
}

/** Refuse non-loopback targets unless the operator explicitly allowed a remote QA env. */
export async function assertAllowedTarget(label: string, rawUrl: string): Promise<void> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error(`${label} must be an absolute URL; received "${rawUrl}".`)
  }
  if (!LOOPBACK_HOSTS.has(url.hostname) && process.env.QA_RECORDER_ALLOW_REMOTE !== '1') {
    throw new Error(
      `${label} targets non-local host "${url.hostname}". Set QA_RECORDER_ALLOW_REMOTE=1 only for an intentional QA environment.`
    )
  }
  if (LOOPBACK_HOSTS.has(url.hostname) && process.env.QA_RECORDER_ALLOW_REMOTE !== '1') {
    // Target is local — assert the endpoints are healthy right now so a recorder
    // run fails fast with a clear message instead of a slow Electron timeout.
    await assertHealthy(rawUrl, label)
  }
}

async function assertHealthy(baseUrl: string, label: string): Promise<void> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/health`)
    if (res.status !== 200) {
      throw new Error(`HTTP ${res.status}`)
    }
  } catch (err) {
    throw new Error(
      `[qa-recorder] ${label} not healthy at ${baseUrl}: ${(err as Error).message}. Are port-forwards up?`
    )
  }
}

function requiredValue(label: string, candidates: Array<string | undefined>): string {
  const value = candidates.find(candidate => candidate?.trim())?.trim()
  if (!value) throw new Error(`${label} is required for this recorder journey.`)
  return value
}

function configuredValue(candidates: Array<string | undefined>): string | undefined {
  return candidates.find(candidate => candidate?.trim())?.trim()
}

export function desktopCredentials(): { email: string; password: string } {
  return {
    // The canonical repository .env is loaded by playwright.config.ts before
    // this helper is imported. Keep explicit process/root-env values first;
    // these defaults are only for a freshly seeded local profile with no env.
    email:
      configuredValue([process.env.E2E_DEV_LOGIN_EMAIL, process.env.TEST_USER_EMAIL]) ||
      DEFAULT_DESKTOP_EMAIL,
    password:
      configuredValue([
        process.env.E2E_DESKTOP_PASSWORD,
        process.env.E2E_TEST_PASSWORD,
        process.env.ADMIN_PASSWORD,
      ]) || DEFAULT_DESKTOP_PASSWORD,
  }
}

export function configuredHostRef(): string {
  return requiredValue('E2E_HOST_REF', [process.env.E2E_HOST_REF])
}

/**
 * Launch the real Electron app headfully into an isolated profile, recording a
 * 1280x720 WebM. Returns the app handle and its first window page. Caller owns
 * closing the app (use finalizeRecording in a finally block) so the video file
 * is finalized on disk.
 */
export async function launchDesktopApp(testInfo: TestInfo): Promise<{
  app: ElectronApplication
  page: Page
}> {
  if (!fs.existsSync(MAIN_ENTRY)) {
    throw new Error(`Desktop app build missing at ${MAIN_ENTRY}. Run npm run build first.`)
  }

  const userDataDir = testInfo.outputPath('electron-user-data')
  const videoDir = testInfo.outputPath('video')
  fs.mkdirSync(userDataDir, { recursive: true })
  fs.mkdirSync(videoDir, { recursive: true })

  const slowMo = Number(process.env.QA_RECORDER_SLOW_MO_MS ?? 75)

  const app = await electron.launch({
    args: [`--user-data-dir=${userDataDir}`, MAIN_ENTRY],
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL: '',
      EXTERNAL_REST_API_BASE_URL,
      RPC_PROXY_BASE_URL,
      CLERUM_DESKTOP_CONFIG_PATH: path.join(userDataDir, 'runtime-config.json'),
    },
    recordVideo:
      process.env.QA_RECORDER_VIDEO === '0'
        ? undefined
        : {
            dir: videoDir,
            size: { width: 1280, height: 720 },
          },
    // Headful + human-paced actions. QA_RECORDER_HEADLESS is honored for the
    // Control UI browser journeys; Electron always opens a real window, so this
    // only controls action pacing here. Slow-mo is what makes the recording
    // watchable as a genuine UI-interaction proof.
    slowMo: Number.isFinite(slowMo) ? slowMo : 75,
  })

  const actualUserDataDir = await app.evaluate(({ app: electronApp }) =>
    electronApp.getPath('userData')
  )
  if (path.resolve(actualUserDataDir) !== path.resolve(userDataDir)) {
    await app.close()
    throw new Error(
      `Electron did not honor the isolated user-data-dir: expected ${userDataDir}, got ${actualUserDataDir}`
    )
  }

  const page = await app.firstWindow()
  // Do not emulate a CSS viewport for native WebContentsView journeys. On a
  // Retina display that forces renderer DPR=1 while Electron remains at
  // scaleFactor=2, producing misleading half-sized native bounds. The window
  // is still recorded at 1280x720 when video capture is enabled above.
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

/** Sign in through the real UI using the configured identity. No-ops if already authenticated. */
export async function login(
  page: Page,
  credentials: { email: string; password: string }
): Promise<void> {
  await expect(page.locator('.boot-overlay')).toBeHidden({ timeout: 20_000 })

  const emailInput = page.locator('#email-input')
  const passwordInput = page.locator('#password-input')
  const authenticatedShell = page
    .getByTestId('nav-chat')
    .or(page.getByTestId('nav-settings-menu'))
    .or(page.getByRole('textbox', { name: 'Agent message composer' }))
    .first()

  await expect(emailInput.or(authenticatedShell)).toBeVisible({ timeout: 20_000 })
  if (await emailInput.isVisible()) {
    await expect(passwordInput).toBeVisible()
    await emailInput.fill(credentials.email)
    await passwordInput.fill(credentials.password)
    await page.getByRole('button', { name: /^Sign in$/ }).click()
  }
  await expect(authenticatedShell).toBeVisible({ timeout: 20_000 })
}

/** Open the footer Settings menu -> Settings page. */
export async function openSettings(page: Page): Promise<void> {
  const settingsMenu = page.getByTestId('nav-settings-menu')
  await expect(settingsMenu).toBeVisible({ timeout: 20_000 })
  if ((await settingsMenu.getAttribute('aria-expanded')) !== 'true') {
    await settingsMenu.click()
  }
  await expect(settingsMenu).toHaveAttribute('aria-expanded', 'true')
  await page.getByTestId('nav-settings').click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
}

/** Click a Settings tab and assert its panel rendered the expected content. */
export async function visitSettingsTab(
  page: Page,
  tabName: string,
  expectedContent: string
): Promise<void> {
  const tab = page.getByRole('tab', { name: tabName, exact: true })
  await expect(tab).toBeVisible()
  await tab.click()
  await expect(page.getByRole('tabpanel')).toContainText(expectedContent)
}

/** Expand footer Resources submenu and click one of its items by test id. */
export async function openResourcesNavItem(page: Page, itemTestId: string): Promise<void> {
  const item = page.getByTestId(itemTestId)
  if (!(await item.isVisible().catch(() => false))) {
    const settingsMenu = page.getByTestId('nav-settings-menu')
    await expect(settingsMenu).toBeVisible({ timeout: 15_000 })
    if ((await settingsMenu.getAttribute('aria-expanded')) !== 'true') {
      await settingsMenu.click()
    }
    await expect(settingsMenu).toHaveAttribute('aria-expanded', 'true', { timeout: 15_000 })

    const resourcesMenu = page.getByTestId('nav-data-menu')
    await expect(resourcesMenu).toBeVisible({ timeout: 15_000 })
    if (!(await item.isVisible().catch(() => false))) {
      await resourcesMenu.click()
    }
  }
  await expect(item).toBeVisible({ timeout: 15_000 })
  await item.click()
}

/** Open Agents (Resources -> Agents). */
export async function openAgentsPage(page: Page): Promise<void> {
  await openResourcesNavItem(page, 'nav-agents')
}

/**
 * Navigate to the exact agent named by hostRef and land on its chat composer.
 * Uses exact identity (no first-available fallback), per the recorder contract.
 */
export async function openExactAgentChat(page: Page, hostRef: string): Promise<void> {
  const settingsMenu = page.getByTestId('nav-settings-menu')
  if ((await settingsMenu.getAttribute('aria-expanded')) !== 'true') {
    await settingsMenu.click()
  }

  const resourcesMenu = page.getByTestId('nav-data-menu')
  await expect(resourcesMenu).toBeVisible()
  if ((await resourcesMenu.getAttribute('aria-expanded')) !== 'true') {
    await resourcesMenu.click()
  }

  await page.getByTestId('nav-agents').click()
  const chatInput = page.getByRole('textbox', { name: 'Agent message composer' })
  const exactAgent = page.locator('.agents-table-row-clickable', { hasText: hostRef }).first()
  const emptyState = page.getByText('No agents available')
  await expect(chatInput.or(exactAgent).or(emptyState)).toBeVisible({ timeout: 20_000 })

  if (await emptyState.isVisible().catch(() => false)) {
    throw new Error(`No agents are available for the configured Desktop test user.`)
  }
  if (await exactAgent.isVisible().catch(() => false)) {
    await exactAgent.click()
  }

  await page.getByTestId('nav-chat').click()
  const switchAgent = page.getByRole('button', { name: /^Switch chat agent$/ })
  await expect(switchAgent).toBeVisible({ timeout: 20_000 })

  if (
    !(await chatInput.isVisible().catch(() => false)) ||
    !(await switchAgent
      .getByText(hostRef, { exact: true })
      .isVisible()
      .catch(() => false))
  ) {
    await switchAgent.click()
    await page.getByRole('menuitem', { name: hostRef, exact: true }).click()
  }

  await expect(chatInput).toBeVisible({ timeout: 20_000 })
  await expect(switchAgent).toContainText(hostRef)
}

/** Send a chat message and wait for a non-empty assistant response. */
export async function sendChatMessage(page: Page): Promise<void> {
  const prompt =
    process.env.QA_RECORDER_CHAT_PROMPT ||
    'Please reply with one short sentence confirming this optional QA recording.'
  const chatInput = page.getByRole('textbox', { name: 'Agent message composer' })
  const responseCountBefore = await page.getByTestId('agent-response').count()

  await expect(chatInput).toBeEnabled()
  await chatInput.fill(prompt)
  const sendButton = page.getByTestId('send-button')
  await expect(sendButton).toBeEnabled()
  await sendButton.click()

  const response = page.getByTestId('agent-response').nth(responseCountBefore)
  await expect(response).toBeVisible({ timeout: 120_000 })
  await expect(response).not.toHaveText('', { timeout: 120_000 })
}

/** Take a full-page PNG proof and log its path. */
export async function screenshotAndLog(
  page: Page,
  testInfo: TestInfo,
  name: string
): Promise<void> {
  const screenshotPath = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path: screenshotPath, fullPage: true })
  // eslint-disable-next-line no-console
  console.log(`[qa-recorder] Desktop screenshot: ${screenshotPath}`)
}

/** Close Electron so the WebM recording is finalized; log the video path. Use in finally. */
export async function finalizeRecording(
  app: ElectronApplication | undefined,
  page: Page | undefined
): Promise<void> {
  const video = page?.video()
  await app?.close().catch(() => undefined)
  const videoPath = await video?.path().catch(() => undefined)
  if (videoPath && fs.existsSync(videoPath)) {
    // eslint-disable-next-line no-console
    console.log(`[qa-recorder] Desktop video: ${videoPath}`)
  }
}
