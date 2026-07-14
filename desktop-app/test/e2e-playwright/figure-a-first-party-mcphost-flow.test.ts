/**
 * 1st-party AuthN, 1st-party MCP-Host workflow trigger.
 *
 * Product route under test:
 * - Operator installs and grants the target workflow through Control UI.
 * - User signs in to Desktop App with password auth and talks to the first-party
 *   shared MCP-host through the Desktop chat UI/RPC proxy path.
 * - The first-party MCP-host requests durable workflow approval and triggers the
 *   target workflow only through the NGINX Host Gateway.
 * - User receives approval.requested asynchronously with the panel closed,
 *   approves through Desktop App, and the target workflow creates one run.
 */
import {
  type ElectronApplication,
  type Locator,
  type Page,
  _electron as electron,
  expect,
  test,
} from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { WorkflowRunArtifact, WorkflowRunListItem } from '../../src/types'
import { openAgentsPage } from './navigationHelpers.js'
import {
  captureE2eEvidence,
  downloadArtifactFromChat,
  expectNoOperationalIds,
  refreshChatArtifactPanel,
} from './workflowAgentChatTools'
import {
  E2E_DESKTOP_PASSWORD,
  E2E_EMAIL,
  EXT_API,
  K8S_CONTEXT,
  RECIPE_NS,
  apiRequest,
  clearSession,
  openWorkflowsPage,
  rendererListWorkflowRuns,
  selectWorkflow,
  shortRunId,
} from './workflowUi'

const CONTROL_UI =
  process.env.CONTROL_UI_BASE_URL || process.env.CONTROL_UI_URL || 'http://127.0.0.1:3000'
const ADMIN_USERNAME = process.env.E2E_ADMIN_USERNAME || process.env.ADMIN_USER || 'admin'
const ADMIN_PASSWORD =
  process.env.E2E_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || process.env.ADMIN_PASS
const E2E_HOST_REF = process.env.E2E_HOST_REF || 'chatllm'
const RUN_STAMP = Date.now()
const TARGET_RECIPE_NAME = `e2e-figa-target-${RUN_STAMP}`
const TARGET_ARTIFACT_NAME = 'figure-a-target-result.json'
const APPROVAL_MESSAGE = `Approve workflow trigger for ${TARGET_RECIPE_NAME}`
const APPROVAL_ATTENTION_TIMEOUT_MS = 300_000

function requireAdminPassword(): string {
  if (!ADMIN_PASSWORD) {
    throw new Error(
      'E2E_ADMIN_PASSWORD is required for Control UI recipe installation. Set E2E_ADMIN_PASSWORD or ADMIN_PASSWORD.'
    )
  }
  return ADMIN_PASSWORD
}

function requireDesktopPassword(): string {
  const password = process.env.E2E_DESKTOP_PASSWORD || process.env.E2E_TEST_PASSWORD
  if (!password) {
    throw new Error(
      'Figure A E2E requires E2E_DESKTOP_PASSWORD or E2E_TEST_PASSWORD. It intentionally does not use the synthetic auth endpoint as evidence.'
    )
  }
  return password
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function kubectl(args: string[], input?: string, timeout = 30_000): string {
  return execFileSync('kubectl', ['--context', K8S_CONTEXT, ...args], {
    encoding: 'utf-8',
    input,
    timeout,
  })
}

function runProfilesSql(sql: string, timeout = 20_000): string {
  return kubectl(
    [
      '-n',
      'control-plane',
      'exec',
      'deploy/control-postgres',
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
    undefined,
    timeout
  )
}

function runProfilesScalar(sql: string, timeout = 20_000): string {
  return kubectl(
    [
      '-n',
      'control-plane',
      'exec',
      'deploy/control-postgres',
      '--',
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-t',
      '-A',
      '-U',
      'postgres',
      '-d',
      'profiles',
      '-c',
      sql,
    ],
    undefined,
    timeout
  ).trim()
}

async function passwordLogin(email: string): Promise<{
  userId: string
  token: string
}> {
  const password = requireDesktopPassword()
  const loginRes = await apiRequest(
    'POST',
    `${EXT_API}/api/v1/auth/password-login`,
    JSON.stringify({ email, password })
  )
  if (loginRes.status !== 200) {
    throw new Error(
      `password-login failed for ${email}: HTTP ${loginRes.status} ${loginRes.body}. Run the cluster seed with Desktop password support.`
    )
  }
  const loginData = JSON.parse(loginRes.body)
  const token: string = loginData.token || loginData.o?.accessToken || loginData.accessToken
  if (!token) {
    throw new Error(`password-login succeeded for ${email} but returned no token`)
  }
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as {
    userId?: string
    sub?: string
  }
  const userId = payload.userId || payload.sub
  if (!userId) {
    throw new Error(`password-login succeeded for ${email} but returned no userId`)
  }
  return { userId, token }
}

async function launchAndPasswordLogin(email: string): Promise<{
  app: ElectronApplication
  page: Page
}> {
  await clearSession()
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-figa-electron-'))
  let app: ElectronApplication
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${userDataDir}`, path.resolve(__dirname, '../../dist/main.js')],
      env: {
        ...process.env,
        ELECTRON_RENDERER_URL: '',
        EXTERNAL_REST_API_BASE_URL: EXT_API,
        RPC_PROXY_BASE_URL: process.env.RPC_PROXY_BASE_URL || 'http://127.0.0.1:8094',
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
  const authenticatedShell = page.getByTestId('nav-settings-menu')

  await expect(emailInput.or(authenticatedShell)).toBeVisible({ timeout: 45_000 })
  if (await emailInput.isVisible().catch(() => false)) {
    await emailInput.fill(email)
    await passwordInput.fill(requireDesktopPassword())
    await page.getByRole('button', { name: /^Sign in$/ }).click()
  }
  await expect(authenticatedShell).toBeVisible({ timeout: 30_000 })

  const session = await page.evaluate(() => (window as any).clerum.auth.getSessionState())
  expect(session?.authenticated, 'Desktop password login should authenticate').toBe(true)
  expect(session?.me?.email, 'Desktop session identity should match the E2E user').toBe(email)
  return { app, page }
}

function buildTargetRecipeManifest(name: string): Record<string, unknown> {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name },
    spec: {
      description:
        '1st-party AuthN, 1st-party MCP-Host target workflow triggered by chatllm after user approval.',
      inputContract: {
        type: 'object',
        properties: {
          marker: { type: 'string', default: `figa-${RUN_STAMP}` },
        },
      },
      triggers: {
        onDemand: {
          requiresApproval: false,
          allowedActors: ['autonomous'],
        },
      },
      runRetention: {
        maxRunDurationSeconds: 600,
        ttlSecondsAfterFinished: 7200,
      },
      output: {
        destination: 'pvc',
        name,
        format: 'json',
        storageSize: '64Mi',
      },
      steps: [
        {
          id: 'emit-target-result',
          timeoutSeconds: 120,
          run: {
            type: 'snippet',
            language: 'typescript',
            code: [
              'const payload = {',
              '  figure: "A",',
              '  route: "desktop-rpc-proxy-first-party-mcphost-gateway",',
              '  marker: sdk.inputs.marker',
              '}',
              `const artifact = await sdk.artifacts.writeJson("${TARGET_ARTIFACT_NAME}", payload)`,
              'return { ...payload, artifact }',
            ].join('\n'),
            capabilities: {
              artifacts: { maxCount: 1 },
            },
          },
        },
      ],
    },
  }
}

async function controlUiLogin(page: Page): Promise<void> {
  const password = requireAdminPassword()
  await page.goto(CONTROL_UI)
  const workflowNav = page.getByRole('button', { name: /Workflow Recipes/i })
  const usernameField = page.getByLabel('Username')
  const passwordField = page.getByLabel('Password')
  const signInButton = page.getByRole('button', { name: /^Sign in$/ })
  await expect
    .poll(
      async () => {
        if (await workflowNav.isVisible().catch(() => false)) return 'authenticated'
        if (await usernameField.isVisible().catch(() => false)) return 'login'
        return 'pending'
      },
      {
        timeout: 25_000,
        intervals: [500, 1_000, 2_000],
        message: 'Control UI should show either the authenticated nav or the login form',
      }
    )
    .toMatch(/^(authenticated|login)$/)
  if (await workflowNav.isVisible().catch(() => false)) return

  await usernameField.fill(ADMIN_USERNAME)
  await passwordField.fill(password)
  await expect(signInButton).toBeEnabled()
  await signInButton.click()
  await expect(workflowNav).toBeVisible({ timeout: 25_000 })
}

async function installRecipeFromControlUi(
  page: Page,
  recipeName: string,
  manifest: Record<string, unknown>,
  userEmail: string
): Promise<void> {
  await controlUiLogin(page)
  await page.goto(`${CONTROL_UI}/workflow-recipes`)
  await page.getByRole('button', { name: 'Install Recipe' }).click()

  const editor = page.locator('textarea').first()
  await expect(editor).toBeVisible({ timeout: 15_000 })
  await editor.fill(JSON.stringify(manifest, null, 2))
  await page.getByRole('button', { name: 'Validate' }).click()
  await expect(page.getByText(/Validation passed/i)).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText(/Validation failed/i)).toHaveCount(0)

  const userPicker = page.getByLabel('Pick a user to grant trigger access')
  await expect(userPicker).toBeVisible({ timeout: 20_000 })
  const optionValue = await userPicker
    .locator('option')
    .filter({ hasText: userEmail })
    .first()
    .getAttribute('value')
  expect(optionValue, `${userEmail} should be selectable in Control UI grants panel`).toBeTruthy()
  await userPicker.selectOption(optionValue!)
  await page.getByRole('button', { name: 'Grant user' }).click()
  await expect(
    page.getByRole('button', { name: `Revoke user trigger access: ${userEmail}` })
  ).toBeVisible({ timeout: 10_000 })

  await page.getByRole('button', { name: 'Deploy Recipe' }).click()
  await expect
    .poll(
      async () => {
        if (
          await page
            .getByRole('link', { name: `Open ${recipeName}` })
            .isVisible()
            .catch(() => false)
        ) {
          return 'deployed'
        }
        const body = await page
          .locator('body')
          .innerText()
          .catch(() => '')
        return /Validation failed|Cannot deploy|\d{3} Internal Server Error/i.test(body)
          ? `error:${body.replace(/\s+/g, ' ').slice(0, 700)}`
          : 'pending'
      },
      {
        timeout: 60_000,
        intervals: [1_000, 2_000, 5_000],
        message: `Control UI should deploy ${RECIPE_NS}/${recipeName} or show a deploy error`,
      }
    )
    .toBe('deployed')
}

async function waitForNotificationStreamReady(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const status = await (window as any).clerum.notifications.status()
          return Number(status?.open || 0) > 0 && Number(status?.snapshot || 0) > 0
        }),
      {
        timeout: 20_000,
        intervals: [250, 500, 1_000],
        message:
          'Desktop notification stream should be connected and have processed its initial snapshot before triggering workflow',
      }
    )
    .toBe(true)
}

async function readNotificationStreamStatus(page: Page): Promise<{
  open: number
  snapshot: number
  approvalRequested: number
}> {
  return page.evaluate(async () => {
    const status = await (window as any).clerum.notifications.status()
    return {
      open: Number(status?.open || 0),
      snapshot: Number(status?.snapshot || 0),
      approvalRequested: Number(status?.approvalRequested || 0),
    }
  })
}

async function waitForStreamDeliveredApprovalAttention(
  page: Page,
  baselineApprovalRequestedEvents: number
): Promise<void> {
  const bell = page.getByTestId('notification-bell')
  await expect(bell).toBeVisible({ timeout: 20_000 })
  await expect(bell).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByTestId('notification-bell-badge')).toBeVisible({
    timeout: APPROVAL_ATTENTION_TIMEOUT_MS,
  })
  await expect(bell).toHaveClass(/has-attention/)
  await expect
    .poll(() => readNotificationStreamStatus(page).then(status => status.approvalRequested), {
      timeout: APPROVAL_ATTENTION_TIMEOUT_MS,
      intervals: [250, 500, 1_000, 2_000],
      message:
        'Desktop notification stream should receive an incremental approval.requested event before the panel is opened',
    })
    .toBeGreaterThan(baselineApprovalRequestedEvents)
}

async function enterFirstPartyHostChat(page: Page): Promise<void> {
  await openAgentsPage(page)
  const chatInput = page.getByTestId('chat-input')
  const agentLink = page.locator('.agents-table-row-clickable', { hasText: E2E_HOST_REF }).first()
  await expect(chatInput.or(agentLink)).toBeVisible({ timeout: 30_000 })
  if (await agentLink.isVisible().catch(() => false)) {
    await agentLink.click()
  }
  await expect(chatInput).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: /^Workflows$/ })).toHaveCount(0)
}

async function startFreshThread(page: Page): Promise<void> {
  const button = page.getByRole('button', { name: /new (?:chat|thread)/i }).first()
  if (
    await button
      .waitFor({ state: 'visible', timeout: 5_000 })
      .then(() => true)
      .catch(() => false)
  ) {
    await button.click()
  } else {
    await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 15_000 })
  }
  await expect(page.getByTestId('agent-response')).toHaveCount(0, { timeout: 10_000 })
}

async function listWorkflowRecipesFromFirstPartyHost(page: Page): Promise<Locator> {
  const prompt = [
    `What workflow recipes can I run?`,
    `For each workflow, tell me the business inputs I need to provide before running it.`,
  ].join(' ')

  const responseCountBefore = await page.getByTestId('agent-response').count()
  await page.getByTestId('chat-input').fill(prompt)
  await page.getByTestId('send-button').click()
  return page.locator(`[data-testid="agent-response"] >> nth=${responseCountBefore}`)
}

async function requestWorkflowTriggerFromFirstPartyHost(page: Page): Promise<Locator> {
  const prompt = [
    `Run ${TARGET_RECIPE_NAME} with marker: figa-${RUN_STAMP}.`,
    `Give me the workflow result and artifact in this chat.`,
  ].join(' ')

  const chatInput = page.getByTestId('chat-input')
  const responseCountBefore = await page.getByTestId('agent-response').count()
  const approvalCountBefore = await page.getByTestId('approval-approve-btn').count()

  await chatInput.fill(prompt)
  await page.getByTestId('send-button').click()

  const localApprovalButton = page.getByTestId('approval-approve-btn').nth(approvalCountBefore)
  await expect(localApprovalButton).toBeVisible({
    timeout: 180_000,
  })
  await localApprovalButton.click()

  return page.locator(`[data-testid="agent-response"] >> nth=${responseCountBefore}`)
}

async function expandLatestProgressStepper(page: Page): Promise<Locator> {
  const stepper = page.getByTestId('progress-stepper').last()
  const expandButton = stepper.getByTestId('progress-expand-btn')
  await expandButton.click()
  await expect(expandButton).toHaveAttribute('aria-expanded', 'true')
  return stepper
}

async function approveWorkflowTriggerFromDesktop(page: Page): Promise<void> {
  const bell = page.getByTestId('notification-bell')
  await expect(bell).toBeVisible({ timeout: 20_000 })
  await bell.click()
  const panel = page.getByRole('dialog', { name: 'Notifications and approvals' })
  await expect(panel).toBeVisible({ timeout: 5_000 })

  const card = panel.getByTestId('workflow-approval-card').filter({ hasText: APPROVAL_MESSAGE })
  await expect(card).toBeVisible({ timeout: 10_000 })
  await expect(card).toContainText(TARGET_RECIPE_NAME)
  const approveButton = card.getByTestId('workflow-approval-approve')
  await expect(approveButton).toBeEnabled({ timeout: 10_000 })
  await approveButton.click()

  await expect(page.getByRole('status').filter({ hasText: 'Approval accepted' })).toBeVisible({
    timeout: 10_000,
  })
  await expect(card).not.toBeVisible({ timeout: 30_000 })
  await bell.click()
}

async function rendererListWorkflowRunArtifacts(
  page: Page,
  recipeName: string,
  runId: string
): Promise<WorkflowRunArtifact[]> {
  const result = await page.evaluate(
    ([recipeNs, workflowName, recipeRunId]) => {
      return (window as any).clerum.workflows.listRunArtifacts(recipeNs, workflowName, recipeRunId)
    },
    [RECIPE_NS, recipeName, runId]
  )
  return Array.isArray(result?.artifacts) ? result.artifacts : []
}

async function waitForSucceededRunWithArtifact(
  page: Page,
  recipeName: string,
  previousIds: string[],
  artifactName: string
): Promise<WorkflowRunListItem> {
  let latestRun: WorkflowRunListItem | undefined
  await expect
    .poll(
      async () => {
        const runs = await rendererListWorkflowRuns(page, RECIPE_NS, recipeName, 20)
        latestRun = runs.items.find(item => !previousIds.includes(item.id))
        if (!latestRun) return 'missing'
        if (latestRun.phase !== 'Succeeded') return latestRun.phase
        const artifacts = await rendererListWorkflowRunArtifacts(page, recipeName, latestRun.id)
        latestRun = { ...latestRun, artifacts }
        return artifacts.some(artifact => artifact.name === artifactName)
          ? 'ready'
          : 'missing-artifact'
      },
      {
        timeout: 420_000,
        intervals: [1_000, 2_000, 5_000],
        message: `${RECIPE_NS}/${recipeName} should create a succeeded run with ${artifactName}`,
      }
    )
    .toBe('ready')

  if (!latestRun) throw new Error(`${RECIPE_NS}/${recipeName} run was not visible`)
  return latestRun
}

async function downloadJsonArtifactFromDesktopRun(
  page: Page,
  runId: string,
  artifactName: string
): Promise<Record<string, unknown>> {
  await page.getByRole('button', { name: /^refresh$/i }).click()
  const runRow = page.getByTestId('workflow-run-row').filter({ hasText: shortRunId(runId) })
  await expect(runRow).toBeVisible({ timeout: 30_000 })
  const artifactButton = runRow.getByRole('button', { name: artifactName })
  await expect(artifactButton).toBeVisible({ timeout: 30_000 })

  const expectedFilename = `${shortRunId(runId)}-${artifactName}`
  const downloadPath = path.join(os.homedir(), 'Downloads', expectedFilename)
  fs.rmSync(downloadPath, { force: true })
  await artifactButton.click()

  await expect
    .poll(
      () => {
        if (!fs.existsSync(downloadPath)) return 0
        return fs.statSync(downloadPath).size
      },
      {
        timeout: 30_000,
        intervals: [250, 500, 1_000],
        message: `Desktop App should save ${expectedFilename} to Downloads`,
      }
    )
    .toBeGreaterThan(0)

  try {
    return JSON.parse(fs.readFileSync(downloadPath, 'utf8')) as Record<string, unknown>
  } finally {
    fs.rmSync(downloadPath, { force: true })
  }
}

function assertApprovalBusinessSignal(expectedCallerKey: string): void {
  const recipeNs = sqlLiteral(RECIPE_NS)
  const recipeName = sqlLiteral(TARGET_RECIPE_NAME)
  const message = sqlLiteral(APPROVAL_MESSAGE)
  const count = runProfilesScalar(
    `
    SELECT COUNT(*)
      FROM workflow_approval_requests war
      JOIN workflow_approval_trigger_intents wati
        ON wati.approval_request_id = war.id
      JOIN workflow_runs wr
        ON wr.approval_request_id = war.id
      JOIN notification_deliveries nd
        ON nd.event_type = 'approval.requested'
       AND nd.payload->>'approvalRequestId' = war.id::text
     WHERE war.recipe_namespace = ${recipeNs}
       AND war.recipe_name = ${recipeName}
       AND war.payload->>'message' = ${message}
       AND war.status = 'consumed'
       AND wati.trigger_namespace = ${recipeNs}
       AND wati.trigger_name = ${recipeName}
       AND wati.trigger_caller_key = ${sqlLiteral(expectedCallerKey)}
       AND wr.recipe_namespace = ${recipeNs}
       AND wr.recipe_name = ${recipeName};
    `,
    20_000
  )
  expect(count).toBe('1')
}

function cleanupRecipe(name: string): void {
  if (!/^e2e-figa-[a-z0-9-]+$/.test(name)) {
    throw new Error(`refusing to clean non-1st-party AuthN, 1st-party MCP-Host E2E recipe ${name}`)
  }

  try {
    const workflowNames = kubectl([
      '-n',
      RECIPE_NS,
      'get',
      'workflowrecipe',
      '-o',
      'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
    ])
      .split('\n')
      .map(item => item.trim())
      .filter(item => item === name || item.startsWith(`${name}-`))
    if (workflowNames.length > 0) {
      kubectl([
        '-n',
        RECIPE_NS,
        'delete',
        'workflowrecipe',
        ...workflowNames,
        '--ignore-not-found=true',
        '--wait=false',
      ])
    }
  } catch {
    // Preserve the original test failure; all names are scoped to this E2E.
  }

  try {
    const ns = sqlLiteral(RECIPE_NS)
    const recipe = sqlLiteral(name)
    runProfilesSql(
      `
      DELETE FROM workflow_runs
       WHERE recipe_namespace = ${ns} AND recipe_name = ${recipe};
      DELETE FROM workflow_runs_audit
       WHERE recipe_namespace = ${ns} AND recipe_name = ${recipe};
      DELETE FROM workflow_approval_requests
       WHERE recipe_namespace = ${ns} AND recipe_name = ${recipe};
      DELETE FROM workflow_approval_requests_archive
       WHERE recipe_namespace = ${ns} AND recipe_name = ${recipe};
      DELETE FROM notification_deliveries
       WHERE payload->>'recipeNamespace' = ${ns}
         AND payload->>'recipeName' = ${recipe};
      DELETE FROM user_workflow_triggers
       WHERE recipe_namespace = ${ns} AND recipe_name = ${recipe};
      DELETE FROM team_workflow_triggers
       WHERE recipe_namespace = ${ns} AND recipe_name = ${recipe};
      DELETE FROM workflow_recipe_allowed_teams
       WHERE recipe_namespace = ${ns} AND recipe_name = ${recipe};
      `,
      30_000
    )
  } catch {
    // Rows are test-named; a later cleanup pass can remove leftovers if needed.
  }
}

test.describe('1st-party AuthN, 1st-party MCP-Host workflow trigger', () => {
  test('installs through Control UI, triggers through first-party MCP-host chat, receives async notification, and creates one target run', async ({
    page: controlPage,
  }, testInfo) => {
    test.slow()
    await clearSession()
    const { userId } = await passwordLogin(E2E_EMAIL)

    cleanupRecipe(TARGET_RECIPE_NAME)
    await installRecipeFromControlUi(
      controlPage,
      TARGET_RECIPE_NAME,
      buildTargetRecipeManifest(TARGET_RECIPE_NAME),
      E2E_EMAIL
    )

    fs.rmSync(path.join(os.homedir(), '.clerum', 'chats', userId, E2E_HOST_REF), {
      recursive: true,
      force: true,
    })

    const { app, page: desktopPage } = await launchAndPasswordLogin(E2E_EMAIL)
    try {
      await openWorkflowsPage(desktopPage)
      const targetRunsBefore = await rendererListWorkflowRuns(
        desktopPage,
        RECIPE_NS,
        TARGET_RECIPE_NAME,
        20
      ).catch(() => ({ items: [] }))
      await waitForNotificationStreamReady(desktopPage)
      const notificationStatusBeforeTrigger = await readNotificationStreamStatus(desktopPage)

      await enterFirstPartyHostChat(desktopPage)
      await startFreshThread(desktopPage)
      await captureE2eEvidence(desktopPage, testInfo, 'figure-a-chat-ready-no-workflows-button')
      const listResponse = await listWorkflowRecipesFromFirstPartyHost(desktopPage)
      await expect(listResponse).toBeVisible({ timeout: 180_000 })
      await expect(listResponse).toContainText(TARGET_RECIPE_NAME, { timeout: 180_000 })
      await expect(listResponse).toContainText(/marker/i)
      await expectNoOperationalIds(listResponse)
      const listProgressStepper = await expandLatestProgressStepper(desktopPage)
      await expect(listProgressStepper).toContainText(/workflow_list/i)
      await captureE2eEvidence(desktopPage, testInfo, 'figure-a-granted-workflow-inputs-listed')
      const agentResponse = await requestWorkflowTriggerFromFirstPartyHost(desktopPage)

      await waitForStreamDeliveredApprovalAttention(
        desktopPage,
        notificationStatusBeforeTrigger.approvalRequested
      )
      await approveWorkflowTriggerFromDesktop(desktopPage)

      await expect(agentResponse).toBeVisible({ timeout: 240_000 })
      const progressStepper = await expandLatestProgressStepper(desktopPage)
      await expect(progressStepper).toContainText(/workflow_trigger/i)

      const targetRun = await waitForSucceededRunWithArtifact(
        desktopPage,
        TARGET_RECIPE_NAME,
        targetRunsBefore.items.map(item => item.id),
        TARGET_ARTIFACT_NAME
      )
      const chatPanel = await refreshChatArtifactPanel(
        desktopPage,
        targetRun.id,
        TARGET_ARTIFACT_NAME
      )
      const chatArtifact = JSON.parse(
        (
          await downloadArtifactFromChat(desktopPage, chatPanel, targetRun.id, TARGET_ARTIFACT_NAME)
        ).toString('utf8')
      ) as Record<string, unknown>
      expect(chatArtifact).toMatchObject({
        figure: 'A',
        route: 'desktop-rpc-proxy-first-party-mcphost-gateway',
        marker: `figa-${RUN_STAMP}`,
      })
      await captureE2eEvidence(desktopPage, testInfo, 'figure-a-chat-artifact-downloaded')

      await openWorkflowsPage(desktopPage)
      const targetDetail = await selectWorkflow(desktopPage, TARGET_RECIPE_NAME, RECIPE_NS)
      await expect(targetDetail.getByRole('heading', { name: 'Recent Runs' })).toBeVisible()
      const artifact = await downloadJsonArtifactFromDesktopRun(
        desktopPage,
        targetRun.id,
        TARGET_ARTIFACT_NAME
      )
      expect(artifact).toMatchObject({
        figure: 'A',
        route: 'desktop-rpc-proxy-first-party-mcphost-gateway',
        marker: `figa-${RUN_STAMP}`,
      })
      expect(artifact).toMatchObject(chatArtifact)
      await captureE2eEvidence(desktopPage, testInfo, 'figure-a-marketplace-same-run-artifact')
      assertApprovalBusinessSignal(E2E_HOST_REF)
    } finally {
      await app.close()
      cleanupRecipe(TARGET_RECIPE_NAME)
    }
  })
})
