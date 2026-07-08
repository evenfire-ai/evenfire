import {
  type ElectronApplication,
  type Locator,
  type Page,
  _electron as electron,
  expect,
} from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { E2E_TEST_EMAIL } from '../../../tests/e2e/testUser'
import type {
  PendingWorkflowApproval,
  WorkflowRecipeListResult,
  WorkflowRunsResult,
} from '../../src/types'
import { openResourcesNavItem } from './navigationHelpers'

// Desktop workflow/approval E2E must default to the same seeded identity as
// chatllm and the cluster seed scripts. Unauthorized specs are the only
// intentional exception and should override the email explicitly.
export const E2E_EMAIL = E2E_TEST_EMAIL
export const E2E_DESKTOP_PASSWORD =
  process.env.E2E_DESKTOP_PASSWORD ||
  process.env.E2E_TEST_PASSWORD ||
  process.env.ADMIN_PASSWORD ||
  'changeme123!'
export const EXT_API = process.env.EXTERNAL_REST_API_BASE_URL || 'http://127.0.0.1:8091'
export const K8S_CONTEXT = process.env.E2E_K8S_CONTEXT || 'clerum-test'
// Canonical WorkflowRecipe namespace for control-api admin recipe routes.
// Aligned with seed-workflow-triggers-test-data.sh so all Playwright tests
// exercise the canonical flow. Legacy mcp-server WorkflowRecipe stragglers are
// negative guards now; they are not valid deployment targets.
export const RECIPE_NS = 'sandbox-recipes'
const REPO_ROOT = path.resolve(__dirname, '../../..')
const DESKTOP_APP_ROOT = path.resolve(__dirname, '../..')
const DESKTOP_BUILD_OUTPUTS = [
  path.join(DESKTOP_APP_ROOT, 'dist/main.js'),
  path.join(DESKTOP_APP_ROOT, 'dist/preload.js'),
  path.join(DESKTOP_APP_ROOT, 'ui-dist/index.html'),
]
const DESKTOP_BUILD_INPUT_DIRS = [
  path.join(DESKTOP_APP_ROOT, 'src'),
  path.join(DESKTOP_APP_ROOT, 'ui/src'),
]
const WORKFLOW_TRIGGER_SEED_SCRIPT = path.join(
  REPO_ROOT,
  'scripts/minikube/seed-workflow-triggers-test-data.sh'
)
let workflowFixturesSeeded = false
const passwordSeededFor = new Set<string>()
const API_REQUEST_RETRY_DELAYS_MS = [250, 500]
const HUMAN_E2E_RECORDED = process.env.HUMAN_E2E_RECORDED === '1'

function randomHumanDelay(minMs: number, maxMs: number): number {
  return Math.floor(minMs + Math.random() * (maxMs - minMs + 1))
}

async function humanUiPause(minMs = 220, maxMs = 520): Promise<void> {
  if (!HUMAN_E2E_RECORDED) return
  await new Promise(resolve => setTimeout(resolve, randomHumanDelay(minMs, maxMs)))
}

async function humanUiClick(locator: Locator): Promise<void> {
  if (!HUMAN_E2E_RECORDED) {
    await locator.click()
    return
  }

  await expect(locator).toBeVisible()
  await locator.scrollIntoViewIfNeeded()
  await humanUiPause(260, 720)
  const box = await locator.boundingBox()
  if (box) {
    await locator.page().mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
      steps: randomHumanDelay(12, 24),
    })
  } else {
    await locator.hover()
  }
  await humanUiPause(140, 360)
  await locator.click({ delay: randomHumanDelay(45, 120) })
  await humanUiPause(280, 760)
}

function assertSafeE2ERecipeName(recipeName: string): void {
  if (!/^e2e-[a-z0-9-]+$/.test(recipeName)) {
    throw new Error(`refusing to mutate non-E2E workflow recipe state for "${recipeName}"`)
  }
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function kubectlOut(args: string[], timeout = 20_000, input?: string): string {
  return execFileSync('kubectl', ['--context', K8S_CONTEXT, ...args], {
    encoding: 'utf-8',
    timeout,
    input,
  })
}

function getProfilesPostgresPod(): string {
  return kubectlOut(
    [
      '-n',
      'control-plane',
      'get',
      'pod',
      '-l',
      'app=control-postgres',
      '-o',
      'jsonpath={.items[0].metadata.name}',
    ],
    10_000
  ).trim()
}

function runProfilesSql(sql: string, timeout = 20_000): string {
  const pgPod = getProfilesPostgresPod()
  return kubectlOut(
    [
      '-n',
      'control-plane',
      'exec',
      pgPod,
      '--',
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      'profiles',
      '-c',
      sql,
    ],
    timeout
  )
}

function collectSourceFiles(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === '__tests__' ||
      entry.name === 'node_modules' ||
      entry.name === 'dist' ||
      entry.name === 'ui-dist'
    ) {
      continue
    }

    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      collectSourceFiles(fullPath, files)
      continue
    }

    if (
      /\.(ts|tsx|js|jsx|css|html)$/.test(entry.name) &&
      !/\.test\.(ts|tsx|js|jsx)$/.test(entry.name)
    ) {
      files.push(fullPath)
    }
  }
  return files
}

function assertDesktopBuildMatchesSource(): void {
  if (process.env.E2E_SKIP_DESKTOP_BUILD_FRESHNESS_CHECK === '1') return

  const missingOutputs = DESKTOP_BUILD_OUTPUTS.filter(output => !fs.existsSync(output))
  if (missingOutputs.length) {
    throw new Error(
      `Desktop App build output is missing: ${missingOutputs
        .map(output => path.relative(DESKTOP_APP_ROOT, output))
        .join(', ')}. Run npm run build in desktop-app or use scripts/e2e/playwright-dev.sh.`
    )
  }

  const sourceFiles = DESKTOP_BUILD_INPUT_DIRS.flatMap(dir =>
    fs.existsSync(dir) ? collectSourceFiles(dir) : []
  )
  const newestSource = sourceFiles.reduce(
    (latest, file) => {
      const mtimeMs = fs.statSync(file).mtimeMs
      return mtimeMs > latest.mtimeMs ? { file, mtimeMs } : latest
    },
    { file: '', mtimeMs: 0 }
  )
  const oldestOutput = DESKTOP_BUILD_OUTPUTS.reduce(
    (oldest, file) => {
      const mtimeMs = fs.statSync(file).mtimeMs
      return mtimeMs < oldest.mtimeMs ? { file, mtimeMs } : oldest
    },
    { file: '', mtimeMs: Number.POSITIVE_INFINITY }
  )

  if (newestSource.mtimeMs > oldestOutput.mtimeMs + 1000) {
    throw new Error(
      [
        'Desktop App build output is older than source files.',
        `Newest source: ${path.relative(DESKTOP_APP_ROOT, newestSource.file)}`,
        `Oldest output: ${path.relative(DESKTOP_APP_ROOT, oldestOutput.file)}`,
        'Run npm run build in desktop-app or use scripts/e2e/playwright-dev.sh before running Playwright.',
      ].join(' ')
    )
  }
}

export async function apiRequest(
  method: string,
  url: string,
  body?: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string }> {
  const performRequest = () =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const u = new URL(url)
      const opts: http.RequestOptions = {
        method,
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers: { 'Content-Type': 'application/json', ...headers },
      }
      const req = http.request(opts, res => {
        let data = ''
        res.on('data', chunk => (data += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
      })
      req.on('error', reject)
      if (body) req.write(body)
      req.end()
    })

  for (let attempt = 0; attempt <= API_REQUEST_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await performRequest()
    } catch (error) {
      const message =
        error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
      const code =
        error && typeof error === 'object' && 'code' in error ? String((error as any).code) : ''
      const transient =
        message.includes('socket hang up') ||
        message.includes('fetch failed') ||
        code === 'ECONNRESET' ||
        // The dev E2E suite also runs through port-forwards; a local listener
        // can briefly refuse a socket while kubectl rebinds during churn.
        code === 'ECONNREFUSED' ||
        code === 'EPIPE'
      if (!transient || attempt === API_REQUEST_RETRY_DELAYS_MS.length) {
        throw error
      }
      await new Promise(resolve => setTimeout(resolve, API_REQUEST_RETRY_DELAYS_MS[attempt]))
    }
  }
  throw new Error('apiRequest retry loop exhausted')
}

export async function clearSession() {
  try {
    execFileSync('security', ['delete-generic-password', '-s', 'Evenfire', '-a', 'session-token'], {
      encoding: 'utf-8',
      timeout: 5_000,
    })
  } catch {
    // The keychain item may not exist on a fresh machine.
  }
  const sessionFile = path.join(os.homedir(), '.evenfire', 'session-token.json')
  try {
    fs.unlinkSync(sessionFile)
  } catch {
    // The session file may not exist on a fresh machine.
  }
  const sessionEncFile = path.join(os.homedir(), '.clerum-desktop', 'session-token.enc')
  try {
    fs.unlinkSync(sessionEncFile)
  } catch {
    // The encrypted session file may not exist on a fresh machine.
  }
}

export async function loginAs(
  email = E2E_EMAIL,
  password = E2E_DESKTOP_PASSWORD
): Promise<{ userId: string; userToken: string }> {
  const userId = seedPasswordForEmail(email, password)
  await waitForPasswordLoginReady(email, password)
  const loginRes = await apiRequest(
    'POST',
    `${EXT_API}/api/v1/auth/password-login`,
    JSON.stringify({ email, password })
  )
  if (loginRes.status !== 200) {
    throw new Error(`password-login failed for ${email}: HTTP ${loginRes.status} ${loginRes.body}`)
  }
  const data = JSON.parse(loginRes.body)
  const userToken: string = data.token
  if (!userToken) throw new Error(`password-login for ${email} returned no token`)
  return { userId: data.me?.id ?? userId, userToken }
}

export function seedPasswordForEmail(email: string, password = E2E_DESKTOP_PASSWORD): string {
  if (!password || password.length < 8) {
    throw new Error('E2E desktop password must be at least 8 characters')
  }
  const hash = kubectlOut(
    [
      '-n',
      'control-plane',
      'exec',
      '-i',
      'deploy/control-api',
      '--',
      'node',
      '-e',
      [
        "const bcrypt = require('bcryptjs')",
        "let input = ''",
        "process.stdin.on('data', chunk => { input += chunk })",
        "process.stdin.on('end', async () => {",
        '  const password = input.trim()',
        '  if (!password) process.exit(2)',
        '  console.log(await bcrypt.hash(password, 12))',
        '})',
      ].join(';'),
    ],
    20_000,
    password
  ).trim()
  if (!hash) throw new Error('bcrypt hash generation returned empty output')
  const sql = `
    UPDATE users
       SET password_hash = ${sqlLiteral(hash)},
           password_set_at = NOW(),
           updated_at = NOW()
     WHERE email = ${sqlLiteral(email.toLowerCase())}
     RETURNING id;
  `
  const out = runProfilesSql(sql, 20_000)
  const match = out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
  if (!match) throw new Error(`no password row updated for ${email}`)
  return match[0]
}

export function seedDesktopPasswordLogin(
  userId: string,
  email: string,
  password = E2E_DESKTOP_PASSWORD
): void {
  const passwordFingerprint = createHash('sha256').update(password).digest('hex')
  const cacheKey = `${userId}:${email}:${passwordFingerprint}`
  if (passwordSeededFor.has(cacheKey)) return
  if (!password || password.length < 8) {
    throw new Error('E2E desktop password must be at least 8 characters')
  }

  try {
    const hash = kubectlOut(
      [
        '-n',
        'control-plane',
        'exec',
        '-i',
        'deploy/control-api',
        '--',
        'node',
        '-e',
        [
          "const bcrypt = require('bcryptjs')",
          "let input = ''",
          "process.stdin.on('data', chunk => { input += chunk })",
          "process.stdin.on('end', async () => {",
          '  const password = input.trim()',
          '  if (!password) process.exit(2)',
          '  console.log(await bcrypt.hash(password, 12))',
          '})',
        ].join(';'),
      ],
      20_000,
      password
    ).trim()
    if (!hash) {
      throw new Error('bcrypt hash generation returned empty output')
    }
    const sql = `
      UPDATE users
         SET password_hash = ${sqlLiteral(hash)},
             password_set_at = NOW(),
             updated_at = NOW()
       WHERE id = ${sqlLiteral(userId)}
         AND email = ${sqlLiteral(email.toLowerCase())}
       RETURNING id;
    `
    const result = runProfilesSql(sql, 20_000)
    if (!result.includes(userId)) {
      throw new Error(`no password row updated for ${email}`)
    }
    passwordSeededFor.add(cacheKey)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`failed to seed Desktop password login for ${email}: ${message}`)
  }
}

async function waitForPasswordLoginReady(
  email: string,
  password = E2E_DESKTOP_PASSWORD
): Promise<void> {
  let lastStatus = 0
  let lastBody = ''
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const res = await apiRequest(
      'POST',
      `${EXT_API}/api/v1/auth/password-login`,
      JSON.stringify({ email, password })
    )
    lastStatus = res.status
    lastBody = res.body
    if (res.status === 200) return
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(
    `seeded Desktop password login was not accepted for ${email}: HTTP ${lastStatus} ${lastBody}`
  )
}

export function seedAllowlist(userId: string, recipeName: string): void {
  ensureWorkflowTriggerFixturesSeeded()
  try {
    const userIdSql = sqlLiteral(userId)
    const recipeNsSql = sqlLiteral(RECIPE_NS)
    const recipeNameSql = sqlLiteral(recipeName)
    // User approval targeting and user trigger grants are consolidated into
    // user_workflow_triggers by migration 0014.
    const sql = `
      INSERT INTO user_workflow_triggers (user_id, recipe_namespace, recipe_name)
      VALUES (${userIdSql}, ${recipeNsSql}, ${recipeNameSql})
      ON CONFLICT DO NOTHING;
    `
    runProfilesSql(sql, 10_000)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `failed to seed allowlist for ${RECIPE_NS}/${recipeName} and user ${userId}: ${message}`
    )
  }
}

export function cleanupRecipeRuntimeState(recipeName: string): void {
  assertSafeE2ERecipeName(recipeName)
  ensureWorkflowTriggerFixturesSeeded()

  try {
    const recipeNsSql = sqlLiteral(RECIPE_NS)
    const recipeNameSql = sqlLiteral(recipeName)
    const workflowNames = kubectlOut(
      [
        '-n',
        RECIPE_NS,
        'get',
        'workflowrecipes',
        '-o',
        'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
      ],
      15_000
    )
      .split('\n')
      .map(name => name.trim())
      .filter(Boolean)

    const executionNames = workflowNames.filter(name => name.startsWith(`${recipeName}-`))
    if (executionNames.length > 0) {
      kubectlOut(
        ['-n', RECIPE_NS, 'delete', 'workflowrecipe', ...executionNames, '--ignore-not-found=true'],
        90_000
      )
    }

    // Delete only test-created runtime state for this recipe. This preserves
    // the seeded root recipe, grants, users, teams, and any non-E2E cluster data.
    const sql = `
      DELETE FROM workflow_approval_requests
       WHERE recipe_namespace = ${recipeNsSql}
         AND recipe_name = ${recipeNameSql};
      DELETE FROM workflow_approval_requests_archive
       WHERE recipe_namespace = ${recipeNsSql}
         AND recipe_name = ${recipeNameSql};
      DELETE FROM workflow_runs
       WHERE recipe_namespace = ${recipeNsSql}
         AND recipe_name = ${recipeNameSql};
      DELETE FROM workflow_runs_audit
       WHERE recipe_namespace = ${recipeNsSql}
         AND recipe_name = ${recipeNameSql};
    `
    runProfilesSql(sql, 20_000)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`failed to clean runtime state for ${RECIPE_NS}/${recipeName}: ${message}`)
  }
}

export function ensureWorkflowTriggerFixturesSeeded(): void {
  if (workflowFixturesSeeded) return
  execFileSync('bash', [WORKFLOW_TRIGGER_SEED_SCRIPT], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    timeout: 60_000,
    env: {
      ...process.env,
      CONTEXT: K8S_CONTEXT,
      E2E_DEV_LOGIN_EMAIL: E2E_EMAIL,
    },
  })
  workflowFixturesSeeded = true
}

export async function launchAndLogin(
  email = E2E_EMAIL
): Promise<{ app: ElectronApplication; page: Page }> {
  assertDesktopBuildMatchesSource()
  await clearSession()
  await loginAs(email)
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-e2e-electron-'))

  let app: ElectronApplication
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${userDataDir}`, path.resolve(__dirname, '../../dist/main.js')],
      env: {
        ...process.env,
        ELECTRON_RENDERER_URL: '',
        EXTERNAL_REST_API_BASE_URL: EXT_API,
        RPC_PROXY_BASE_URL: process.env.RPC_PROXY_BASE_URL || 'http://127.0.0.1:8094',
        // Isolate the desktop runtime-config from the global appData profile
        // store. Without this, a stale persisted profile (e.g. a prior run's
        // random port-forward) is auto-activated and overrides the injected
        // localhost URLs, so login fetches a dead port (ECONNREFUSED). Pointing
        // at a non-existent file in the per-test userDataDir yields zero stored
        // profiles, so the app falls back to the localhost/env config. No-op in
        // CI (clean appData); fixes local runs polluted by a real desktop login.
        CLERUM_DESKTOP_CONFIG_PATH:
          process.env.CLERUM_DESKTOP_CONFIG_PATH ||
          path.join(userDataDir, 'e2e-runtime-config.json'),
      },
    })
  } catch (error) {
    fs.rmSync(userDataDir, { recursive: true, force: true })
    throw error
  }
  app.on('close', () => fs.rmSync(userDataDir, { recursive: true, force: true }))

  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  const emailInput = page.locator('#email-input')
  const passwordInput = page.locator('#password-input')
  const settingsMenuButton = page.getByTestId('nav-settings-menu')
  const authenticatedShell = page
    .getByTestId('nav-chat')
    .or(settingsMenuButton)
    .or(page.getByTestId('notification-bell'))
    .first()
  const userDisplayName = page.getByTestId('user-display-name')

  try {
    let entryState: 'loading' | 'login' | 'authenticated' = 'loading'
    await expect
      .poll(
        async () => {
          if (await authenticatedShell.isVisible().catch(() => false)) {
            entryState = 'authenticated'
          } else if (
            (await emailInput.isVisible().catch(() => false)) &&
            (await passwordInput.isVisible().catch(() => false))
          ) {
            entryState = 'login'
          } else {
            entryState = 'loading'
          }
          return entryState
        },
        {
          timeout: 45_000,
          intervals: [250, 500, 1_000],
          message: `waiting for Desktop login or authenticated shell for ${email}`,
        }
      )
      .not.toBe('loading')

    if (entryState === 'login') {
      await emailInput.fill(email)
      await passwordInput.fill(E2E_DESKTOP_PASSWORD)
      const signInButton = page.getByRole('button', { name: /^Sign in$/ })
      await expect(signInButton).toBeEnabled({ timeout: 10_000 })
      await humanUiClick(signInButton)
      await expect
        .poll(
          async () => {
            if (await authenticatedShell.isVisible().catch(() => false)) return 'authenticated'
            const errorToast = page.getByRole('alert').filter({ hasText: /login|password|failed/i })
            if (await errorToast.isVisible().catch(() => false)) return 'error'
            return 'pending'
          },
          {
            timeout: 60_000,
            intervals: [500, 1_000, 2_000],
            message: `waiting for Desktop password login to complete for ${email}`,
          }
        )
        .toBe('authenticated')
    }

    await expect(authenticatedShell).toBeVisible({ timeout: 60_000 })
    await expect(settingsMenuButton).toBeVisible({ timeout: 20_000 })
    await humanUiClick(settingsMenuButton)
    const signedInAccount = page.getByLabel('Signed in account')
    await expect(signedInAccount).toBeVisible({ timeout: 20_000 })
    await expect(userDisplayName).toBeVisible({ timeout: 20_000 })
    await expect(signedInAccount).toContainText(email, { timeout: 20_000 })
    await page.keyboard.press('Escape')
  } catch (error) {
    const bodyText = await page
      .locator('body')
      .innerText({ timeout: 1_000 })
      .catch(() => '')
    await app.close().catch(() => undefined)
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Desktop login did not reach the authenticated dashboard for ${email}: ${message}` +
        (bodyText ? `\nVisible body:\n${bodyText.slice(0, 1000)}` : '')
    )
  }
  return { app, page }
}

export async function openWorkflowsPage(page: Page): Promise<void> {
  await openResourcesNavItem(page, 'nav-workflows')
  await expectWorkflowsPageShell(page)
  const workflows = await rendererListWorkflows(page)
  expect(Array.isArray(workflows.items)).toBe(true)
}

export async function expectWorkflowsPageShell(page: Page): Promise<void> {
  const currentDesktopShell = page.getByRole('heading', { name: 'Plugins', exact: true })
  const currentDashboardShell = page.getByRole('heading', { name: /Workflow Recipes/ })
  await expect(currentDesktopShell.or(currentDashboardShell).first()).toBeVisible({
    timeout: 15_000,
  })
}

export function workflowRow(page: Page, workflowName: string) {
  return page
    .locator('.workflows-list-card .da-grid__row')
    .filter({ hasText: workflowName })
    .first()
}

export async function selectWorkflow(
  page: Page,
  workflowName: string,
  _workflowNamespace?: string
) {
  const row = workflowRow(page, workflowName)
  await expect(row).toBeVisible({ timeout: 30_000 })
  await humanUiClick(row)

  const detailCard = page.locator('.workflows-detail-card')
  await expect(detailCard).toBeVisible({ timeout: 15_000 })
  await expect(detailCard).toHaveAttribute('aria-label', `${workflowName} details`, {
    timeout: 15_000,
  })
  return detailCard
}

export async function rendererListWorkflows(page: Page): Promise<WorkflowRecipeListResult> {
  return page.evaluate(() => (window as any).clerum.workflows.list())
}

export async function rendererReadWorkflow(
  page: Page,
  ns: string,
  name: string
): Promise<Record<string, unknown>> {
  try {
    return await page.evaluate(
      ([recipeNs, recipeName]) => {
        return (window as any).clerum.workflows.read(recipeNs, recipeName)
      },
      [ns, name]
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`rendererReadWorkflow(${ns}/${name}) failed: ${message}`)
  }
}

export async function rendererListWorkflowRuns(
  page: Page,
  ns: string,
  name: string,
  limit = 20
): Promise<WorkflowRunsResult> {
  try {
    return await page.evaluate(
      ([recipeNs, recipeName, recipeLimit]) => {
        return (window as any).clerum.workflows.runs(recipeNs, recipeName, recipeLimit)
      },
      [ns, name, limit]
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`rendererListWorkflowRuns(${ns}/${name}, limit=${limit}) failed: ${message}`)
  }
}

export async function apiListWorkflowRuns(
  sessionToken: string,
  ns: string,
  name: string,
  limit = 20
): Promise<WorkflowRunsResult> {
  const response = await apiRequest(
    'GET',
    `${EXT_API}/api/v1/workflows/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/runs?limit=${limit}`,
    undefined,
    {
      Authorization: `Bearer ${sessionToken}`,
    }
  )
  if (response.status !== 200) {
    throw new Error(`list workflow runs failed: HTTP ${response.status} ${response.body}`)
  }
  return JSON.parse(response.body) as WorkflowRunsResult
}

export async function rendererTriggerWorkflow(
  page: Page,
  ns: string,
  name: string,
  idempotencyKey?: string
): Promise<Record<string, unknown>> {
  try {
    return await page.evaluate(
      ([recipeNs, recipeName, key]) => {
        return (window as any).clerum.workflows.trigger(
          recipeNs,
          recipeName,
          undefined,
          key ?? undefined
        )
      },
      [ns, name, idempotencyKey ?? null]
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`rendererTriggerWorkflow(${ns}/${name}) failed: ${message}`)
  }
}

export async function rendererListPendingApprovals(
  page: Page,
  limit = 20
): Promise<PendingWorkflowApproval[]> {
  try {
    return await page.evaluate(approvalLimit => {
      return (window as any).clerum.approvals.listPending(approvalLimit)
    }, limit)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`rendererListPendingApprovals(limit=${limit}) failed: ${message}`)
  }
}

export async function apiListPendingApprovals(
  sessionToken: string,
  limit = 20
): Promise<PendingWorkflowApproval[]> {
  const response = await apiRequest(
    'GET',
    `${EXT_API}/api/v1/workflow-approvals?limit=${limit}`,
    undefined,
    {
      Authorization: `Bearer ${sessionToken}`,
    }
  )
  if (response.status !== 200) {
    throw new Error(`list pending approvals failed: HTTP ${response.status} ${response.body}`)
  }
  const parsed = JSON.parse(response.body) as { items?: PendingWorkflowApproval[] }
  return Array.isArray(parsed.items) ? parsed.items : []
}

export async function waitForNewRun(
  page: Page,
  ns: string,
  name: string,
  previousIds: string[],
  timeoutMs = 45_000
): Promise<WorkflowRunsResult['items'][number]> {
  let freshRun: WorkflowRunsResult['items'][number] | null = null
  let lastTransientError = ''

  await expect
    .poll(
      async () => {
        try {
          const runs = await rendererListWorkflowRuns(page, ns, name, 20)
          const fresh = (runs.items || []).find(item => !previousIds.includes(item.id))
          if (fresh) {
            freshRun = fresh
            return fresh.id
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
          if (!message.includes('socket hang up') && !message.includes('fetch failed')) {
            throw error
          }
          lastTransientError = message
        }
        return null
      },
      {
        timeout: timeoutMs,
        intervals: [500, 1_000, 2_000],
        message: `timed out waiting for a new run for ${ns}/${name}${
          lastTransientError ? `; last transient error=${lastTransientError}` : ''
        }`,
      }
    )
    .not.toBeNull()

  if (!freshRun) {
    throw new Error(`timed out waiting for a new run for ${ns}/${name}`)
  }
  return freshRun
}

export async function waitForPendingApprovalsToIncrease(
  pageOrSessionToken: Page | string,
  previousIds: string[],
  options: {
    timeoutMs?: number
    recipeNs?: string
    recipeName?: string
  } = {}
): Promise<PendingWorkflowApproval[]> {
  const { timeoutMs = 60_000, recipeNs, recipeName } = options
  const useApi = typeof pageOrSessionToken === 'string'
  let freshApprovals: PendingWorkflowApproval[] = []

  await expect
    .poll(
      async () => {
        const approvals = useApi
          ? await apiListPendingApprovals(pageOrSessionToken, 20)
          : await rendererListPendingApprovals(pageOrSessionToken, 20)
        freshApprovals = approvals.filter(item => {
          if (previousIds.includes(item.id)) return false
          if (recipeNs && item.recipeNamespace !== recipeNs) return false
          if (recipeName && item.recipeName !== recipeName) return false
          return true
        })
        return freshApprovals.length
      },
      {
        timeout: timeoutMs,
        intervals: [750, 1_500, 2_500],
        message: 'timed out waiting for a new pending approval',
      }
    )
    .toBeGreaterThan(0)

  if (freshApprovals.length > 0) return freshApprovals

  let detail = ''
  if (recipeNs && recipeName) {
    try {
      const runs = useApi
        ? await apiListWorkflowRuns(pageOrSessionToken, recipeNs, recipeName, 5)
        : await rendererListWorkflowRuns(pageOrSessionToken, recipeNs, recipeName, 5)
      const latest = runs.items[0]
      if (latest) {
        detail = ` (latest run ${latest.id} phase=${latest.phase} triggeredAt=${latest.triggeredAt ?? 'n/a'} startedAt=${latest.startedAt ?? 'n/a'})`
      }
    } catch {
      // Preserve the original timeout if diagnostics fail.
    }
  }
  throw new Error(`timed out waiting for a new pending approval${detail}`)
}

export function shortRunId(runId: string): string {
  return runId.slice(0, 8)
}
