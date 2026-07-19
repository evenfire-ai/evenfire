import { type Locator, type Page, expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { profilesSql, sqlLiteral } from './workflow-approval-quadrants/cluster'
import { CONTROL_API, WORKFLOW_RECIPE_NS } from './workflow-approval-quadrants/constants'
import { applyRecipe, cleanupRecipe } from './workflow-approval-quadrants/recipes'
import {
  E2E_EMAIL,
  clearSession,
  launchAndLogin,
  loginAs,
  openWorkflowsPage,
  selectWorkflow,
  workflowRow,
} from './workflowUi'

const CONTROL_UI =
  process.env.CONTROL_UI_URL || process.env.CONTROL_UI_BASE_URL || 'http://127.0.0.1:3000'
const ADMIN_USER = process.env.E2E_ADMIN_USERNAME || process.env.ADMIN_USER || 'admin'
const ADMIN_PASSWORD =
  process.env.E2E_ADMIN_PASSWORD ||
  process.env.ADMIN_PASSWORD ||
  process.env.ADMIN_PASS ||
  'changeme123!'

const OPERATOR_INPUT_CONTRACT = `
type: object
required:
  - packet
properties:
  packet:
    type: string
    default: baseline
    description: Diligence packet name
`

type GovernedTraceMetricSnapshot = {
  runStartAccepted: number
  runEndAccepted: number
}

const GOVERNED_TRACE_ACCEPTED_METRIC = 'governed_trace_accepted_total'
const GOVERNED_TRACE_LABELS = {
  family: 'agent_run',
  source: 'workflow-recipes',
} as const

type InfrastructureCostFixture = {
  anchorDate: string
  cloudProjectId: string
  clusterLocation: string
  clusterName: string
  environment: string
  namespace: string
  workloadKind: string
  workloadRef: string
  currency: string
}

function fixtureSha256(): string {
  const compact = randomUUID().replace(/-/g, '')
  return `${compact}${compact}`
}

function seedInfrastructureCostFixture(): InfrastructureCostFixture {
  const anchorDate = new Date().toISOString().slice(0, 10)
  const nextDate = new Date(`${anchorDate}T00:00:00.000Z`)
  nextDate.setUTCDate(nextDate.getUTCDate() + 1)
  const intervalEnd = nextDate.toISOString()
  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`
  const fixture: InfrastructureCostFixture = {
    anchorDate,
    cloudProjectId: `e2e-project-${suffix}`,
    clusterLocation: 'europe-west1',
    clusterName: `e2e-cluster-${suffix}`,
    environment: 'e2e',
    namespace: 'control-plane',
    workloadKind: 'Deployment',
    workloadRef: `control-api-${suffix}`,
    currency: 'USD',
  }
  const priceSnapshotId = randomUUID()
  const estimatedId = randomUUID()
  const billedId = randomUUID()
  const telemetryEventId = randomUUID()
  const telemetryPayloadSha256 = fixtureSha256()

  profilesSql(`
    BEGIN;
    SET CONSTRAINTS ALL DEFERRED;

    INSERT INTO infrastructure_telemetry_events (
      event_id, source_service, source_kind, source_occurrence_id, telemetry_type,
      trigger_kind, outcome, reason_code, environment, cluster_name, namespace,
      workload_kind, workload_ref, kubernetes_kind, kubernetes_name,
      interval_start, interval_end, desired_replicas, observed_replicas,
      ready_replicas, cpu_request_cores, cpu_limit_cores, memory_request_bytes,
      memory_limit_bytes, cpu_usage_core_seconds, memory_usage_byte_seconds,
      payload_metadata, payload_sha256, occurred_at, ingested_at, idempotency_key
    ) VALUES (
      ${sqlLiteral(telemetryEventId)}, 'control-api', 'trace_maintenance',
      ${sqlLiteral(`e2e-telemetry-${suffix}`)}, 'usage_sample', 'periodic_sample',
      'succeeded', 'e2e_capacity_pressure', ${sqlLiteral(fixture.environment)},
      ${sqlLiteral(fixture.clusterName)}, ${sqlLiteral(fixture.namespace)},
      ${sqlLiteral(fixture.workloadKind)}, ${sqlLiteral(fixture.workloadRef)},
      'Deployment', ${sqlLiteral(fixture.workloadRef)}, NOW() - INTERVAL '60 seconds',
      NOW(), 3, 3, 2, 1, 2, 1073741824, 2147483648, 75,
      96636764160, '{}'::jsonb, ${sqlLiteral(telemetryPayloadSha256)}, NOW(), NOW(),
      ${sqlLiteral(fixtureSha256())}
    );

    INSERT INTO governed_event_stream (
      event_family, event_id, schema_version, occurred_at, ingested_at,
      environment, workload_ref, payload_sha256
    ) VALUES (
      'infrastructure_telemetry', ${sqlLiteral(telemetryEventId)}, 1, NOW(), NOW(),
      ${sqlLiteral(fixture.environment)}, ${sqlLiteral(fixture.workloadRef)},
      ${sqlLiteral(telemetryPayloadSha256)}
    );

    INSERT INTO infrastructure_price_snapshots (
      id, cloud_provider, cloud_project_id, region, cluster_class, resource_class,
      unit, unit_price, currency, effective_from, source_ref, source_sha256
    ) VALUES (
      ${sqlLiteral(priceSnapshotId)}, 'gcp', ${sqlLiteral(fixture.cloudProjectId)},
      ${sqlLiteral(fixture.clusterLocation)}, 'e2e-standard', 'cpu', 'vCPU_hour',
      0.416666667, ${sqlLiteral(fixture.currency)}, ${sqlLiteral(`${anchorDate}T00:00:00.000Z`)}::timestamptz,
      'e2e://governed-cost-display', ${sqlLiteral(fixtureSha256())}
    );

    INSERT INTO infrastructure_cost_daily (
      id, utc_day, cloud_provider, cloud_project_id, cluster_location, cluster_name,
      environment, namespace, workload_kind, workload_ref, valuation_kind,
      selected_basis, currency, rollup_version, publication_state,
      completeness_status, as_of_utc, source_interval_start, source_interval_end,
      billing_export_watermark, source_count, source_sha256,
      gross_amount, credits_amount, net_amount
    ) VALUES
      (
        ${sqlLiteral(estimatedId)}, ${sqlLiteral(anchorDate)}::date, 'gcp',
        ${sqlLiteral(fixture.cloudProjectId)}, ${sqlLiteral(fixture.clusterLocation)},
        ${sqlLiteral(fixture.clusterName)}, ${sqlLiteral(fixture.environment)},
        ${sqlLiteral(fixture.namespace)}, ${sqlLiteral(fixture.workloadKind)},
        ${sqlLiteral(fixture.workloadRef)}, 'estimated', 'requested_capacity',
        ${sqlLiteral(fixture.currency)}, 1, 'finalized', 'complete', NOW(),
        ${sqlLiteral(`${anchorDate}T00:00:00.000Z`)}::timestamptz,
        ${sqlLiteral(intervalEnd)}::timestamptz, NULL, 1, ${sqlLiteral(fixtureSha256())},
        10, -1, 9
      ),
      (
        ${sqlLiteral(billedId)}, ${sqlLiteral(anchorDate)}::date, 'gcp',
        ${sqlLiteral(fixture.cloudProjectId)}, ${sqlLiteral(fixture.clusterLocation)},
        ${sqlLiteral(fixture.clusterName)}, ${sqlLiteral(fixture.environment)},
        ${sqlLiteral(fixture.namespace)}, ${sqlLiteral(fixture.workloadKind)},
        ${sqlLiteral(fixture.workloadRef)}, 'billed', 'gcp_request_allocation',
        ${sqlLiteral(fixture.currency)}, 1, 'finalized', 'complete', NOW(),
        NULL, NULL, NOW() - INTERVAL '1 hour', 2, ${sqlLiteral(fixtureSha256())},
        12, -0.5, 11.5
      );

    INSERT INTO infrastructure_cost_daily_components (
      daily_cost_id, valuation_kind, selected_basis, component_key, resource_class,
      allocation_bucket, unit_hours, price_snapshot_id, provider_service, provider_sku,
      billing_view_version, source_row_count, source_sha256, billing_export_watermark,
      gross_amount, credits_amount, net_amount
    ) VALUES
      (
        ${sqlLiteral(estimatedId)}, 'estimated', 'requested_capacity', 'cpu', 'cpu',
        NULL, 24, ${sqlLiteral(priceSnapshotId)}, NULL, NULL, NULL, NULL,
        ${sqlLiteral(fixtureSha256())}, NULL, 10, -1, 9
      ),
      (
        ${sqlLiteral(billedId)}, 'billed', 'gcp_request_allocation', 'compute',
        'provider_sku', NULL, NULL, NULL, 'GKE', 'compute', 'e2e-v1', 1,
        ${sqlLiteral(fixtureSha256())}, NOW() - INTERVAL '1 hour', 10, -0.5, 9.5
      ),
      (
        ${sqlLiteral(billedId)}, 'billed', 'gcp_request_allocation', 'unallocated',
        'allocation_bucket', 'kube:unallocated', NULL, NULL, 'GKE', 'unallocated',
        'e2e-v1', 1, ${sqlLiteral(fixtureSha256())}, NOW() - INTERVAL '1 hour',
        2, 0, 2
      );

    COMMIT;
  `)

  return fixture
}

function workflowRunCount(recipeName: string): number {
  return Number(
    profilesSql(`
      SELECT COUNT(*)
        FROM workflow_runs
       WHERE recipe_namespace = ${sqlLiteral(WORKFLOW_RECIPE_NS)}
         AND recipe_name = ${sqlLiteral(recipeName)};
    `)
  )
}

function governedRunEventCount(runId: string): number {
  return Number(
    profilesSql(`
      SELECT COUNT(*)
        FROM agent_run_events
       WHERE run_id = ${sqlLiteral(runId)};
    `)
  )
}

function parsePrometheusLabels(raw: string): Record<string, string> {
  const labels: Record<string, string> = {}
  const labelPattern = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"\\])*)"/g
  for (const match of raw.matchAll(labelPattern)) {
    labels[match[1]!] = match[2]!.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  return labels
}

function metricValue(
  body: string,
  metricName: string,
  expectedLabels: Record<string, string>
): number {
  for (const line of body.split('\n')) {
    if (line.startsWith('#') || !line.startsWith(metricName)) continue

    const match = line.match(
      /^[a-zA-Z_:][a-zA-Z0-9_:]*(?:\{([^}]*)\})?\s+(-?(?:\d+|\d*\.\d+)(?:e[+-]?\d+)?)$/i
    )
    if (!match) continue

    const labels = parsePrometheusLabels(match[1] ?? '')
    const matchesLabels = Object.entries(expectedLabels).every(
      ([key, value]) => labels[key] === value
    )
    if (matchesLabels) return Number(match[2])
  }

  return 0
}

async function readGovernedTraceMetrics(): Promise<GovernedTraceMetricSnapshot> {
  const response = await fetch(`${CONTROL_API}/metrics`)
  expect(response.status, `GET ${CONTROL_API}/metrics`).toBe(200)
  const body = await response.text()
  return {
    runStartAccepted: metricValue(body, GOVERNED_TRACE_ACCEPTED_METRIC, {
      ...GOVERNED_TRACE_LABELS,
      type: 'run_start',
    }),
    runEndAccepted: metricValue(body, GOVERNED_TRACE_ACCEPTED_METRIC, {
      ...GOVERNED_TRACE_LABELS,
      type: 'run_end',
    }),
  }
}

async function expectGovernedTraceMetricDelta(
  before: GovernedTraceMetricSnapshot,
  runId: string
): Promise<void> {
  await expect
    .poll(
      async () => {
        const after = await readGovernedTraceMetrics()
        return {
          runStartAccepted: after.runStartAccepted - before.runStartAccepted,
          runEndAccepted: after.runEndAccepted - before.runEndAccepted,
        }
      },
      {
        timeout: 60_000,
        intervals: [500, 1_000, 2_000],
        message: `governed tracing /metrics should record exactly one start and end for workflow run ${runId}`,
      }
    )
    .toEqual({ runStartAccepted: 1, runEndAccepted: 1 })
}

async function waitForSucceededGovernedRun(runId: string): Promise<void> {
  let phase = ''
  await expect
    .poll(
      () => {
        phase = profilesSql(`
          SELECT phase
            FROM workflow_runs
           WHERE run_id = ${sqlLiteral(runId)}
             AND completed_at IS NOT NULL;
        `)
        return phase
      },
      {
        timeout: 120_000,
        intervals: [500, 1_000, 2_000],
        message: `timed out waiting for terminal workflow run ${runId}`,
      }
    )
    .toBe('Succeeded')

  await expect
    .poll(
      () =>
        Number(
          profilesSql(`
            SELECT COUNT(*)
              FROM agent_run_events
             WHERE run_id = ${sqlLiteral(runId)}
               AND event_type = 'run_end';
          `)
        ),
      {
        timeout: 60_000,
        intervals: [500, 1_000, 2_000],
        message: `governed terminal evidence should exist for workflow run ${runId}`,
      }
    )
    .toBe(1)
}

function approvalRequestCount(recipeName: string): number {
  return Number(
    profilesSql(`
      SELECT COUNT(*)
        FROM workflow_approval_requests
       WHERE recipe_namespace = ${sqlLiteral(WORKFLOW_RECIPE_NS)}
         AND recipe_name = ${sqlLiteral(recipeName)};
    `)
  )
}

function triggerGrantCount(
  table: 'user_workflow_triggers' | 'team_workflow_triggers',
  recipeName: string
): number {
  return Number(
    profilesSql(`
      SELECT COUNT(*)
        FROM ${table}
       WHERE recipe_namespace = ${sqlLiteral(WORKFLOW_RECIPE_NS)}
         AND recipe_name = ${sqlLiteral(recipeName)};
    `)
  )
}

async function waitForLatestRun(recipeName: string): Promise<{
  runId: string
  actorType: string
  usageTeamId: string
  approvalRequestId: string
  inputs: Record<string, unknown> | null
}> {
  let raw = ''
  await expect
    .poll(
      () => {
        raw = profilesSql(`
          SELECT run_id::text || '|' ||
                 actor_type || '|' ||
                 COALESCE(usage_team_id, '<none>') || '|' ||
                 COALESCE(approval_request_id::text, '<none>') || '|' ||
                 COALESCE(inputs::text, 'null')
            FROM workflow_runs
           WHERE recipe_namespace = ${sqlLiteral(WORKFLOW_RECIPE_NS)}
             AND recipe_name = ${sqlLiteral(recipeName)}
           ORDER BY created_at DESC
           LIMIT 1;
        `)
        return raw
      },
      {
        timeout: 60_000,
        intervals: [500, 1_000, 2_000],
        message: `timed out waiting for workflow run for ${WORKFLOW_RECIPE_NS}/${recipeName}`,
      }
    )
    .toMatch(/^[0-9a-f-]{36}\|/)

  const [runId, actorType, usageTeamId, approvalRequestId, inputsRaw] = raw.split('|')
  if (!runId || !actorType || !usageTeamId || !approvalRequestId || !inputsRaw) {
    throw new Error(`unexpected workflow run row shape for ${WORKFLOW_RECIPE_NS}/${recipeName}`)
  }
  return {
    runId,
    actorType,
    usageTeamId,
    approvalRequestId,
    inputs: JSON.parse(inputsRaw) as Record<string, unknown> | null,
  }
}

async function waitForLatestApproval(recipeName: string): Promise<{
  id: string
  status: string
}> {
  let raw = ''
  await expect
    .poll(
      () => {
        raw = profilesSql(`
          SELECT id::text || '|' || status
            FROM workflow_approval_requests
           WHERE recipe_namespace = ${sqlLiteral(WORKFLOW_RECIPE_NS)}
             AND recipe_name = ${sqlLiteral(recipeName)}
           ORDER BY requested_at DESC
           LIMIT 1;
        `)
        return raw
      },
      {
        timeout: 60_000,
        intervals: [500, 1_000, 2_000],
        message: `timed out waiting for approval request for ${WORKFLOW_RECIPE_NS}/${recipeName}`,
      }
    )
    .toMatch(/^[0-9a-f-]{36}\|/)

  const [id, status] = raw.split('|')
  if (!id || !status) {
    throw new Error(`unexpected approval request row shape for ${WORKFLOW_RECIPE_NS}/${recipeName}`)
  }
  return { id, status }
}

async function dismissControlUiAccountAlert(page: Page): Promise<void> {
  const accountAlert = page.getByRole('status').filter({ hasText: 'Set up your admin email' })
  const dismissAccountAlert = accountAlert.getByRole('button', { name: 'Remind me later' })
  if (await dismissAccountAlert.isVisible()) {
    await dismissAccountAlert.click()
    await expect(accountAlert).toBeHidden()
  }
}

async function loginControlUi(page: Page): Promise<void> {
  await page.goto(CONTROL_UI)
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible({ timeout: 20_000 })
  const inputs = page.locator('input')
  await inputs.nth(0).fill(ADMIN_USER)
  await inputs.nth(1).fill(ADMIN_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).last().click()
  await expect(page.getByRole('link', { name: 'Plugins' })).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible({
    timeout: 30_000,
  })
  await dismissControlUiAccountAlert(page)
}

async function openInfrastructureTracing(page: Page): Promise<void> {
  await page.goto(`${CONTROL_UI}/traces`)
  await expect(page).toHaveURL(new RegExp(`${CONTROL_UI}/traces$`))
  await page.getByRole('link', { name: 'Infrastructure', exact: true }).click()
  await expect.poll(() => new URL(page.url()).pathname).toBe('/traces/infrastructure')
}

async function filterInfrastructureTracingByWorkload(
  page: Page,
  workloadRef: string
): Promise<void> {
  await page.getByRole('button', { name: 'Filter Workload / event' }).click()
  const dialog = page.getByRole('dialog', { name: 'Workload / event filters' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Workload reference').fill(workloadRef)
  await expect.poll(() => new URL(page.url()).searchParams.get('workloadRef')).toBe(workloadRef)
  await dialog.getByRole('button', { name: 'Done' }).click()
  await expect(dialog).toBeHidden()
}

async function submitInfrastructureCostQuery(
  page: Page,
  fixture: InfrastructureCostFixture
): Promise<Locator> {
  await page.getByLabel('Time range *').selectOption('day')
  await page.getByLabel('Date *').fill(fixture.anchorDate)
  const workload = page.getByLabel('Workload *')
  await expect(workload).toBeEnabled({ timeout: 30_000 })
  const fixtureOption = workload.locator('option').filter({ hasText: fixture.workloadRef })
  await expect(fixtureOption).toHaveCount(1)
  const fixtureOptionValue = await fixtureOption.getAttribute('value')
  if (fixtureOptionValue === null) throw new Error('persisted cost scope option has no value')
  await workload.selectOption(fixtureOptionValue)
  await page.getByLabel('Cost view *').selectOption('variance')
  const scope = page.getByRole('group', { name: 'Selected workload metadata' })
  await expect(scope).toContainText(fixture.cloudProjectId)
  await expect(scope).toContainText(fixture.clusterLocation)
  await expect(scope).toContainText(fixture.clusterName)
  await expect(scope).toContainText(fixture.currency)
  await expect(page.getByLabel('Cloud project *')).toHaveCount(0)
  await expect(page.getByLabel('Currency *')).toHaveCount(0)
  await page.getByRole('button', { name: 'View costs' }).click()

  const results = page.getByRole('region', { name: 'Infrastructure cost results' })
  await expect(results).toBeVisible({ timeout: 30_000 })
  return results
}

async function expectChartUsesThemeTokens(
  chart: Locator
): Promise<{ accent: string; warning: string }> {
  const theme = await chart.evaluate(root => {
    const resolveColor = (value: string): string => {
      const probe = document.createElement('span')
      probe.style.color = value
      document.body.appendChild(probe)
      const resolved = getComputedStyle(probe).color
      probe.remove()
      return resolved
    }
    const fills = Array.from(root.querySelectorAll<SVGElement>('svg *'))
      .flatMap(element => [element.getAttribute('fill'), element.style.fill])
      .filter((value): value is string => Boolean(value))
    return {
      accent: resolveColor('var(--cu-accent)'),
      fills: [...new Set(fills)],
      warning: resolveColor('var(--cu-warning)'),
    }
  })

  expect(theme.fills).toContain('var(--cu-accent)')
  expect(theme.fills).toContain('var(--cu-warning)')
  return { accent: theme.accent, warning: theme.warning }
}

async function openControlUiRecipeFromList(page: Page, recipeName: string): Promise<void> {
  await page.goto(`${CONTROL_UI}/workflow-recipes`)
  await expect(page.getByRole('searchbox', { name: 'Search plugins' })).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.getByRole('button', { name: 'Install Plugin' })).toBeVisible({
    timeout: 30_000,
  })

  const search = page.getByRole('searchbox', { name: 'Search plugins' })
  await expect(search).toBeVisible({ timeout: 20_000 })
  await search.fill(recipeName)

  const row = page.getByRole('link', { name: `Open ${recipeName}` })
  await expect(row).toBeVisible({ timeout: 45_000 })
  await expect(row).toContainText(WORKFLOW_RECIPE_NS)
  await dismissControlUiAccountAlert(page)
  await row.click({ timeout: 20_000 })

  await expect(page).toHaveURL(
    new RegExp(
      `/workflow-recipes/${WORKFLOW_RECIPE_NS}/${recipeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`
    ),
    { timeout: 30_000 }
  )
  await expect(page.getByRole('heading', { name: recipeName })).toBeVisible({ timeout: 30_000 })
}

async function grantUserThroughAuthenticatedControlUi(
  page: Page,
  recipeName: string,
  userEmail: string
): Promise<void> {
  await loginControlUi(page)
  await openControlUiRecipeFromList(page, recipeName)
  await page.getByRole('tab', { name: 'Members' }).click()
  const triggerUsers = page.getByTestId('workflow-access-trigger-users')
  await expect(triggerUsers).toBeVisible({ timeout: 20_000 })
  const search = triggerUsers.getByRole('textbox', { name: 'Search users...' })
  await expect(search).toBeVisible({ timeout: 20_000 })
  await search.fill(userEmail)
  const option = triggerUsers.getByRole('option').filter({ hasText: userEmail })
  await expect(option).toBeVisible({ timeout: 20_000 })
  await option.click()
  await expect(option).toHaveAttribute('aria-selected', 'true', { timeout: 20_000 })
  const addMember = triggerUsers.getByRole('button', { name: 'Add member' })
  await expect(addMember).toBeEnabled({ timeout: 20_000 })
  await addMember.click()
  await expect(
    triggerUsers.getByRole('button', { name: `Remove member trigger access: ${userEmail}` })
  ).toBeVisible({ timeout: 20_000 })
}

async function triggerControlUiOperatorRun(
  page: Page,
  recipeName: string,
  packet: string
): Promise<string> {
  await openControlUiRecipeFromList(page, recipeName)
  const runsBefore = workflowRunCount(recipeName)

  const runButton = page.getByRole('button', { name: /^Run/ }).first()
  await expect(runButton).toBeEnabled({ timeout: 90_000 })
  await runButton.click()

  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible({ timeout: 15_000 })
  await expect(
    dialog.getByRole('heading', { name: new RegExp(`Run .*${recipeName}`) })
  ).toBeVisible()
  await expect(dialog.getByText(/Starts an on-demand operator run in/i)).toBeVisible()

  const packetInput = dialog.getByLabel('packet')
  await expect(packetInput).toBeVisible()
  await packetInput.fill(packet)

  await dialog.getByRole('button', { name: /^Run as operator$/ }).click()
  await expect
    .poll(() => workflowRunCount(recipeName), {
      timeout: 60_000,
      intervals: [500, 1_000, 2_000],
      message: `Control UI operator trigger should create a workflow run for ${recipeName}`,
    })
    .toBeGreaterThan(runsBefore)

  const { runId } = await waitForLatestRun(recipeName)
  await page.getByRole('tab', { name: /^Runs/ }).click()
  const runLink = page.getByRole('link', { name: `Open run ${runId.slice(0, 8)}` })
  await expect(runLink).toBeVisible({ timeout: 30_000 })
  await runLink.click()
  await expect(page).toHaveURL(new RegExp(`/runs/${runId}$`), { timeout: 30_000 })
  await expect(page.getByRole('heading', { name: `Run ${runId.slice(0, 8)}` })).toBeVisible({
    timeout: 30_000,
  })
  return runId
}

async function triggerDesktopWorkflowThroughUi(
  page: Page,
  recipeName: string,
  packet?: string
): Promise<void> {
  await openWorkflowsPage(page)
  const detailCard = await selectWorkflow(page, recipeName, WORKFLOW_RECIPE_NS)
  if (packet !== undefined) {
    const packetInput = detailCard.getByLabel('packet *')
    await expect(packetInput).toBeVisible({ timeout: 20_000 })
    await packetInput.fill(packet)
  }
  const triggerButton = detailCard.getByRole('button', { name: /^Trigger$/ })
  await expect(triggerButton).toBeEnabled({ timeout: 30_000 })
  await triggerButton.click()
}

async function approvePendingApprovalThroughDesktopUi(
  page: Page,
  recipeName: string
): Promise<void> {
  const bell = page.getByRole('button', { name: 'Notifications and approvals' })
  await expect(bell).toBeVisible({ timeout: 20_000 })
  await bell.click()

  const panel = page.getByRole('dialog', { name: 'Notifications and approvals' })
  await expect(panel).toBeVisible({ timeout: 10_000 })

  const card = panel.locator('.notification-item').filter({ hasText: recipeName }).first()
  await expect(card).toBeVisible({ timeout: 60_000 })
  await expect(card).toContainText(`Approve ${WORKFLOW_RECIPE_NS}/${recipeName}`)
  await expect(card.getByRole('button', { name: 'Deny' })).toBeVisible()

  const approveButton = card.getByRole('button', { name: 'Approve' })
  await expect(approveButton).toBeEnabled()
  await approveButton.click()

  await expect(page.getByRole('status').filter({ hasText: /Approval accepted/ })).toBeVisible({
    timeout: 20_000,
  })
  await expect(card).not.toBeVisible({ timeout: 30_000 })
}

test.describe.serial('Control UI operator workflow runs and Desktop approval boundaries', () => {
  test('Control UI presents governed trace and infrastructure cost analytics through canonical routes', async ({
    page,
  }) => {
    test.setTimeout(180_000)
    const fixture = seedInfrastructureCostFixture()

    await page.goto(`${CONTROL_UI}/traces/infrastructure`)
    await expect(page).toHaveURL(/\?next=%2Ftraces%2Finfrastructure$/)
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()

    await loginControlUi(page)
    await page.goto(`${CONTROL_UI}/traces`)
    await expect(page).toHaveURL(new RegExp(`${CONTROL_UI}/traces$`))
    await expect(page.getByRole('link', { name: 'Run replay', exact: true })).toHaveAttribute(
      'data-active',
      'true'
    )
    await expect(page.getByRole('group', { name: 'Loaded session summary' })).toBeVisible()

    await page.getByRole('link', { name: 'Administrative', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`${CONTROL_UI}/traces/administrative$`))
    await expect(page.getByText('Administrative events', { exact: true })).toBeVisible()
    await expect(page.getByRole('group', { name: 'Loaded governed event summary' })).toBeVisible()

    await page.getByRole('link', { name: 'Infrastructure', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`${CONTROL_UI}/traces/infrastructure$`))
    await expect(page.getByText('Infrastructure telemetry', { exact: true })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Infrastructure cost query' })).toBeVisible()
    const operations = page.getByRole('region', { name: 'Infrastructure operational snapshot' })
    await expect(operations).toContainText(fixture.workloadRef)
    await expect(operations).toContainText('Investigate')
    await expect(operations).toContainText('Ready 2 / 3')
    await expect(operations).toContainText('CPU 1.25 / 1.00 cores · 125%')
    await expect(operations).toContainText('Memory 1.50 / 1.00 GiB · 150%')
    await expect(operations).toContainText(
      '1 replica not ready · CPU at 125% of request · Memory at 150% of request'
    )
    await expect(operations.getByRole('img', { name: /Capacity pressure/ })).toBeVisible()
    await filterInfrastructureTracingByWorkload(page, fixture.workloadRef)
    await expect(operations.locator('tbody tr')).toHaveCount(1)

    const results = await submitInfrastructureCostQuery(page, fixture)
    const estimated = page.getByRole('region', {
      name: 'Estimated requested capacity cost summary',
    })
    const billed = page.getByRole('region', { name: 'GCP billed cost summary' })
    await expect(estimated).toContainText('Net cost$9.00')
    await expect(estimated).toContainText('Period coverage1 / 1 days')
    await expect(billed).toContainText('Net cost$11.50')
    await expect(billed).toContainText('Period coverage1 / 1 days')
    await expect(results).toContainText('Net difference')
    await expect(results).toContainText('$2.50')
    await expect(results).toContainText('Variance rate')
    await expect(results).toContainText(/\+27\.78%/)
    await expect(results).toContainText('kube:unallocated')
    await expect(results.getByRole('img', { name: /Net cost comparison/ })).toBeVisible()

    expect(
      Number(
        profilesSql(`
          SELECT COUNT(*)
            FROM infrastructure_cost_daily
           WHERE cloud_project_id = ${sqlLiteral(fixture.cloudProjectId)}
             AND workload_ref = ${sqlLiteral(fixture.workloadRef)};
        `)
      )
    ).toBe(2)
  })

  test('Control UI trace charts resolve semantic colors in dark and light modes', async ({
    page,
  }) => {
    test.setTimeout(180_000)
    const fixture = seedInfrastructureCostFixture()
    await loginControlUi(page)
    const resolvedThemes: Partial<Record<'dark' | 'light', { accent: string; warning: string }>> =
      {}

    for (const theme of ['dark', 'light'] as const) {
      await page.getByRole('link', { name: 'Settings', exact: true }).click()
      const radio = page.getByRole('radio', {
        name: new RegExp(`^${theme === 'dark' ? 'Dark' : 'Light'}`),
      })
      await page.locator(`label[for="settings-theme-${theme}"]`).click()
      await expect(radio).toBeChecked()
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)

      await openInfrastructureTracing(page)
      await filterInfrastructureTracingByWorkload(page, fixture.workloadRef)
      const operations = page.getByRole('region', {
        name: 'Infrastructure operational snapshot',
      })
      const pressureChart = operations.getByRole('img', { name: /Capacity pressure/ })
      await expect(pressureChart).toBeVisible()
      const pressureTheme = await expectChartUsesThemeTokens(pressureChart)

      const results = await submitInfrastructureCostQuery(page, fixture)
      const costChart = results.getByRole('img', { name: /Net cost comparison/ })
      await expect(costChart).toBeVisible()
      const costTheme = await expectChartUsesThemeTokens(costChart)
      expect(costTheme).toEqual(pressureTheme)
      resolvedThemes[theme] = pressureTheme
    }

    expect(resolvedThemes.dark?.accent).toBe(resolvedThemes.light?.accent)
    expect(resolvedThemes.dark?.warning).not.toBe(resolvedThemes.light?.warning)

    await page.setViewportSize({ height: 844, width: 390 })
    const sidebar = page.getByRole('complementary', { name: 'Main navigation' })
    await expect
      .poll(async () => {
        const box = await sidebar.boundingBox()
        return box ? Math.round(box.x + box.width) : Number.POSITIVE_INFINITY
      })
      .toBeLessThanOrEqual(0)
    const costPanel = page.getByRole('region', { name: 'Infrastructure cost query' })
    const operations = page.getByRole('region', { name: 'Infrastructure operational snapshot' })
    const results = page.getByRole('region', { name: 'Infrastructure cost results' })
    await expect(costPanel).toBeVisible()
    await expect(operations.getByRole('img', { name: /Capacity pressure/ })).toBeVisible()
    await expect(results.getByRole('img', { name: /Net cost comparison/ })).toBeVisible()
    const viewport = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }))
    expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth)
  })

  test('Control UI admin runs approval-gated workflow as operator without user/team grants', async ({
    page,
  }) => {
    test.setTimeout(240_000)
    const recipeName = `e2e-quadrant-operator-${Date.now()}`
    const packet = `operator-packet-${Date.now()}`

    await cleanupRecipe(recipeName)
    applyRecipe(recipeName, {
      requiresApproval: true,
      allowedActors: ['user'],
      inputContract: OPERATOR_INPUT_CONTRACT,
      instruction: 'Record the operator packet {{inputs.packet}} for E2E validation.',
    })

    try {
      expect(triggerGrantCount('user_workflow_triggers', recipeName)).toBe(0)
      expect(triggerGrantCount('team_workflow_triggers', recipeName)).toBe(0)

      await loginControlUi(page)
      const metricsBefore = await readGovernedTraceMetrics()
      const runIdFromUi = await triggerControlUiOperatorRun(page, recipeName, packet)

      const run = await waitForLatestRun(recipeName)
      expect(run.runId).toBe(runIdFromUi)
      expect(run.actorType).toBe('admin')
      expect(run.usageTeamId).toBe('control-plane-admin-ui')
      expect(run.approvalRequestId).toBe('<none>')
      expect(run.inputs).toMatchObject({ packet })
      await expect
        .poll(() => governedRunEventCount(run.runId), {
          timeout: 60_000,
          intervals: [500, 1_000, 2_000],
          message: `governed lifecycle evidence should exist for workflow run ${run.runId}`,
        })
        .toBeGreaterThan(0)
      await waitForSucceededGovernedRun(run.runId)
      await expectGovernedTraceMetricDelta(metricsBefore, run.runId)

      const traceLink = page.getByRole('link', { name: 'Open governed trace replay' })
      await expect(traceLink).toBeVisible()
      await traceLink.click()
      await expect(page).toHaveURL(
        new RegExp(`/traces/workflows/${WORKFLOW_RECIPE_NS}/${recipeName}/runs/${run.runId}$`),
        { timeout: 30_000 }
      )
      await expect(page.getByText('Workflow run replay', { exact: true })).toBeVisible()
      await expect(page.getByRole('list', { name: 'Ordered governed events' })).toContainText(
        'run_start'
      )
      await expect(page.getByRole('list', { name: 'Ordered governed events' })).toContainText(
        'run_end'
      )
      expect(approvalRequestCount(recipeName)).toBe(0)
      expect(triggerGrantCount('user_workflow_triggers', recipeName)).toBe(0)
      expect(triggerGrantCount('team_workflow_triggers', recipeName)).toBe(0)
    } finally {
      await cleanupRecipe(recipeName)
    }
  })

  test('Control UI blocks on-demand recipe whose allowedActors excludes user', async ({ page }) => {
    test.setTimeout(180_000)
    const recipeName = `e2e-quadrant-wrong-actor-${Date.now()}`

    await cleanupRecipe(recipeName)
    applyRecipe(recipeName, {
      requiresApproval: true,
      allowedActors: ['autonomous'],
      instruction: 'This fixture must not be runnable from human on-demand UI.',
    })

    try {
      await loginControlUi(page)
      await openControlUiRecipeFromList(page, recipeName)

      await expect(page.getByRole('button', { name: /^Run/ })).not.toBeVisible({ timeout: 60_000 })
      expect(workflowRunCount(recipeName)).toBe(0)
      expect(approvalRequestCount(recipeName)).toBe(0)
    } finally {
      await cleanupRecipe(recipeName)
    }
  })

  test('Desktop user trigger still requires visible approval and creates approval-bound user run', async ({
    page: adminPage,
  }) => {
    test.setTimeout(300_000)
    await clearSession()

    const recipeName = `e2e-quadrant-desktop-approval-${Date.now()}`
    const packet = `desktop-approved-${Date.now()}`
    await loginAs(E2E_EMAIL)

    await cleanupRecipe(recipeName)
    applyRecipe(recipeName, {
      requiresApproval: true,
      allowedActors: ['user'],
      inputContract: OPERATOR_INPUT_CONTRACT,
      instruction: 'Record the Desktop packet {{inputs.packet}} for E2E validation.',
    })
    await grantUserThroughAuthenticatedControlUi(adminPage, recipeName, E2E_EMAIL)

    const { app, page } = await launchAndLogin(E2E_EMAIL)
    try {
      const metricsBefore = await readGovernedTraceMetrics()
      await triggerDesktopWorkflowThroughUi(page, recipeName, packet)
      await expect(
        page
          .getByRole('status')
          .filter({ hasText: 'Approval requested. Open notifications to approve.' })
      ).toBeVisible({ timeout: 30_000 })

      const approval = await waitForLatestApproval(recipeName)
      expect(approval.status).toBe('pending')
      expect(workflowRunCount(recipeName)).toBe(0)

      await approvePendingApprovalThroughDesktopUi(page, recipeName)

      await expect
        .poll(
          () =>
            profilesSql(`
              SELECT status
                FROM workflow_approval_requests
               WHERE id = ${sqlLiteral(approval.id)};
            `),
          { timeout: 45_000, intervals: [500, 1_000, 2_000] }
        )
        .toBe('consumed')

      const run = await waitForLatestRun(recipeName)
      expect(run.actorType).toBe('user')
      expect(run.approvalRequestId).toBe(approval.id)
      expect(run.inputs).toMatchObject({ packet })
      await waitForSucceededGovernedRun(run.runId)
      await expectGovernedTraceMetricDelta(metricsBefore, run.runId)

      await openControlUiRecipeFromList(adminPage, recipeName)
      await adminPage.getByRole('tab', { name: /^Runs/ }).click()
      const runLink = adminPage.getByRole('link', { name: `Open run ${run.runId.slice(0, 8)}` })
      await expect(runLink).toBeVisible({ timeout: 30_000 })
      await runLink.click()

      const traceLink = adminPage.getByRole('link', { name: 'Open governed trace replay' })
      await expect(traceLink).toBeVisible({ timeout: 30_000 })
      await traceLink.click()
      await expect(adminPage).toHaveURL(
        new RegExp(`/traces/workflows/${WORKFLOW_RECIPE_NS}/${recipeName}/runs/${run.runId}$`),
        { timeout: 30_000 }
      )
      const governedEvents = adminPage.getByRole('list', { name: 'Ordered governed events' })
      await expect(governedEvents).toContainText('run_start')
      await expect(governedEvents).toContainText('run_end')
    } finally {
      await app.close().catch(() => undefined)
      await cleanupRecipe(recipeName)
    }
  })

  test('Desktop user cannot trigger an approval-gated workflow without user or team grants', async () => {
    test.setTimeout(240_000)
    await clearSession()

    const recipeName = `e2e-quadrant-desktop-no-grant-${Date.now()}`
    const packet = `desktop-denied-${Date.now()}`

    await cleanupRecipe(recipeName)
    applyRecipe(recipeName, {
      requiresApproval: true,
      allowedActors: ['user'],
      inputContract: OPERATOR_INPUT_CONTRACT,
      instruction: 'This fixture must fail closed without trigger grants.',
    })

    const { app, page } = await launchAndLogin(E2E_EMAIL)
    try {
      expect(triggerGrantCount('user_workflow_triggers', recipeName)).toBe(0)
      expect(triggerGrantCount('team_workflow_triggers', recipeName)).toBe(0)

      await openWorkflowsPage(page)
      const row = workflowRow(page, recipeName)
      if (await row.isVisible().catch(() => false)) {
        const detailCard = await selectWorkflow(page, recipeName, WORKFLOW_RECIPE_NS)
        const packetInput = detailCard.getByLabel('packet *')
        await expect(packetInput).toBeVisible({ timeout: 20_000 })
        await packetInput.fill(packet)
        await detailCard.getByRole('button', { name: /^Trigger$/ }).click()

        const failureStatus = page.getByRole('alert').filter({ hasText: /Trigger failed:/ })
        await expect(failureStatus).toBeVisible({
          timeout: 30_000,
        })
        await expect(failureStatus).toContainText(/not authorized|forbidden|grant|approval/i)
      } else {
        await expect(row).not.toBeVisible()
      }

      expect(workflowRunCount(recipeName)).toBe(0)
      expect(approvalRequestCount(recipeName)).toBe(0)
    } finally {
      await app.close().catch(() => undefined)
      await cleanupRecipe(recipeName)
    }
  })
})
