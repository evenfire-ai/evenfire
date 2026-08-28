// control-ui/e2e/qa-recorder-helpers.ts
//
// Shared primitives for the optional Control UI QA recorder journeys.
//
// Contract: see docs/testing/optional-playwright-qa-recorder.md ("Extending the
// recorder"). The Control UI recorder drives a headful Chromium managed by
// playwright.qa-recorder.config.ts (the `page` fixture), so these helpers only
// cover shared plumbing: admin credentials, UI login, the Control API proxy,
// the loopback target guard, opt-in confirmations, and named screenshot/video
// proof capture. Journey-specific interactions stay inside their own specs.
import { type APIRequestContext, type Page, type TestInfo, expect } from '@playwright/test'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

// Prefer `localhost` over `127.0.0.1`: when control-api runs with
// NODE_ENV=production (any real cluster) the admin session cookie is set with
// `Secure`. Chromium treats both loopback spellings as trustworthy and sends
// the cookie, but Playwright's own cookie jar (used by `page.request` /
// APIRequestContext) only exempts `localhost`/`*.localhost` from the
// secure-cookie-over-http filter (playwright-core network.js isLocalHostname).
// Against `http://127.0.0.1:<port>` every api(page.request, ...) call is sent
// WITHOUT the session cookie and 401s even though the browser session is live.
export const CONTROL_UI_URL = process.env.CONTROL_UI_URL || 'http://localhost:3000'
export const CONTROL_API_URL = process.env.CONTROL_API_URL || 'http://localhost:8090'
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

export type ApiResult<T = Record<string, unknown>> = {
  data: T
  status: number
}

type ApiMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

export type NamedResource = {
  metadata?: { name?: string; namespace?: string }
  name?: string
}

/** Require an explicit opt-in confirmation variable before a journey that writes/mutates. */
export function requireRecorderConfirm(flag: string, description: string): void {
  if (process.env[flag] !== '1') {
    throw new Error(
      `${description} Set ${flag}=1 in .env.qa-recorder to run this recorder journey.`
    )
  }
}

/** Refuse non-loopback targets unless the operator explicitly allowed a remote QA env. */
export function assertAllowedTarget(label: string, rawUrl: string): void {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error(`${label} must be an absolute URL; received "${rawUrl}".`)
  }
  if (!LOOPBACK_HOSTS.has(url.hostname) && process.env.QA_RECORDER_ALLOW_REMOTE !== '1') {
    throw new Error(
      `${label} targets non-local host "${url.hostname}". Set QA_RECORDER_ALLOW_REMOTE=1 only when that environment is intentionally disposable.`
    )
  }
  if (LOOPBACK_HOSTS.has(url.hostname) && process.env.QA_RECORDER_ALLOW_REMOTE !== '1') {
    void assertControlUiUp(rawUrl, label)
  }
}

async function assertControlUiUp(baseUrl: string, label: string): Promise<void> {
  try {
    const res = await fetch(baseUrl, { redirect: 'manual' })
    // 200 (app) or 3xx (auth redirect) both prove the UI is reachable.
    if (res.status >= 500) throw new Error(`HTTP ${res.status}`)
  } catch (err) {
    throw new Error(
      `[qa-recorder] ${label} not reachable at ${baseUrl}: ${(err as Error).message}. Is the control-ui dev server running on :3000?`
    )
  }
}

export function requiredValue(label: string, candidates: Array<string | undefined>): string {
  const value = candidates.find(candidate => candidate?.trim())?.trim()
  if (!value) throw new Error(`${label} is required for this recorder journey.`)
  return value
}

export function adminCredentials(): { username: string; password: string } {
  return {
    username: requiredValue('ADMIN_USER', [
      process.env.E2E_ADMIN_USER,
      process.env.ADMIN_USER,
      process.env.ADMIN_USERNAME,
    ]),
    password: requiredValue('an admin password', [
      process.env.E2E_ADMIN_PASSWORD,
      process.env.ADMIN_PASSWORD,
      process.env.ADMIN_PASS,
      process.env.TEST_ADMIN_PASSWORD,
    ]),
  }
}

/** Unique lowercase k8s-name-safe identifier for temporary resources. */
export function uniqueE2EName(base: string): string {
  const suffix = `${Date.now().toString(36)}-${randomBytes(8).toString('hex')}`
  const safeBase =
    base
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/^-+|-+$/g, '') || 'qa-recorder'
  return `${safeBase.slice(0, 62 - suffix.length)}-${suffix}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 63)
    .replace(/-$/, '')
}

/** Create a private, exclusively-written upload fixture and remove its directory after use. */
export async function createSecureTempFile(fileName: string, contents: string) {
  const safeFileName = path.basename(fileName)
  if (!safeFileName || safeFileName !== fileName) {
    throw new Error(`Temporary upload filename must be a basename; received "${fileName}".`)
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-recorder-upload-'))
  const filePath = path.join(tempDir, safeFileName)
  try {
    await fs.writeFile(filePath, contents, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    throw error
  }

  return {
    filePath,
    cleanup: () => fs.rm(tempDir, { recursive: true, force: true }),
  }
}

/**
 * Call Control API through the Control UI proxy (`/control-api/*`) using the
 * browser session's cookies. Pass `page.request` so the admin auth set by
 * loginThroughUi is reused.
 */
async function requestApi<T = Record<string, unknown>>(
  request: APIRequestContext,
  baseUrl: string,
  method: ApiMethod,
  pathName: string,
  body?: unknown,
  timeout?: number
): Promise<ApiResult<T>> {
  const response = await request.fetch(`${baseUrl}${pathName}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    data: body,
    ...(timeout === undefined ? {} : { timeout }),
  })
  const text = await response.text()
  let data = {} as T
  try {
    data = text ? (JSON.parse(text) as T) : ({} as T)
  } catch {
    data = { raw: text } as T
  }
  return { status: response.status(), data }
}

export async function api<T = Record<string, unknown>>(
  request: APIRequestContext,
  method: ApiMethod,
  pathName: string,
  body?: unknown
): Promise<ApiResult<T>> {
  return requestApi(request, `${CONTROL_UI_URL}/control-api`, method, pathName, body)
}

/**
 * Use the Control API directly for cleanup. It shares the browser's localhost
 * session cookie while keeping teardown on a bounded, explicit request path.
 */
export async function directApi<T = Record<string, unknown>>(
  request: APIRequestContext,
  method: ApiMethod,
  pathName: string,
  body?: unknown
): Promise<ApiResult<T>> {
  return requestApi(request, CONTROL_API_URL, method, pathName, body, 30_000)
}

export function resourceName(item: NamedResource): string {
  return String(item.name || item.metadata?.name || '').trim()
}

/** Sign in through the real Control UI. Dismisses the "Remind me later" notice if present. */
export async function loginThroughUi(
  page: Page,
  credentials: { username: string; password: string }
): Promise<void> {
  await page.goto(CONTROL_UI_URL)
  await expect(page.getByRole('button', { name: /^Sign in$/ })).toBeVisible({
    timeout: 20_000,
  })
  await page.getByLabel('Username or email').fill(credentials.username)
  await page.getByLabel('Password').fill(credentials.password)
  await page.getByRole('button', { name: /^Sign in$/ }).click()
  await expect(page.getByRole('navigation', { name: 'Main sections' })).toBeVisible({
    // Next dev compiles routes on first hit; allow headroom for the authed
    // shell to appear after a slow compile or control-api round-trip.
    timeout: 60_000,
  })

  const remindLater = page.getByRole('button', { name: 'Remind me later' })
  if (await remindLater.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await remindLater.click()
  }
}

/** Take a full-page PNG proof and log its path. The PNG stem is also the key used to group the test's video later. */
export async function screenshotAndLog(
  page: Page,
  testInfo: TestInfo,
  name: string
): Promise<void> {
  const screenshotPath = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path: screenshotPath, fullPage: true })
  // eslint-disable-next-line no-console
  console.log(`[qa-recorder] Control UI screenshot: ${screenshotPath}`)
}
