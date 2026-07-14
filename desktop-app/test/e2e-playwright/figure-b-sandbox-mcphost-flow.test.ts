/**
 * 1st-party AuthN, 3rd-party MCP-Host (recipe sandbox).
 *
 * Product route under test:
 * - Operator installs and grants recipes through Control UI.
 * - User signs in and triggers the caller workflow through Desktop App.
 * - Sandbox mcp-host requests approval and then triggers the target workflow
 *   through the host gateway.
 * - User approves through Desktop App.
 * - Desktop App shows the target run and its run-scoped artifact.
 */
import { type Page, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { WorkflowRunArtifact, WorkflowRunListItem } from '../../src/types'
import {
  adminCreateTeamForUser,
  allowTeamApprovalThroughAdminRoute,
  grantTeamThroughAdminRoute,
  setUserWorkflowGrantsThroughAdminRoute,
} from './workflow-approval-quadrants/recipes'
import {
  E2E_EMAIL,
  K8S_CONTEXT,
  RECIPE_NS,
  clearSession,
  launchAndLogin,
  loginAs,
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
const MODEL_PROVIDER =
  process.env.E2E_WORKFLOW_MODEL_PROVIDER || process.env.CLERUM_MODEL_PROVIDER || 'zai'
const MODEL_NAME = process.env.E2E_WORKFLOW_MODEL_NAME || process.env.CLERUM_MODEL_NAME || 'glm-4.7'
const RUN_STAMP = Date.now()
const TARGET_RECIPE_NAME = `e2e-figb-target-${RUN_STAMP}`
const CALLER_RECIPE_NAME = `e2e-figb-caller-${RUN_STAMP}`
const CALLER_LIST_STEP_ID = 'sandbox-host-lists-workflows'
const CALLER_READ_STEP_ID = 'sandbox-host-reads-target'
const CALLER_TRIGGER_STEP_ID = 'sandbox-host-triggers-target'
const TARGET_ARTIFACT_NAME = 'figure-b-target-result.json'
const APPROVAL_MESSAGE = `1st-party AuthN, 3rd-party MCP-Host approval ${RUN_STAMP}`
const APPROVAL_ATTENTION_TIMEOUT_MS = 300_000
const PENDING_APPROVAL_CREATION_TIMEOUT_MS = 300_000
const WRONG_USER_APPROVAL_TIMEOUT_SECONDS = 120
const WRONG_TEAM_APPROVAL_TIMEOUT_SECONDS = 120

type ApprovalTargetArgs =
  | {
      targetUserId: string
    }
  | {
      targetTeamId: string
    }

function requireAdminPassword(): string {
  if (!ADMIN_PASSWORD) {
    throw new Error(
      'E2E_ADMIN_PASSWORD is required for Control UI recipe installation. Set E2E_ADMIN_PASSWORD or ADMIN_PASSWORD.'
    )
  }
  return ADMIN_PASSWORD
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function teamIdFromSessionToken(sessionToken: string): string {
  const payload = JSON.parse(Buffer.from(sessionToken.split('.')[1], 'base64url').toString()) as {
    teamId?: unknown
  }
  const teamId = String(payload.teamId || '').trim()
  expect(teamId).toMatch(/^[0-9a-f-]{36}$/i)
  return teamId
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

function buildTargetRecipeManifest(name: string): Record<string, unknown> {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name },
    spec: {
      description:
        '1st-party AuthN, 3rd-party MCP-Host target workflow triggered by a sandbox MCP-host after user approval.',
      inputContract: {
        type: 'object',
        properties: {
          marker: { type: 'string', default: `figb-${RUN_STAMP}` },
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
              '  figure: "B",',
              '  route: "desktop-approval-to-sandbox-mcphost-gateway",',
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

function buildCallerRecipeManifestForApprovalTarget(
  name: string,
  targetRecipeName: string,
  approvalTarget: ApprovalTargetArgs,
  options: {
    approvalMessage?: string
    approvalTimeoutSeconds?: number
    idempotencyKey?: string
  } = {}
): Record<string, unknown> {
  const approvalMessage = options.approvalMessage ?? APPROVAL_MESSAGE
  const triggerArgs = {
    namespace: RECIPE_NS,
    name: targetRecipeName,
    ...approvalTarget,
    approvalMessage,
    timeoutSeconds: options.approvalTimeoutSeconds ?? 180,
    idempotencyKey: options.idempotencyKey ?? `figb-trigger-${RUN_STAMP}`,
    inputs: { marker: `figb-${RUN_STAMP}` },
  }

  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name },
    spec: {
      description:
        '1st-party AuthN, 3rd-party MCP-Host caller workflow running a sandbox MCP-host that triggers a target workflow.',
      agent: { provider: MODEL_PROVIDER, model: MODEL_NAME },
      triggers: {
        onDemand: {
          requiresApproval: false,
          allowedActors: ['user'],
        },
      },
      runRetention: {
        maxRunDurationSeconds: 600,
        ttlSecondsAfterFinished: 7200,
      },
      steps: [
        {
          id: CALLER_LIST_STEP_ID,
          timeoutSeconds: 120,
          maxIterations: 3,
          toolChoice: 'required',
          allowedTools: {
            include: ['clerum__list_workflows'],
          },
          instruction: [
            'Call clerum__list_workflows exactly once with this JSON argument:',
            JSON.stringify(approvalTarget, null, 2),
            'After the tool returns, respond with FIGURE_B_LIST_DONE.',
          ].join('\n'),
        },
        {
          id: CALLER_READ_STEP_ID,
          dependsOn: [CALLER_LIST_STEP_ID],
          timeoutSeconds: 120,
          maxIterations: 3,
          toolChoice: 'required',
          allowedTools: {
            include: ['clerum__read_workflow'],
          },
          instruction: [
            'Call clerum__read_workflow exactly once with this JSON argument:',
            JSON.stringify(
              { namespace: RECIPE_NS, name: targetRecipeName, ...approvalTarget },
              null,
              2
            ),
            'After the tool returns, respond with FIGURE_B_READ_DONE.',
          ].join('\n'),
        },
        {
          id: CALLER_TRIGGER_STEP_ID,
          dependsOn: [CALLER_READ_STEP_ID],
          timeoutSeconds: 240,
          maxIterations: 3,
          toolChoice: 'required',
          allowedTools: {
            include: ['clerum__trigger_workflow'],
          },
          instruction: [
            'Call clerum__trigger_workflow exactly once with this JSON argument:',
            JSON.stringify(triggerArgs, null, 2),
            'After the tool returns, respond with FIGURE_B_TRIGGER_DONE.',
          ].join('\n'),
        },
      ],
    },
  }
}

function buildCallerRecipeManifest(
  name: string,
  targetRecipeName: string,
  targetUserId: string,
  options: {
    approvalMessage?: string
    approvalTimeoutSeconds?: number
    idempotencyKey?: string
  } = {}
): Record<string, unknown> {
  return buildCallerRecipeManifestForApprovalTarget(
    name,
    targetRecipeName,
    { targetUserId },
    options
  )
}

function buildTeamTargetCallerRecipeManifest(
  name: string,
  targetRecipeName: string,
  targetTeamId: string,
  options: {
    approvalMessage?: string
    approvalTimeoutSeconds?: number
    idempotencyKey?: string
  } = {}
): Record<string, unknown> {
  return buildCallerRecipeManifestForApprovalTarget(
    name,
    targetRecipeName,
    { targetTeamId },
    options
  )
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
  if (await workflowNav.isVisible().catch(() => false)) {
    return
  }

  await expect(usernameField).toBeVisible()
  await expect(passwordField).toBeVisible()
  await usernameField.fill(ADMIN_USERNAME)
  await passwordField.fill(password)
  await expect(signInButton).toBeEnabled()
  await signInButton.click()
  await expect(workflowNav).toBeVisible({ timeout: 25_000 })
}

function visibleInstallFailureText(body: string): string | null {
  const patterns = [
    /Validation failed[\s\S]{0,800}/i,
    /Cannot deploy[\s\S]{0,800}/i,
    /\d{3} Internal Server Error[\s\S]{0,800}/i,
    /Unsupported value[\s\S]{0,800}/i,
    /policy violation[\s\S]{0,800}/i,
  ]
  for (const pattern of patterns) {
    const match = body.match(pattern)
    if (match?.[0]) return match[0].replace(/\s+/g, ' ').slice(0, 700)
  }
  return null
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
        const failure = visibleInstallFailureText(body)
        return failure ? `error:${failure}` : 'pending'
      },
      {
        timeout: 60_000,
        intervals: [1_000, 2_000, 5_000],
        message: `Control UI should deploy ${RECIPE_NS}/${recipeName} or show a deploy error`,
      }
    )
    .toBe('deployed')
}

async function approveWorkflowTriggerFromDesktop(
  page: Page,
  approvalMessage: string
): Promise<void> {
  const bell = page.getByTestId('notification-bell')
  await expect(bell).toBeVisible({ timeout: 20_000 })
  await bell.click()
  const panel = page.getByRole('dialog', { name: 'Notifications and approvals' })
  await expect(panel).toBeVisible({ timeout: 5_000 })

  const card = panel.getByTestId('workflow-approval-card').filter({ hasText: approvalMessage })
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

async function assertNoApprovalVisibleForDesktop(
  page: Page,
  approvalMessage: string
): Promise<void> {
  const bell = page.getByTestId('notification-bell')
  await expect(bell).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('notification-bell-badge')).toHaveCount(0)
  await bell.click()
  const panel = page.getByRole('dialog', { name: 'Notifications and approvals' })
  await expect(panel).toBeVisible({ timeout: 5_000 })
  await expect(
    panel.getByTestId('workflow-approval-card').filter({ hasText: approvalMessage })
  ).toHaveCount(0)
  await bell.click()
}

async function waitForNotificationStreamReady(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const status = await (window as any).clerum.notifications.status()
          return Number(status?.open || 0)
        }),
      {
        timeout: 20_000,
        intervals: [250, 500, 1_000],
        message: 'Desktop notification stream should be connected before triggering workflow',
      }
    )
    .toBeGreaterThan(0)
}

async function readNotificationStreamStatus(page: Page): Promise<{
  open: number
  approvalRequested: number
}> {
  return page.evaluate(async () => {
    const status = await (window as any).clerum.notifications.status()
    return {
      open: Number(status?.open || 0),
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
      timeout: 5_000,
      intervals: [250, 500],
      message: 'Desktop notification stream should receive an incremental approval.requested event',
    })
    .toBeGreaterThan(baselineApprovalRequestedEvents)
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

function getWorkflowStepToolNames(recipeName: string, stepId: string): string[] {
  const recipe = JSON.parse(
    kubectl(['-n', RECIPE_NS, 'get', 'workflowrecipe', recipeName, '-o', 'json'])
  ) as {
    status?: {
      steps?: Array<{
        id?: unknown
        toolsCalled?: Array<{ serverName?: unknown; toolName?: unknown }>
      }>
    }
  }
  const step = recipe.status?.steps?.find(item => item.id === stepId)
  return (
    step?.toolsCalled
      ?.map(item =>
        typeof item.serverName === 'string' && typeof item.toolName === 'string'
          ? `${item.serverName}__${item.toolName}`
          : ''
      )
      .filter(Boolean) ?? []
  )
}

async function assertCallerUsedWorkflowBrokerTools(recipeName: string): Promise<void> {
  await expect
    .poll(
      () => [
        ...getWorkflowStepToolNames(recipeName, CALLER_LIST_STEP_ID),
        ...getWorkflowStepToolNames(recipeName, CALLER_READ_STEP_ID),
        ...getWorkflowStepToolNames(recipeName, CALLER_TRIGGER_STEP_ID),
      ],
      {
        timeout: 60_000,
        intervals: [1_000, 2_000, 5_000],
        message: 'sandbox caller should use list/read/trigger workflow broker tools',
      }
    )
    .toEqual(
      expect.arrayContaining([
        'clerum__list_workflows',
        'clerum__read_workflow',
        'clerum__trigger_workflow',
      ])
    )
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

async function waitForSucceededRun(
  page: Page,
  recipeName: string,
  previousIds: string[]
): Promise<WorkflowRunListItem> {
  let latestRun: WorkflowRunListItem | undefined

  await expect
    .poll(
      async () => {
        const runs = await rendererListWorkflowRuns(page, RECIPE_NS, recipeName, 20)
        latestRun = runs.items.find(item => !previousIds.includes(item.id))
        if (!latestRun) return 'missing'
        return latestRun.phase
      },
      {
        timeout: 420_000,
        intervals: [1_000, 2_000, 5_000],
        message: `${RECIPE_NS}/${recipeName} should create a succeeded run`,
      }
    )
    .toBe('Succeeded')

  if (!latestRun) throw new Error(`${RECIPE_NS}/${recipeName} run was not visible`)
  return latestRun
}

async function waitForTerminalRun(
  page: Page,
  recipeName: string,
  previousIds: string[]
): Promise<WorkflowRunListItem> {
  let latestRun: WorkflowRunListItem | undefined

  await expect
    .poll(
      async () => {
        const runs = await rendererListWorkflowRuns(page, RECIPE_NS, recipeName, 20)
        latestRun = runs.items.find(item => !previousIds.includes(item.id))
        if (!latestRun) return 'missing'
        return latestRun.phase
      },
      {
        timeout: 300_000,
        intervals: [1_000, 2_000, 5_000],
        message: `${RECIPE_NS}/${recipeName} should reach a terminal run phase`,
      }
    )
    .toMatch(/^(Succeeded|Failed|Cancelled|Error)$/)

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

function assertApprovalBusinessSignal(
  targetRecipeName: string,
  approvalMessage: string,
  expectedCallerKey?: string
): void {
  const recipeNs = sqlLiteral(RECIPE_NS)
  const recipeName = sqlLiteral(targetRecipeName)
  const message = sqlLiteral(approvalMessage)
  const callerPredicate = expectedCallerKey
    ? `AND wati.trigger_caller_key = ${sqlLiteral(expectedCallerKey)}`
    : ''
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
       ${callerPredicate}
       AND wr.recipe_namespace = ${recipeNs}
       AND wr.recipe_name = ${recipeName};
    `,
    20_000
  )
  expect(count).toBe('1')
}

function countPendingApprovalWithNotification(
  targetRecipeName: string,
  approvalMessage: string
): string {
  const recipeNs = sqlLiteral(RECIPE_NS)
  const recipeName = sqlLiteral(targetRecipeName)
  const message = sqlLiteral(approvalMessage)
  return runProfilesScalar(
    `
    SELECT COUNT(*)
      FROM workflow_approval_requests war
      JOIN workflow_approval_trigger_intents wati
        ON wati.approval_request_id = war.id
      JOIN notification_deliveries nd
        ON nd.event_type = 'approval.requested'
       AND nd.payload->>'approvalRequestId' = war.id::text
     WHERE war.recipe_namespace = ${recipeNs}
       AND war.recipe_name = ${recipeName}
       AND war.payload->>'message' = ${message}
       AND war.status = 'pending'
       AND wati.trigger_namespace = ${recipeNs}
       AND wati.trigger_name = ${recipeName};
    `,
    20_000
  )
}

function countWorkflowRuns(recipeName: string): string {
  const recipeNs = sqlLiteral(RECIPE_NS)
  const recipe = sqlLiteral(recipeName)
  return runProfilesScalar(
    `
    SELECT COUNT(*)
      FROM workflow_runs
     WHERE recipe_namespace = ${recipeNs}
       AND recipe_name = ${recipe};
    `,
    20_000
  )
}

function cleanupRecipe(name: string): void {
  if (!/^e2e-figb-[a-z0-9-]+$/.test(name)) {
    throw new Error(`refusing to clean non-1st-party AuthN, 3rd-party MCP-Host E2E recipe ${name}`)
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
       WHERE event_type = 'approval.requested'
         AND payload->>'recipeNamespace' = ${ns}
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

function cleanupTeam(teamId: string | undefined): void {
  if (!teamId) return
  if (!/^[0-9a-f-]{36}$/i.test(teamId)) {
    throw new Error(`refusing to clean non-E2E team id ${teamId}`)
  }
  try {
    const team = sqlLiteral(teamId)
    runProfilesSql(
      `
      DELETE FROM team_workflow_grants_audit
       WHERE target_team_id = ${team};
      DELETE FROM workflow_recipe_allowed_teams_audit
       WHERE target_team_id = ${team};
      DELETE FROM team_workflow_triggers
       WHERE team_id = ${team};
      DELETE FROM workflow_recipe_allowed_teams
       WHERE team_id = ${team};
      DELETE FROM team_members
       WHERE team_id = ${team};
      DELETE FROM teams
       WHERE id = ${team};
      `,
      20_000
    )
  } catch {
    // Preserve the original test failure; all team rows are scoped to this E2E.
  }
}

test.describe('1st-party AuthN, 3rd-party MCP-Host (recipe sandbox) workflow trigger', () => {
  test('installs through Control UI, triggers and approves through Desktop App, and creates the target run', async ({
    page: controlPage,
  }) => {
    test.slow()
    await clearSession()
    const { userId } = await loginAs(E2E_EMAIL)

    cleanupRecipe(CALLER_RECIPE_NAME)
    cleanupRecipe(TARGET_RECIPE_NAME)

    await installRecipeFromControlUi(
      controlPage,
      TARGET_RECIPE_NAME,
      buildTargetRecipeManifest(TARGET_RECIPE_NAME),
      E2E_EMAIL
    )
    await installRecipeFromControlUi(
      controlPage,
      CALLER_RECIPE_NAME,
      buildCallerRecipeManifest(CALLER_RECIPE_NAME, TARGET_RECIPE_NAME, userId),
      E2E_EMAIL
    )

    const { app, page: desktopPage } = await launchAndLogin(E2E_EMAIL)
    try {
      await openWorkflowsPage(desktopPage)
      await waitForNotificationStreamReady(desktopPage)
      const streamStatusBeforeTrigger = await readNotificationStreamStatus(desktopPage)
      const targetRunsBefore = await rendererListWorkflowRuns(
        desktopPage,
        RECIPE_NS,
        TARGET_RECIPE_NAME,
        20
      ).catch(() => ({ items: [] }))
      const callerRunsBefore = await rendererListWorkflowRuns(
        desktopPage,
        RECIPE_NS,
        CALLER_RECIPE_NAME,
        20
      ).catch(() => ({ items: [] }))

      const callerDetail = await selectWorkflow(desktopPage, CALLER_RECIPE_NAME, RECIPE_NS)
      const triggerButton = callerDetail.getByRole('button', { name: /^trigger$/i })
      await expect(triggerButton).toBeVisible({ timeout: 20_000 })
      await triggerButton.click()
      await expect(
        desktopPage.getByRole('status').filter({ hasText: 'Workflow triggered.' })
      ).toBeVisible({ timeout: 10_000 })

      await waitForStreamDeliveredApprovalAttention(
        desktopPage,
        streamStatusBeforeTrigger.approvalRequested
      )
      await approveWorkflowTriggerFromDesktop(desktopPage, APPROVAL_MESSAGE)

      const targetDetail = await selectWorkflow(desktopPage, TARGET_RECIPE_NAME, RECIPE_NS)
      await expect(targetDetail.getByRole('heading', { name: 'Recent Runs' })).toBeVisible()
      const targetRun = await waitForSucceededRunWithArtifact(
        desktopPage,
        TARGET_RECIPE_NAME,
        targetRunsBefore.items.map(item => item.id),
        TARGET_ARTIFACT_NAME
      )
      const callerRun = await waitForSucceededRun(
        desktopPage,
        CALLER_RECIPE_NAME,
        callerRunsBefore.items.map(item => item.id)
      )
      expect(
        callerRun.executionRef?.name,
        'caller run should expose its child execution ref'
      ).toEqual(expect.stringMatching(new RegExp(`^${CALLER_RECIPE_NAME}-`)))
      await assertCallerUsedWorkflowBrokerTools(callerRun.executionRef!.name)
      // trigger_caller_key is the logical WRC caller binding, not the per-run child name.
      const expectedCallerKey = `${RECIPE_NS}/${CALLER_RECIPE_NAME}`
      const artifact = await downloadJsonArtifactFromDesktopRun(
        desktopPage,
        targetRun.id,
        TARGET_ARTIFACT_NAME
      )
      expect(artifact).toMatchObject({
        figure: 'B',
        route: 'desktop-approval-to-sandbox-mcphost-gateway',
        marker: `figb-${RUN_STAMP}`,
      })
      assertApprovalBusinessSignal(TARGET_RECIPE_NAME, APPROVAL_MESSAGE, expectedCallerKey)
    } finally {
      await app.close()
      cleanupRecipe(CALLER_RECIPE_NAME)
      cleanupRecipe(TARGET_RECIPE_NAME)
    }
  })

  test('does not deliver approval notifications or target runs to the wrong Desktop user', async ({
    page: controlPage,
  }) => {
    test.slow()
    await clearSession()
    const { userId: targetUserId } = await loginAs(E2E_EMAIL)
    const wrongUserEmail = `e2e-figb-wrong-${RUN_STAMP}@clerum.io`
    await loginAs(wrongUserEmail)

    const targetRecipeName = `e2e-figb-target-wrong-user-${RUN_STAMP}`
    const callerRecipeName = `e2e-figb-caller-wrong-user-${RUN_STAMP}`
    const approvalMessage = `1st-party AuthN, 3rd-party MCP-Host wrong-user approval ${RUN_STAMP}`

    cleanupRecipe(callerRecipeName)
    cleanupRecipe(targetRecipeName)

    await installRecipeFromControlUi(
      controlPage,
      targetRecipeName,
      buildTargetRecipeManifest(targetRecipeName),
      E2E_EMAIL
    )
    await installRecipeFromControlUi(
      controlPage,
      callerRecipeName,
      buildCallerRecipeManifest(callerRecipeName, targetRecipeName, targetUserId, {
        approvalMessage,
        approvalTimeoutSeconds: WRONG_USER_APPROVAL_TIMEOUT_SECONDS,
        idempotencyKey: `figb-wrong-user-${RUN_STAMP}`,
      }),
      wrongUserEmail
    )

    const { app, page: desktopPage } = await launchAndLogin(wrongUserEmail)
    try {
      await openWorkflowsPage(desktopPage)
      await waitForNotificationStreamReady(desktopPage)
      const streamStatusBeforeTrigger = await readNotificationStreamStatus(desktopPage)
      expect(countWorkflowRuns(targetRecipeName)).toBe('0')

      const callerDetail = await selectWorkflow(desktopPage, callerRecipeName, RECIPE_NS)
      const triggerButton = callerDetail.getByRole('button', { name: /^trigger$/i })
      await expect(triggerButton).toBeVisible({ timeout: 20_000 })
      await triggerButton.click()
      await expect(
        desktopPage.getByRole('status').filter({ hasText: 'Workflow triggered.' })
      ).toBeVisible({ timeout: 10_000 })

      await expect
        .poll(() => countPendingApprovalWithNotification(targetRecipeName, approvalMessage), {
          timeout: PENDING_APPROVAL_CREATION_TIMEOUT_MS,
          intervals: [1_000, 2_000, 5_000],
          message: 'sandbox caller should create a pending approval for the target user only',
        })
        .toBe('1')

      expect((await readNotificationStreamStatus(desktopPage)).approvalRequested).toBe(
        streamStatusBeforeTrigger.approvalRequested
      )
      await assertNoApprovalVisibleForDesktop(desktopPage, approvalMessage)
      expect(countWorkflowRuns(targetRecipeName)).toBe('0')
    } finally {
      await app.close()
      cleanupRecipe(callerRecipeName)
      cleanupRecipe(targetRecipeName)
    }
  })

  test('does not create an approval or target run when the approval targets Team A but only Team B has trigger grant', async ({
    page: controlPage,
  }) => {
    test.slow()
    await clearSession()
    const { userId, userToken } = await loginAs(E2E_EMAIL)
    const teamAId = teamIdFromSessionToken(userToken)
    const teamBName = `e2e figb wrong team ${RUN_STAMP}`
    let teamBId: string | undefined

    const targetRecipeName = `e2e-figb-target-wrong-team-${RUN_STAMP}`
    const callerRecipeName = `e2e-figb-caller-wrong-team-${RUN_STAMP}`
    const approvalMessage = `1st-party AuthN, 3rd-party MCP-Host wrong-team approval ${RUN_STAMP}`

    cleanupRecipe(callerRecipeName)
    cleanupRecipe(targetRecipeName)

    try {
      await installRecipeFromControlUi(
        controlPage,
        targetRecipeName,
        buildTargetRecipeManifest(targetRecipeName),
        E2E_EMAIL
      )
      await setUserWorkflowGrantsThroughAdminRoute(RECIPE_NS, targetRecipeName, [])
      teamBId = await adminCreateTeamForUser(teamBName, userId)
      await grantTeamThroughAdminRoute(RECIPE_NS, targetRecipeName, teamBId)
      await allowTeamApprovalThroughAdminRoute(RECIPE_NS, targetRecipeName, teamAId)

      await installRecipeFromControlUi(
        controlPage,
        callerRecipeName,
        buildTeamTargetCallerRecipeManifest(callerRecipeName, targetRecipeName, teamAId, {
          approvalMessage,
          approvalTimeoutSeconds: WRONG_TEAM_APPROVAL_TIMEOUT_SECONDS,
          idempotencyKey: `figb-wrong-team-${RUN_STAMP}`,
        }),
        E2E_EMAIL
      )

      const { app, page: desktopPage } = await launchAndLogin(E2E_EMAIL)
      try {
        await openWorkflowsPage(desktopPage)
        await waitForNotificationStreamReady(desktopPage)
        const streamStatusBeforeTrigger = await readNotificationStreamStatus(desktopPage)
        const callerRunsBefore = await rendererListWorkflowRuns(
          desktopPage,
          RECIPE_NS,
          callerRecipeName,
          20
        ).catch(() => ({ items: [] }))
        expect(countWorkflowRuns(targetRecipeName)).toBe('0')

        const callerDetail = await selectWorkflow(desktopPage, callerRecipeName, RECIPE_NS)
        const triggerButton = callerDetail.getByRole('button', { name: /^trigger$/i })
        await expect(triggerButton).toBeVisible({ timeout: 20_000 })
        await triggerButton.click()
        await expect(
          desktopPage.getByRole('status').filter({ hasText: 'Workflow triggered.' })
        ).toBeVisible({ timeout: 10_000 })

        const callerRun = await waitForTerminalRun(
          desktopPage,
          callerRecipeName,
          callerRunsBefore.items.map(item => item.id)
        )
        expect(callerRun.id).toBeTruthy()
        expect(countPendingApprovalWithNotification(targetRecipeName, approvalMessage)).toBe('0')
        expect((await readNotificationStreamStatus(desktopPage)).approvalRequested).toBe(
          streamStatusBeforeTrigger.approvalRequested
        )
        await assertNoApprovalVisibleForDesktop(desktopPage, approvalMessage)
        expect(countWorkflowRuns(targetRecipeName)).toBe('0')
      } finally {
        await app.close()
      }
    } finally {
      cleanupRecipe(callerRecipeName)
      cleanupRecipe(targetRecipeName)
      cleanupTeam(teamBId)
    }
  })
})
