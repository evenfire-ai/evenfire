import { describe, expect, it, vi } from 'vitest'
import type { DbClient } from '../src/db.js'
import { AccessExecutionBudget } from '../src/services/access/accessExecutionBudget.js'
import type { CatalogOperationalSourceState } from '../src/services/access/catalogContracts.js'
import type { OperationalSourceFamily } from '../src/services/access/operationalAccessProjection.js'
import {
  loadOperationalResourceGraphs,
  operationalResourceGraphKey,
} from '../src/services/access/operationalAccessReader.js'

function resourceRow(resourceType: string, sourceFamily: string): Record<string, unknown> {
  return {
    environment_id: 'test-environment',
    resource_type: resourceType,
    logical_id: 'shared-logical-id',
    source_family: sourceFamily,
    provider_uid: `${resourceType}-uid`,
    provider_resource_version: '1',
    display_name: resourceType,
    enabled: true,
    deleted_at: null,
    observed_generation: 1,
    content_bytes: 1,
    behavior_sources: {},
  }
}

describe('operational resource graph batching', () => {
  it('keeps identical logical IDs distinct across resource types', async () => {
    const rows = [resourceRow('host', 'host'), resourceRow('context', 'context')]
    const query = vi.fn(async (text: string, values: unknown[] = []) => {
      if (text.includes('FROM operational_resource_index resource')) {
        const requested = JSON.parse(String(values[1])) as string[][]
        return {
          rows: rows.filter(row =>
            requested.some(
              ([type, logicalId, family]) =>
                row.resource_type === type &&
                row.logical_id === logicalId &&
                row.source_family === family
            )
          ),
        }
      }
      if (text.includes('FROM operational_resource_relationships relationship')) {
        return { rows: [] }
      }
      if (text.includes('FROM operational_resource_index')) return { rows }
      throw new Error('unexpected_operational_graph_query')
    })
    const db = { query } as unknown as Pick<DbClient, 'query'>
    const sourceStates = new Map<OperationalSourceFamily, CatalogOperationalSourceState>(
      (['host', 'context', 'mcp_server', 'shared_filesystem'] as const).map(
        family =>
          [
            family,
            {
              family,
              generation: '1',
              resourceVersion: '1',
              status: 'current',
            },
          ] as const
      )
    )
    const budget = AccessExecutionBudget.create('catalog')
    try {
      const graphs = await loadOperationalResourceGraphs({
        db,
        budget,
        environmentId: 'test-environment',
        roots: [
          { resourceType: 'host', logicalId: 'shared-logical-id' },
          { resourceType: 'context', logicalId: 'shared-logical-id' },
        ],
        sourceStates,
      })

      const host = graphs.get(operationalResourceGraphKey('host', 'shared-logical-id'))
      const context = graphs.get(operationalResourceGraphKey('context', 'shared-logical-id'))
      expect(host).toMatchObject({ status: 'current', resource: { resourceType: 'host' } })
      expect(context).toMatchObject({ status: 'current', resource: { resourceType: 'context' } })
      expect(graphs).toHaveProperty('size', 2)
      expect(query).toHaveBeenCalledTimes(3)
    } finally {
      budget.close()
    }
  })
})
