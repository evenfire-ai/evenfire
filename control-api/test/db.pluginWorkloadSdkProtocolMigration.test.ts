import { describe, expect, it, vi } from 'vitest'
import {
  addPluginWorkloadSdkProtocolAndRevocation,
  addPluginWorkloadSdkRuntimeAccess,
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
})
