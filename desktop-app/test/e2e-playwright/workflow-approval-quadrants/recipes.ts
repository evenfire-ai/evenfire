import { expect } from '@playwright/test'
import {
  cleanupWorkflowQuadrantRuntimeResidues,
  cleanupWorkflowRuntimeResources,
  kubectlOut,
  profilesSql,
  sqlLiteral,
  waitForNoWorkflowPods,
  waitForNoWorkflowQuadrantRuntimeResidues,
} from './cluster'
import { CONTROL_API, MCP_SERVER_NS, WORKFLOW_RECIPE_NS } from './constants'

const ADMIN_USERNAME = process.env.E2E_ADMIN_USERNAME || process.env.ADMIN_USER || 'admin'
const ADMIN_FETCH_RETRY_DELAYS_MS = [250, 500, 1000]

function requireAdminPassword(): string {
  const password =
    process.env.E2E_ADMIN_PASSWORD ||
    process.env.ADMIN_PASSWORD ||
    process.env.ADMIN_PASS ||
    'changeme123!'
  if (!password) {
    throw new Error(
      'E2E_ADMIN_PASSWORD, ADMIN_PASSWORD, or ADMIN_PASS is required to assert the admin workflow grants route'
    )
  }
  return password
}

async function readResponse(response: Response): Promise<{ status: number; body: string }> {
  return { status: response.status, body: await response.text() }
}

function transientAdminFetchError(error: unknown): boolean {
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : {}
  const cause =
    record.cause && typeof record.cause === 'object'
      ? (record.cause as Record<string, unknown>)
      : {}
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  return (
    record.code === 'ECONNRESET' ||
    record.code === 'ECONNREFUSED' ||
    record.code === 'EPIPE' ||
    cause.code === 'UND_ERR_SOCKET' ||
    message.includes('socket hang up') ||
    message.includes('other side closed') ||
    message.includes('fetch failed')
  )
}

async function adminFetch(input: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; attempt <= ADMIN_FETCH_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await fetch(input, init)
    } catch (error) {
      if (!transientAdminFetchError(error) || attempt === ADMIN_FETCH_RETRY_DELAYS_MS.length) {
        throw error
      }
      await new Promise(resolve => setTimeout(resolve, ADMIN_FETCH_RETRY_DELAYS_MS[attempt]))
    }
  }
  throw new Error('admin fetch retry loop exhausted')
}

async function adminLogin(): Promise<string> {
  const response = await adminFetch(`${CONTROL_API}/api/v1/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USERNAME, password: requireAdminPassword() }),
  })
  const { status, body } = await readResponse(response)
  expect(status, body).toBe(200)

  const parsed = JSON.parse(body) as { token?: string }
  expect(parsed.token, 'admin login must return a token').toBeTruthy()
  return parsed.token as string
}

function parseResponseEnvelope(body: string): Record<string, unknown> {
  const parsed = JSON.parse(body) as Record<string, unknown>
  const wrapped = parsed.o
  return wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped)
    ? (wrapped as Record<string, unknown>)
    : parsed
}

export async function adminCreateTeamForUser(name: string, userId: string): Promise<string> {
  const token = await adminLogin()
  const response = await adminFetch(`${CONTROL_API}/api/v1/admin/teams`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name, userId }),
  })
  const result = await readResponse(response)
  expect(result.status, result.body).toBe(200)

  const body = parseResponseEnvelope(result.body)
  const id = String(body.id || '').trim()
  expect(id, result.body).toMatch(/^[0-9a-f-]{36}$/i)
  return id
}

export async function grantTeamThroughAdminRoute(
  namespace: string,
  name: string,
  teamId: string
): Promise<void> {
  const token = await adminLogin()
  const response = await adminFetch(
    `${CONTROL_API}/api/v1/admin/workflows/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/team-grants`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ teamIds: [teamId] }),
    }
  )
  const result = await readResponse(response)
  expect(result.status, result.body).toBe(200)

  const body = parseResponseEnvelope(result.body) as { teamIds?: unknown }
  const teamIds = Array.isArray(body.teamIds) ? body.teamIds.map(String) : []
  expect(teamIds, result.body).toContain(teamId)
}

export async function allowTeamApprovalThroughAdminRoute(
  namespace: string,
  name: string,
  teamId: string
): Promise<void> {
  const token = await adminLogin()
  const response = await adminFetch(
    `${CONTROL_API}/api/v1/admin/workflow-recipes/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/allowed-teams/${encodeURIComponent(teamId)}`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
    }
  )
  const result = await readResponse(response)
  expect(result.status, result.body).toBe(200)

  const body = parseResponseEnvelope(result.body)
  expect(String(body.teamId || body.id || '').trim(), result.body).toBe(teamId)
}

export async function grantUserThroughAdminRoute(
  namespace: string,
  name: string,
  userId: string
): Promise<void> {
  await setUserWorkflowGrantsThroughAdminRoute(namespace, name, [userId])
}

export async function setUserWorkflowGrantsThroughAdminRoute(
  namespace: string,
  name: string,
  userIds: string[]
): Promise<void> {
  const token = await adminLogin()
  const grantResponse = await adminFetch(
    `${CONTROL_API}/api/v1/admin/workflows/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/grants`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ userIds }),
    }
  )
  const grant = await readResponse(grantResponse)
  expect(grant.status, grant.body).toBe(200)

  const expectedUserIds = userIds.map(id => id.toLowerCase())
  const grantBody = JSON.parse(grant.body) as { userIds?: string[] }
  expect(grantBody.userIds ?? []).toEqual(expect.arrayContaining(expectedUserIds))

  const listResponse = await adminFetch(
    `${CONTROL_API}/api/v1/admin/workflows/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/grants`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  const list = await readResponse(listResponse)
  expect(list.status, list.body).toBe(200)

  const listBody = JSON.parse(list.body) as { items?: Array<{ id?: string }> }
  const listedUserIds = (listBody.items ?? []).map(item => item.id).filter(Boolean)
  expect(listedUserIds).toEqual(expect.arrayContaining(userIds))
  expect(listedUserIds).toHaveLength(userIds.length)
}

export function applyRecipe(
  name: string,
  options: {
    requiresApproval?: boolean
    instruction?: string
    allowedActors?: Array<'user' | 'autonomous' | 'scheduled'>
    inputContract?: string
    agentProvider?: string
    agentModel?: string
  } = {}
): void {
  const requiresApproval = options.requiresApproval ?? true
  const instruction = options.instruction || 'E2E approval contract placeholder.'
  const allowedActors = options.allowedActors ?? ['user', 'autonomous']
  const agentProvider = options.agentProvider ?? 'zai'
  const agentModel = options.agentModel ?? 'glm-4.7'
  const allowedActorsYaml = allowedActors.map(actor => `        - ${actor}`).join('\n')
  const inputContractYaml = options.inputContract
    ? `  inputContract:\n${options.inputContract
        .trimEnd()
        .split('\n')
        .map(line => `    ${line}`)
        .join('\n')}\n`
    : ''
  const yaml = `
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${name}
  namespace: ${WORKFLOW_RECIPE_NS}
  labels:
    clerum.io/e2e: "true"
    clerum.io/workflow-approval-quadrants: "true"
spec:
  agent:
    provider: ${agentProvider}
    model: ${agentModel}
${inputContractYaml}
  triggers:
    onDemand:
      requiresApproval: ${requiresApproval ? 'true' : 'false'}
      allowedActors:
${allowedActorsYaml}
  steps:
    - id: approval-contract
      instruction: "${instruction.replace(/"/g, '\\"')}"
      timeoutSeconds: 60
`
  kubectlOut(['apply', '-f', '-'], yaml, 30_000)
}

export async function cleanupRecipe(name: string): Promise<void> {
  if (!/^e2e-quadrant-[a-z0-9-]+$/.test(name)) {
    throw new Error(`refusing to clean non-E2E recipe ${name}`)
  }

  cleanupWorkflowRuntimeResources(WORKFLOW_RECIPE_NS, name)

  try {
    kubectlOut(
      ['-n', WORKFLOW_RECIPE_NS, 'delete', 'workflowrecipe', name, '--ignore-not-found=true'],
      undefined,
      30_000
    )
  } catch {
    // Keep the original test failure when cleanup races with cluster teardown.
  }

  profilesSql(`
    DELETE FROM workflow_approval_reader_events
     WHERE approval_request_id IN (
       SELECT id
         FROM workflow_approval_requests
        WHERE recipe_namespace = ${sqlLiteral(WORKFLOW_RECIPE_NS)}
          AND recipe_name = ${sqlLiteral(name)}
     );
    DELETE FROM workflow_runs
     WHERE recipe_namespace = ${sqlLiteral(WORKFLOW_RECIPE_NS)}
       AND recipe_name = ${sqlLiteral(name)};
    DELETE FROM workflow_approval_requests
     WHERE recipe_namespace = ${sqlLiteral(WORKFLOW_RECIPE_NS)}
       AND recipe_name = ${sqlLiteral(name)};
    DELETE FROM user_workflow_triggers
     WHERE recipe_namespace = ${sqlLiteral(WORKFLOW_RECIPE_NS)}
       AND recipe_name = ${sqlLiteral(name)};
    DELETE FROM team_workflow_triggers
     WHERE recipe_namespace = ${sqlLiteral(WORKFLOW_RECIPE_NS)}
       AND recipe_name = ${sqlLiteral(name)};
    DELETE FROM workflow_recipe_allowed_teams
     WHERE recipe_namespace = ${sqlLiteral(WORKFLOW_RECIPE_NS)}
       AND recipe_name = ${sqlLiteral(name)};
  `)

  await waitForNoWorkflowPods(WORKFLOW_RECIPE_NS, name)
  cleanupWorkflowRuntimeResources(WORKFLOW_RECIPE_NS, name)
}

export async function cleanupQuadrantResidues(): Promise<void> {
  const raw = kubectlOut(
    ['-n', WORKFLOW_RECIPE_NS, 'get', 'workflowrecipe', '-o', 'jsonpath={.items[*].metadata.name}'],
    undefined,
    10_000
  ).trim()
  const runtimeRaw = ['svc', 'deployment', 'pod', 'secret', 'configmap', 'pvc']
    .map(resourceType => {
      try {
        return kubectlOut(
          [
            '-n',
            WORKFLOW_RECIPE_NS,
            'get',
            resourceType,
            '-o',
            'jsonpath={.items[*].metadata.name}',
          ],
          undefined,
          10_000
        )
      } catch {
        return ''
      }
    })
    .join('\n')
  const dbRaw = profilesSql(`
    SELECT DISTINCT recipe_name
      FROM workflow_runs
     WHERE recipe_namespace = ${sqlLiteral(WORKFLOW_RECIPE_NS)}
       AND recipe_name LIKE 'e2e-quadrant-%'
    UNION
    SELECT DISTINCT recipe_name
      FROM workflow_approval_requests
     WHERE recipe_namespace = ${sqlLiteral(WORKFLOW_RECIPE_NS)}
       AND recipe_name LIKE 'e2e-quadrant-%'
    UNION
    SELECT DISTINCT recipe_name
      FROM user_workflow_triggers
     WHERE recipe_namespace = ${sqlLiteral(WORKFLOW_RECIPE_NS)}
       AND recipe_name LIKE 'e2e-quadrant-%'
    UNION
    SELECT DISTINCT recipe_name
      FROM team_workflow_triggers
     WHERE recipe_namespace = ${sqlLiteral(WORKFLOW_RECIPE_NS)}
       AND recipe_name LIKE 'e2e-quadrant-%'
    UNION
    SELECT DISTINCT recipe_name
      FROM workflow_recipe_allowed_teams
     WHERE recipe_namespace = ${sqlLiteral(WORKFLOW_RECIPE_NS)}
       AND recipe_name LIKE 'e2e-quadrant-%';
  `)
  const names = new Set(
    `${raw}\n${dbRaw}`.split(/\s+/).filter(name => /^e2e-quadrant-[a-z0-9-]+$/.test(name))
  )
  for (const match of runtimeRaw.matchAll(/(?:^|\s)(?:wf-)?(e2e-quadrant-q[1-4]-\d+)/g)) {
    names.add(match[1]!)
  }

  const recipeNames = [...names]
  if (recipeNames.length > 0) {
    kubectlOut(
      [
        '-n',
        WORKFLOW_RECIPE_NS,
        'delete',
        'workflowrecipe',
        ...recipeNames,
        '--ignore-not-found=true',
        '--wait=false',
      ],
      undefined,
      30_000
    )
  }
  cleanupWorkflowQuadrantRuntimeResidues(WORKFLOW_RECIPE_NS)

  profilesSql(`
    DELETE FROM workflow_approval_reader_events
     WHERE approval_request_id IN (
       SELECT id
         FROM workflow_approval_requests
        WHERE recipe_namespace = ${sqlLiteral(WORKFLOW_RECIPE_NS)}
          AND recipe_name LIKE 'e2e-quadrant-%'
     );
    DELETE FROM workflow_runs
     WHERE recipe_namespace = ${sqlLiteral(WORKFLOW_RECIPE_NS)}
       AND recipe_name LIKE 'e2e-quadrant-%';
    DELETE FROM workflow_approval_requests
     WHERE recipe_namespace = ${sqlLiteral(WORKFLOW_RECIPE_NS)}
       AND recipe_name LIKE 'e2e-quadrant-%';
    DELETE FROM user_workflow_triggers
     WHERE recipe_namespace = ${sqlLiteral(WORKFLOW_RECIPE_NS)}
       AND recipe_name LIKE 'e2e-quadrant-%';
    DELETE FROM team_workflow_triggers
     WHERE recipe_namespace = ${sqlLiteral(WORKFLOW_RECIPE_NS)}
       AND recipe_name LIKE 'e2e-quadrant-%';
    DELETE FROM workflow_recipe_allowed_teams
     WHERE recipe_namespace = ${sqlLiteral(WORKFLOW_RECIPE_NS)}
       AND recipe_name LIKE 'e2e-quadrant-%';
    DELETE FROM workflow_approval_reader_events
     WHERE provider_event_id LIKE 'event-q3-%'
        OR provider_event_id LIKE 'event-q4-%';
    DELETE FROM notification_deliveries
     WHERE payload->>'providerUserId' LIKE 'telegram-q4-%';
    DELETE FROM workflow_approval_medium_challenges
     WHERE provider_user_id LIKE 'telegram-q4-%';
    DELETE FROM workflow_approval_medium_accounts
     WHERE provider_user_id LIKE 'telegram-q4-%';
  `)
  await waitForNoWorkflowQuadrantRuntimeResidues(WORKFLOW_RECIPE_NS)
}

export function expectWorkflowRecipeOnlyInSandbox(name: string): void {
  const sandboxName = kubectlOut(
    ['-n', WORKFLOW_RECIPE_NS, 'get', 'workflowrecipe', name, '-o', 'jsonpath={.metadata.name}'],
    undefined,
    10_000
  ).trim()
  expect(sandboxName).toBe(name)

  const legacyName = kubectlOut(
    [
      '-n',
      MCP_SERVER_NS,
      'get',
      'workflowrecipe',
      name,
      '--ignore-not-found=true',
      '-o',
      'jsonpath={.metadata.name}',
    ],
    undefined,
    10_000
  ).trim()
  expect(legacyName).toBe('')
}

function sqlList(values: string[]): string {
  return values.map(sqlLiteral).join(', ')
}

function assertSafeProviderIds(providerUserIds: string[]): void {
  for (const providerUserId of providerUserIds) {
    if (!providerUserId || providerUserId.length > 256) {
      throw new Error(`refusing to clean unsafe provider id "${providerUserId}"`)
    }
  }
}

function assertSafeChallengeIds(challengeIds: string[]): void {
  for (const challengeId of challengeIds) {
    expect(challengeId).toMatch(/^[0-9a-f-]{36}$/)
  }
}

export function cleanupApprovalMediumResidues(params: {
  providerUserIds?: string[]
  challengeIds?: string[]
  preserveAccountIds?: string[]
}): void {
  const providerUserIds = [...new Set(params.providerUserIds ?? [])]
  const challengeIds = [...new Set(params.challengeIds ?? [])]
  const preserveAccountIds = [...new Set(params.preserveAccountIds ?? [])]
  if (providerUserIds.length === 0 && challengeIds.length === 0) return

  assertSafeProviderIds(providerUserIds)
  assertSafeChallengeIds(challengeIds)
  assertSafeChallengeIds(preserveAccountIds)

  const providerAccounts = providerUserIds.length
    ? `provider_user_id IN (${sqlList(providerUserIds)})`
    : 'FALSE'
  const preservedAccounts = preserveAccountIds.length
    ? `id NOT IN (${sqlList(preserveAccountIds)})`
    : 'TRUE'
  const notificationProviders = providerUserIds.length
    ? `payload->>'providerUserId' IN (${sqlList(providerUserIds)})`
    : 'FALSE'
  const challengeRows = challengeIds.length ? `id IN (${sqlList(challengeIds)})` : 'FALSE'
  const challengeNotifications = challengeIds.length
    ? `dedupe_key IN (${sqlList(challengeIds.map(id => `${id}:workflow_approval_medium.challenge`))})`
    : 'FALSE'

  profilesSql(`
    DELETE FROM notification_deliveries
     WHERE ${challengeNotifications}
        OR ${notificationProviders};
    DELETE FROM workflow_approval_medium_challenges
     WHERE ${challengeRows}
        OR ${providerAccounts};
    DELETE FROM workflow_approval_medium_accounts
     WHERE ${providerAccounts}
       AND ${preservedAccounts};
  `)
}

export function mediumAccountIds(providerUserIds: string[]): string[] {
  const uniqueProviderUserIds = [...new Set(providerUserIds)]
  if (uniqueProviderUserIds.length === 0) return []
  assertSafeProviderIds(uniqueProviderUserIds)

  const raw = profilesSql(`
    SELECT id::text
      FROM workflow_approval_medium_accounts
     WHERE provider_user_id IN (${sqlList(uniqueProviderUserIds)});
  `)
  return raw.split(/\s+/).filter(Boolean)
}

export async function withRuntimeRecipe<T>(
  name: string,
  userId: string,
  fn: () => Promise<T>
): Promise<T> {
  await cleanupRecipe(name)
  applyRecipe(name)
  expectWorkflowRecipeOnlyInSandbox(name)
  await grantUserThroughAdminRoute(WORKFLOW_RECIPE_NS, name, userId)

  try {
    return await fn()
  } finally {
    await cleanupRecipe(name)
  }
}
