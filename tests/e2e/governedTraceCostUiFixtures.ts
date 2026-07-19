import { createHash, randomUUID } from 'node:crypto'
import { runControlPostgresSql } from './gfsFixtureCore'

const CPU_PRICE_ID = '00000000-0000-4000-8000-00000000c001'
const MEMORY_PRICE_ID = '00000000-0000-4000-8000-00000000c002'

export type GovernedTraceCostUiFixture = {
  anchorDate: string
  workloadLabel: string
  workloadRef: string
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function previousUtcDay(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 86_400_000)
    .toISOString()
    .slice(0, 10)
}

export function seedGovernedTraceCostUiFixture(): GovernedTraceCostUiFixture {
  const now = new Date()
  const anchorDate = previousUtcDay(now)
  const workloadRef = `control-api-e2e-cost-${Date.now()}-${randomUUID().slice(0, 8)}`
  const estimatedId = randomUUID()
  const billedId = randomUUID()
  const dayStart = `${anchorDate}T00:00:00.000Z`
  const dayEnd = `${new Date(Date.parse(dayStart) + 86_400_000).toISOString()}`
  const watermark = now.toISOString()
  const project = 'clerum-e2e-cost'
  const location = 'europe-west1'
  const cluster = 'clerum-e2e'
  const environment = 'e2e'
  const namespace = 'control-plane'
  const kind = 'Deployment'
  const currency = 'USD'

  runControlPostgresSql(`
    BEGIN;
    SET CONSTRAINTS ALL DEFERRED;

    INSERT INTO infrastructure_price_snapshots (
      id, cloud_provider, cloud_project_id, region, cluster_class, resource_class,
      unit, unit_price, currency, effective_from, source_ref, source_sha256
    ) VALUES
      (
        '${CPU_PRICE_ID}', 'gcp', '${project}', '${location}', 'e2e-only', 'cpu',
        'vCPU_hour', 0.700000000, '${currency}', '2026-07-01T00:00:00.000Z',
        'pricing-export:e2e-fixture:cpu', '${sha256('e2e-cpu-price')}'
      ),
      (
        '${MEMORY_PRICE_ID}', 'gcp', '${project}', '${location}', 'e2e-only', 'memory',
        'GiB_hour', 0.300000000, '${currency}', '2026-07-01T00:00:00.000Z',
        'pricing-export:e2e-fixture:memory', '${sha256('e2e-memory-price')}'
      )
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO infrastructure_cost_daily (
      id, utc_day, cloud_provider, cloud_project_id, cluster_location, cluster_name,
      environment, namespace, workload_kind, workload_ref, valuation_kind,
      selected_basis, currency, rollup_version, predecessor_version,
      publication_state, completeness_status, as_of_utc, source_interval_start,
      source_interval_end, billing_export_watermark, source_count, source_sha256,
      gross_amount, credits_amount, net_amount
    ) VALUES (
      '${estimatedId}', '${anchorDate}', 'gcp', '${project}', '${location}', '${cluster}',
      '${environment}', '${namespace}', '${kind}', ${sqlLiteral(workloadRef)}, 'estimated',
      'requested_capacity', '${currency}', 1, NULL, 'finalized', 'complete', '${watermark}',
      '${dayStart}', '${dayEnd}', NULL, 2, '${sha256(`${workloadRef}:estimated`)}',
      1.000000000, 0.000000000, 1.000000000
    );

    INSERT INTO infrastructure_cost_daily_components (
      daily_cost_id, valuation_kind, selected_basis, component_key, resource_class,
      allocation_bucket, unit_hours, price_snapshot_id, provider_service, provider_sku,
      billing_view_version, source_row_count, source_sha256, billing_export_watermark,
      gross_amount, credits_amount, net_amount
    ) VALUES
      (
        '${estimatedId}', 'estimated', 'requested_capacity', 'cpu', 'cpu', NULL,
        1.000000000, '${CPU_PRICE_ID}', NULL, NULL, NULL, NULL,
        '${sha256(`${workloadRef}:estimated:cpu`)}', NULL,
        0.700000000, 0.000000000, 0.700000000
      ),
      (
        '${estimatedId}', 'estimated', 'requested_capacity', 'memory', 'memory', NULL,
        1.000000000, '${MEMORY_PRICE_ID}', NULL, NULL, NULL, NULL,
        '${sha256(`${workloadRef}:estimated:memory`)}', NULL,
        0.300000000, 0.000000000, 0.300000000
      );

    INSERT INTO infrastructure_cost_daily (
      id, utc_day, cloud_provider, cloud_project_id, cluster_location, cluster_name,
      environment, namespace, workload_kind, workload_ref, valuation_kind,
      selected_basis, currency, rollup_version, predecessor_version,
      publication_state, completeness_status, as_of_utc, source_interval_start,
      source_interval_end, billing_export_watermark, source_count, source_sha256,
      gross_amount, credits_amount, net_amount
    ) VALUES (
      '${billedId}', '${anchorDate}', 'gcp', '${project}', '${location}', '${cluster}',
      '${environment}', '${namespace}', '${kind}', ${sqlLiteral(workloadRef)}, 'billed',
      'gcp_request_allocation', '${currency}', 1, NULL, 'finalized', 'complete', '${watermark}',
      NULL, NULL, '${watermark}', 2, '${sha256(`${workloadRef}:billed`)}',
      1.100000000, -0.050000000, 1.050000000
    );

    INSERT INTO infrastructure_cost_daily_components (
      daily_cost_id, valuation_kind, selected_basis, component_key, resource_class,
      allocation_bucket, unit_hours, price_snapshot_id, provider_service, provider_sku,
      billing_view_version, source_row_count, source_sha256, billing_export_watermark,
      gross_amount, credits_amount, net_amount
    ) VALUES
      (
        '${billedId}', 'billed', 'gcp_request_allocation', 'gke-compute', 'provider_sku',
        NULL, NULL, NULL, 'Kubernetes Engine', 'e2e-gke-compute', 'gcp-billing-v1-e2e', 1,
        '${sha256(`${workloadRef}:billed:compute`)}', '${watermark}',
        0.900000000, -0.050000000, 0.850000000
      ),
      (
        '${billedId}', 'billed', 'gcp_request_allocation', 'system-overhead',
        'allocation_bucket', 'kube:system-overhead', NULL, NULL, 'Kubernetes Engine',
        'e2e-system-overhead', 'gcp-billing-v1-e2e', 1,
        '${sha256(`${workloadRef}:billed:overhead`)}', '${watermark}',
        0.200000000, 0.000000000, 0.200000000
      );

    COMMIT;
  `)

  return {
    anchorDate,
    workloadRef,
    workloadLabel: `${namespace}/${workloadRef} · ${kind} · ${environment}/${cluster} · ${project} · ${currency}`,
  }
}

export function cleanupGovernedTraceCostUiFixture(workloadRef: string): void {
  runControlPostgresSql(`
    BEGIN;
    SET LOCAL governed_trace.retention_delete = 'on';
    DELETE FROM infrastructure_cost_daily_components
     WHERE daily_cost_id IN (
       SELECT id FROM infrastructure_cost_daily WHERE workload_ref = ${sqlLiteral(workloadRef)}
     );
    DELETE FROM infrastructure_cost_daily WHERE workload_ref = ${sqlLiteral(workloadRef)};
    COMMIT;
  `)
}
