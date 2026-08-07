import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  addPluginWorkloadSdkAttemptLedgerColumns,
  addPluginWorkloadSdkCredentialTicketRuntimeAccess,
  addPluginWorkloadSdkNotExecutedSpendOutcome,
  addPluginWorkloadSdkPolicyReviewProvenance,
  addPluginWorkloadSdkProtocolAndRevocation,
  addPluginWorkloadSdkRuntimeAccess,
  repairPluginWorkloadSdkLegacyGrantPolicies,
} from '../src/services/pluginWorkloadSdkSchema.js'

describe('plugin workload SDK protocol migration', () => {
  it('qualifies attempt completed_at when backfilling from invocations', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })

    await addPluginWorkloadSdkProtocolAndRevocation({ query } as never)

    const migrationSql = String(query.mock.calls[0]?.[0])
    expect(migrationSql).toContain('completed_at = COALESCE(attempts.completed_at, now())')
    expect(migrationSql).toContain('ALTER COLUMN contract_version SET DEFAULT 1')
    expect(migrationSql).toContain('plugin_workload_sdk_invocations_v2_lease_check')
  })

  it('grants attempt-ledger DML only to control_api_runtime', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })

    await addPluginWorkloadSdkRuntimeAccess({ query } as never)

    const migrationSql = String(query.mock.calls[0]?.[0])
    expect(migrationSql).toContain(
      'FROM PUBLIC, trace_maintenance_runtime, workflow_recipes_runtime'
    )
    expect(migrationSql).toContain('TO control_api_runtime')
    expect(migrationSql).toContain('plugin_workload_sdk_invocation_attempts')
    expect(migrationSql).toContain('plugin_workload_sdk_provider_attempts')
  })

  it('reconciles the credential-ticket JTI table to the exact control-api runtime contract', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })

    await addPluginWorkloadSdkCredentialTicketRuntimeAccess({ query } as never)

    const migrationSql = String(query.mock.calls[0]?.[0])
    expect(migrationSql).toContain(
      'REVOKE ALL PRIVILEGES ON TABLE plugin_workload_sdk_credential_ticket_jtis'
    )
    expect(migrationSql).toContain(
      'FROM PUBLIC, control_api_runtime, trace_maintenance_runtime, workflow_recipes_runtime'
    )
    expect(migrationSql).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE plugin_workload_sdk_credential_ticket_jtis'
    )
    expect(migrationSql).toContain('TO control_api_runtime')
  })

  it('declares credential-ticket JTI access as legacy DML in the deploy contract', () => {
    const contractPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../deploy/scripts/control-api-runtime-access-profiles.tsv'
    )
    const contractEntries = readFileSync(contractPath, 'utf8')
      .split('\n')
      .filter(line => line && !line.startsWith('#'))
      .map(line => line.split('\t'))
      .filter(([relation]) => relation === 'plugin_workload_sdk_credential_ticket_jtis')

    expect(contractEntries).toEqual([['plugin_workload_sdk_credential_ticket_jtis', 'legacy_dml']])
  })

  it('registers the credential-ticket ACL repair as migration 0089 before the runtime reconciliation', () => {
    const dbPath = join(dirname(fileURLToPath(import.meta.url)), '../src/db.ts')
    const source = readFileSync(dbPath, 'utf8')

    expect(source).toMatch(
      /version: '0089_plugin_workload_sdk_credential_ticket_runtime_access',\s+apply: addPluginWorkloadSdkCredentialTicketRuntimeAccess/
    )
    expect(source).toMatch(
      /version: '0090_plugin_workload_sdk_runtime_contract_reconciliation',\s+apply: reconcilePluginWorkloadSdkRuntimeContracts/
    )
  })

  it('preserves only complete ordered active policies while adding the attempt ledger', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })

    await addPluginWorkloadSdkAttemptLedgerColumns({ query } as never)

    const migrationSql = String(query.mock.calls[0]?.[0])
    expect(migrationSql).toContain(
      "policy_state IN ('active', 'legacy_unreviewed', 'revoking', 'disabled')"
    )
    expect(migrationSql).toContain("jsonb_typeof(prompt_targets) = 'array'")
    expect(migrationSql).toContain("(prompt_targets -> 0 ->> 'targetRef') = default_target_ref")
    expect(migrationSql).toContain("(prompt_targets -> 0 ->> 'provider') = provider")
    expect(migrationSql).toContain("COUNT(DISTINCT target ->> 'targetRef')")
    expect(migrationSql).toContain("policy_state = 'active'")
  })

  it('keeps the legacy policy repair migration fail-closed', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })

    await repairPluginWorkloadSdkLegacyGrantPolicies({ query } as never)

    expect(query).not.toHaveBeenCalled()
  })

  it('adds durable review provenance and re-fences ambiguous active rows', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })

    await addPluginWorkloadSdkPolicyReviewProvenance({ query } as never)

    const migrationSql = String(query.mock.calls[0]?.[0])
    expect(migrationSql).toContain('policy_reviewed_at TIMESTAMPTZ NULL')
    expect(migrationSql).toContain('policy_reviewed_by TEXT NULL')
    expect(migrationSql).toContain("SET policy_state = 'legacy_unreviewed'")
    expect(migrationSql).toContain('policy_reviewed_at IS NULL')
    expect(migrationSql).toContain('policy_revision = 0')
    expect(migrationSql).not.toContain("SET policy_state = 'active'")
  })

  it('keeps no-execution receipts distinct from unknown provider spend', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })

    await addPluginWorkloadSdkNotExecutedSpendOutcome({ query } as never)

    const migrationSql = String(query.mock.calls[0]?.[0])
    expect(migrationSql).toContain("outcome IN ('exact', 'unknown', 'not_executed')")
    expect(migrationSql).toContain("outcome IN ('unknown', 'not_executed')")
    expect(migrationSql).toContain('DROP CONSTRAINT IF EXISTS')
  })
})
