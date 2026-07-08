import { type Page, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import {
  E2E_EMAIL,
  EXT_API,
  K8S_CONTEXT,
  RECIPE_NS,
  apiRequest,
  clearSession,
  launchAndLogin,
  loginAs,
} from './workflowUi'

const SALES_CRM_RECIPE = 'e2e-sandbox-ui-sales-crm'
const AUTHZ_HARNESS_RECIPE = 'e2e-sandbox-ui-authz-harness'
const UNAUTHORIZED_RECIPE = 'e2e-sandbox-ui-unauthorized'
const SALES_CRM_WORKLOAD = 'sales-crm-web'
const AUTHZ_HARNESS_WORKLOAD = 'authz-harness-web'
const UNAUTHORIZED_WORKLOAD = 'unauthorized-web'
const SANDBOX_UI_NS = 'sandbox-ui'
const RPC_PROXY =
  process.env.RPC_PROXY_BASE_URL || process.env.E2E_RPC_PROXY_URL || 'http://127.0.0.1:8094'
const SANDBOX_UI_RPC_HOST_REF = 'sandbox-ui'
const SAFE_RECIPE_RE = /^e2e-sandbox-ui-[a-z0-9-]+$/

function assertSafeRecipeName(name: string): void {
  if (!SAFE_RECIPE_RE.test(name)) {
    throw new Error(`refusing to mutate non-E2E sandbox-ui recipe "${name}"`)
  }
}

function assertSafeWorkloadId(id: string): void {
  if (!/^[a-z0-9-]+$/.test(id)) {
    throw new Error(`refusing to use unsafe E2E sandbox-ui workload id "${id}"`)
  }
}

// E2E-only SQL literal helper. Values are controlled by this spec:
// recipe names pass assertSafeRecipeName(), user/team ids come from JWTs or DB
// UUID rows, and titles/paths only flow into Kubernetes YAML via JSON.stringify.
function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function kubectlOut(args: string[], timeout = 30_000, input?: string): string {
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

function activeTeamIdForUser(userId: string): string {
  const out = runProfilesSql(
    `
    SELECT tm.team_id::text
      FROM team_members tm
     WHERE tm.user_id = ${sqlLiteral(userId)}
       AND tm.status = 'active'
     ORDER BY tm.created_at ASC, tm.team_id ASC
     LIMIT 1;
    `
  )
  const match = out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
  if (!match) throw new Error(`no active team found for E2E user ${userId}`)
  return match[0]
}

function teamIdFromJwt(jwt: string): string {
  const payloadB64 = jwt.split('.')[1]
  if (!payloadB64) throw new Error('dev-login token is missing a JWT payload')
  const claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString()) as {
    teamId?: unknown
  }
  if (typeof claims.teamId !== 'string' || !claims.teamId.trim()) {
    throw new Error('dev-login token is missing teamId claim')
  }
  return claims.teamId
}

function createWrongOrInactiveTeam(args: {
  userId: string
  teamName: string
  status?: 'active' | 'deleted'
}): string {
  const out = runProfilesSql(`
    WITH team AS (
      INSERT INTO teams(name)
      VALUES (${sqlLiteral(args.teamName)})
      RETURNING id
    ), membership AS (
      INSERT INTO team_members(team_id, user_id, role, status)
      SELECT id, ${sqlLiteral(args.userId)}, 'member', ${sqlLiteral(args.status ?? 'active')}
        FROM team
      RETURNING team_id
    )
    SELECT team_id::text FROM membership;
  `)
  const match = out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
  if (!match) throw new Error(`failed to create E2E team ${args.teamName}`)
  return match[0]
}

function cleanupTeam(teamId: string | undefined): void {
  if (!teamId) return
  if (!/^[0-9a-f-]{36}$/i.test(teamId)) {
    throw new Error(`refusing to clean non-UUID E2E team id ${teamId}`)
  }
  try {
    runProfilesSql(
      `
      DELETE FROM team_workflow_triggers
       WHERE team_id = ${sqlLiteral(teamId)}
         AND recipe_namespace = ${sqlLiteral(RECIPE_NS)}
         AND recipe_name IN (${[SALES_CRM_RECIPE, AUTHZ_HARNESS_RECIPE, UNAUTHORIZED_RECIPE]
           .map(sqlLiteral)
           .join(', ')});
      DELETE FROM team_members
       WHERE team_id = ${sqlLiteral(teamId)};
      DELETE FROM teams
       WHERE id = ${sqlLiteral(teamId)};
      `,
      20_000
    )
  } catch {
    // Preserve the original assertion failure; teams are E2E-scoped by id.
  }
}

function applySandboxUiRecipe(args: {
  name: string
  title: string
  defaultPath: string
  workloadId: string
}): void {
  assertSafeRecipeName(args.name)
  assertSafeWorkloadId(args.workloadId)
  const yaml = `
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${args.name}
  namespace: ${RECIPE_NS}
  labels:
    clerum.io/e2e: "true"
    clerum.io/e2e-purpose: "sandbox-ui-apps-authz"
spec:
  description: "E2E fixture for Desktop Apps Sandbox UI authorization."
  contextRef: context1
  workloads:
    - id: ${args.workloadId}
      type: deployment
      image: nginxinc/nginx-unprivileged:1.27-alpine
      port: 8080
      healthCheck:
        type: http
        path: /
        port: 8080
      resources:
        requests:
          cpu: "25m"
          memory: "32Mi"
        limits:
          cpu: "100m"
          memory: "96Mi"
  ui:
    workloadRef: ${args.workloadId}
    port: 8080
    title: ${JSON.stringify(args.title)}
    defaultPath: ${JSON.stringify(args.defaultPath)}
  security:
    isolationLevel: minimal
`
  kubectlOut(['apply', '-f', '-'], 60_000, yaml)
}

async function waitForRecipeActive(recipeName: string): Promise<void> {
  assertSafeRecipeName(recipeName)
  await expect
    .poll(
      () =>
        kubectlOut(
          ['-n', RECIPE_NS, 'get', 'workflowrecipe', recipeName, '-o', 'jsonpath={.status.phase}'],
          10_000
        ).trim(),
      {
        timeout: 180_000,
        intervals: [1_000, 2_000, 5_000],
        message: `${RECIPE_NS}/${recipeName} should become active before Apps catalog validation`,
      }
    )
    .toBe('active')
}

async function waitForSandboxUiEndpointReady(
  recipeName: string,
  workloadId: string
): Promise<void> {
  assertSafeRecipeName(recipeName)
  assertSafeWorkloadId(workloadId)
  await expect
    .poll(
      () => {
        try {
          const raw = kubectlOut(
            [
              '-n',
              SANDBOX_UI_NS,
              'get',
              'endpointslices',
              '-l',
              `kubernetes.io/service-name=${workloadId}`,
              '-o',
              'json',
            ],
            10_000
          )
          const parsed = JSON.parse(raw) as {
            items?: Array<{
              endpoints?: Array<{
                addresses?: string[]
                conditions?: { ready?: boolean }
              }>
            }>
          }
          return (parsed.items ?? [])
            .flatMap(item => item.endpoints ?? [])
            .filter(endpoint => endpoint.conditions?.ready !== false)
            .flatMap(endpoint => endpoint.addresses ?? [])
            .join(' ')
        } catch {
          return ''
        }
      },
      {
        timeout: 180_000,
        intervals: [1_000, 2_000, 5_000],
        message: `${SANDBOX_UI_NS}/${workloadId} should have a ready endpoint before opening ${recipeName}`,
      }
    )
    .not.toBe('')
}

async function issueSandboxUiRpcToken(sessionToken: string): Promise<string> {
  const response = await apiRequest(
    'POST',
    `${EXT_API}/api/v1/rpc/token`,
    JSON.stringify({
      scopes: ['sandbox:ui:view'],
      hostRefs: [SANDBOX_UI_RPC_HOST_REF],
    }),
    { Authorization: `Bearer ${sessionToken}` }
  )
  if (response.status !== 200) {
    throw new Error(
      `sandbox-ui RPC token issuance failed: HTTP ${response.status} ${response.body}`
    )
  }
  const parsed = JSON.parse(response.body) as { token?: unknown }
  if (typeof parsed.token !== 'string' || !parsed.token.trim()) {
    throw new Error('sandbox-ui RPC token issuance returned no token')
  }
  return parsed.token
}

async function expectSandboxUiViewServesApp(rpcToken: string, recipeName: string): Promise<void> {
  assertSafeRecipeName(recipeName)
  const sessionResponse = await fetch(
    `${RPC_PROXY}/api/v1/sandbox-ui/${encodeURIComponent(RECIPE_NS)}/${encodeURIComponent(
      recipeName
    )}/session`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${rpcToken}` },
    }
  )
  const sessionBody = await sessionResponse.text()
  expect(sessionResponse.status, sessionBody).toBe(204)
  const setCookie = sessionResponse.headers.get('set-cookie') ?? ''
  expect(setCookie, `${recipeName} session mint should set a Sandbox UI cookie`).toContain(
    'clerum_sandbox_ui_session='
  )

  const viewResponse = await fetch(
    `${RPC_PROXY}/api/v1/sandbox-ui/${encodeURIComponent(RECIPE_NS)}/${encodeURIComponent(
      recipeName
    )}/view/`,
    {
      headers: { Cookie: setCookie.split(';', 1)[0] },
    }
  )
  const viewBody = await viewResponse.text()
  expect(viewResponse.status, viewBody).toBe(200)
  expect(viewBody).toContain('Welcome to nginx')
}

function seedDirectGrant(userId: string, recipeName: string): void {
  assertSafeRecipeName(recipeName)
  runProfilesSql(`
    INSERT INTO user_workflow_triggers (user_id, recipe_namespace, recipe_name)
    VALUES (${sqlLiteral(userId)}, ${sqlLiteral(RECIPE_NS)}, ${sqlLiteral(recipeName)})
    ON CONFLICT DO NOTHING;
  `)
}

function seedTeamGrant(teamId: string, recipeName: string): void {
  assertSafeRecipeName(recipeName)
  runProfilesSql(`
    INSERT INTO team_workflow_triggers (team_id, recipe_namespace, recipe_name)
    VALUES (${sqlLiteral(teamId)}, ${sqlLiteral(RECIPE_NS)}, ${sqlLiteral(recipeName)})
    ON CONFLICT DO NOTHING;
  `)
}

function cleanupSandboxUiCatalogFixture(recipeName: string): void {
  assertSafeRecipeName(recipeName)
  try {
    runProfilesSql(
      `
      DELETE FROM user_workflow_triggers
       WHERE recipe_namespace = ${sqlLiteral(RECIPE_NS)}
         AND recipe_name = ${sqlLiteral(recipeName)};
      DELETE FROM team_workflow_triggers
       WHERE recipe_namespace = ${sqlLiteral(RECIPE_NS)}
         AND recipe_name = ${sqlLiteral(recipeName)};
      `,
      20_000
    )
  } catch {
    // Preserve the original assertion failure; rows are E2E-scoped by name.
  }
  try {
    kubectlOut(
      ['-n', RECIPE_NS, 'delete', 'workflowrecipe', recipeName, '--ignore-not-found=true'],
      90_000
    )
  } catch {
    // Preserve the original assertion failure; resources are E2E-scoped.
  }
}

async function openAppsPage(page: Awaited<ReturnType<typeof launchAndLogin>>['page']) {
  const appsNav = page.getByTestId('nav-sandbox-ui')
  await expect(appsNav).toBeVisible({ timeout: 20_000 })
  await appsNav.click()
  await expect(appsNav).toHaveClass(/active/, { timeout: 20_000 })
}

async function waitForGlobalToastsToClear(page: Page): Promise<void> {
  await expect(page.locator('.toast-stack').getByRole('status')).toHaveCount(0, {
    timeout: 7_000,
  })
}

test('Desktop Apps lists team-granted and direct-granted Sandbox UI apps', async () => {
  test.setTimeout(300_000)
  await clearSession()
  cleanupSandboxUiCatalogFixture(SALES_CRM_RECIPE)
  cleanupSandboxUiCatalogFixture(AUTHZ_HARNESS_RECIPE)

  const auth = await loginAs(E2E_EMAIL)
  const teamId = teamIdFromJwt(auth.userToken)

  const { app, page } = await launchAndLogin(E2E_EMAIL)
  try {
    applySandboxUiRecipe({
      name: SALES_CRM_RECIPE,
      title: "Andy's Sales CRM",
      defaultPath: '/',
      workloadId: SALES_CRM_WORKLOAD,
    })
    applySandboxUiRecipe({
      name: AUTHZ_HARNESS_RECIPE,
      title: 'Sandbox UI Authz Harness',
      defaultPath: '/',
      workloadId: AUTHZ_HARNESS_WORKLOAD,
    })
    await Promise.all([
      waitForRecipeActive(SALES_CRM_RECIPE),
      waitForRecipeActive(AUTHZ_HARNESS_RECIPE),
    ])
    await Promise.all([
      waitForSandboxUiEndpointReady(SALES_CRM_RECIPE, SALES_CRM_WORKLOAD),
      waitForSandboxUiEndpointReady(AUTHZ_HARNESS_RECIPE, AUTHZ_HARNESS_WORKLOAD),
    ])

    seedTeamGrant(teamId, SALES_CRM_RECIPE)
    seedDirectGrant(auth.userId, AUTHZ_HARNESS_RECIPE)

    await openAppsPage(page)

    await expect(page.getByText('No apps yet')).toBeHidden({ timeout: 20_000 })
    await expect(
      page.getByText(/sandboxUi:listApps|403 Forbidden|No permitted scopes/i)
    ).toHaveCount(0)
    await expect(page.getByText("Andy's Sales CRM")).toBeVisible({ timeout: 60_000 })
    await expect(page.getByText('Sandbox UI Authz Harness')).toBeVisible({ timeout: 60_000 })

    const sandboxUiRpcToken = await issueSandboxUiRpcToken(auth.userToken)
    await Promise.all([
      expectSandboxUiViewServesApp(sandboxUiRpcToken, SALES_CRM_RECIPE),
      expectSandboxUiViewServesApp(sandboxUiRpcToken, AUTHZ_HARNESS_RECIPE),
    ])

    const appButtons = page.getByRole('button', { name: /^Open / })
    await expect(appButtons).toHaveCount(2)
    const salesCrmRow = page.getByRole('button', { name: "Open Andy's Sales CRM" })
    const authzHarnessRow = page.getByRole('button', { name: 'Open Sandbox UI Authz Harness' })
    await expect(salesCrmRow).toContainText('Ready')
    await expect(authzHarnessRow).toContainText('Ready')

    await waitForGlobalToastsToClear(page)
    await salesCrmRow.click()
    const closeAppButton = page.getByRole('button', { name: 'Close app' })
    await expect(closeAppButton).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(/This app is starting up/i)).toHaveCount(0)
    await waitForGlobalToastsToClear(page)
    await closeAppButton.click()
    await expect(authzHarnessRow).toBeVisible({ timeout: 30_000 })
    await authzHarnessRow.click()
    await expect(page.getByRole('button', { name: 'Close app' })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(/This app is starting up/i)).toHaveCount(0)
  } finally {
    await app.close()
    cleanupSandboxUiCatalogFixture(SALES_CRM_RECIPE)
    cleanupSandboxUiCatalogFixture(AUTHZ_HARNESS_RECIPE)
  }
})

test('Desktop Apps excludes ungranted, wrong-team, and inactive-team Sandbox UI grants', async () => {
  test.setTimeout(300_000)
  await clearSession()
  cleanupSandboxUiCatalogFixture(SALES_CRM_RECIPE)
  cleanupSandboxUiCatalogFixture(AUTHZ_HARNESS_RECIPE)
  cleanupSandboxUiCatalogFixture(UNAUTHORIZED_RECIPE)

  const auth = await loginAs(E2E_EMAIL)
  const jwtTeamId = teamIdFromJwt(auth.userToken)
  const activeTeamId = activeTeamIdForUser(auth.userId)
  expect(activeTeamId).toBe(jwtTeamId)

  let wrongTeamId: string | undefined
  let inactiveTeamId: string | undefined

  try {
    applySandboxUiRecipe({
      name: SALES_CRM_RECIPE,
      title: "Andy's Sales CRM",
      defaultPath: '/',
      workloadId: SALES_CRM_WORKLOAD,
    })
    applySandboxUiRecipe({
      name: AUTHZ_HARNESS_RECIPE,
      title: 'Sandbox UI Authz Harness',
      defaultPath: '/',
      workloadId: AUTHZ_HARNESS_WORKLOAD,
    })
    applySandboxUiRecipe({
      name: UNAUTHORIZED_RECIPE,
      title: 'Unauthorized Sandbox UI',
      defaultPath: '/denied',
      workloadId: UNAUTHORIZED_WORKLOAD,
    })
    await Promise.all([
      waitForRecipeActive(SALES_CRM_RECIPE),
      waitForRecipeActive(AUTHZ_HARNESS_RECIPE),
      waitForRecipeActive(UNAUTHORIZED_RECIPE),
    ])
    await waitForSandboxUiEndpointReady(AUTHZ_HARNESS_RECIPE, AUTHZ_HARNESS_WORKLOAD)
    seedDirectGrant(auth.userId, AUTHZ_HARNESS_RECIPE)

    const { app, page } = await launchAndLogin(E2E_EMAIL)
    try {
      wrongTeamId = createWrongOrInactiveTeam({
        userId: auth.userId,
        teamName: 'E2E Sandbox UI wrong team',
        status: 'active',
      })
      inactiveTeamId = createWrongOrInactiveTeam({
        userId: auth.userId,
        teamName: 'E2E Sandbox UI inactive team',
        status: 'deleted',
      })
      seedTeamGrant(wrongTeamId, SALES_CRM_RECIPE)
      seedTeamGrant(inactiveTeamId, UNAUTHORIZED_RECIPE)

      await openAppsPage(page)

      await expect(page.getByText('No apps yet')).toBeHidden({ timeout: 60_000 })
      await expect(page.getByText('Sandbox UI Authz Harness')).toBeVisible({ timeout: 60_000 })
      await expect(page.getByRole('button', { name: /^Open / })).toHaveCount(1)
      await expect(
        page.getByRole('button', { name: 'Open Sandbox UI Authz Harness' })
      ).toContainText('Ready')
      await expect(page.getByText("Andy's Sales CRM")).toHaveCount(0)
      await expect(page.getByText('Unauthorized Sandbox UI')).toHaveCount(0)
      await expect(
        page.getByText(/sandboxUi:listApps|403 Forbidden|No permitted scopes/i)
      ).toHaveCount(0)
    } finally {
      await app.close()
    }
  } finally {
    cleanupTeam(wrongTeamId)
    cleanupTeam(inactiveTeamId)
    cleanupSandboxUiCatalogFixture(SALES_CRM_RECIPE)
    cleanupSandboxUiCatalogFixture(AUTHZ_HARNESS_RECIPE)
    cleanupSandboxUiCatalogFixture(UNAUTHORIZED_RECIPE)
  }
})

test('Desktop Apps fails closed when the user has no Sandbox UI grant', async () => {
  test.setTimeout(300_000)
  await clearSession()
  cleanupSandboxUiCatalogFixture(SALES_CRM_RECIPE)
  cleanupSandboxUiCatalogFixture(AUTHZ_HARNESS_RECIPE)
  cleanupSandboxUiCatalogFixture(UNAUTHORIZED_RECIPE)

  applySandboxUiRecipe({
    name: SALES_CRM_RECIPE,
    title: "Andy's Sales CRM",
    defaultPath: '/',
    workloadId: SALES_CRM_WORKLOAD,
  })
  await waitForRecipeActive(SALES_CRM_RECIPE)

  const { app, page } = await launchAndLogin(E2E_EMAIL)
  try {
    await openAppsPage(page)

    await expect(page.getByText("Andy's Sales CRM")).toHaveCount(0)
    await expect(
      page.getByText(/sandboxUi:listApps|403 Forbidden|No permitted scopes/i)
    ).toBeVisible({
      timeout: 60_000,
    })
  } finally {
    await app.close()
    cleanupSandboxUiCatalogFixture(SALES_CRM_RECIPE)
  }
})
