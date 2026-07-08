import { describe, expect, it } from 'vitest'
import { resolveMcpServerFullNames } from '../../../src/workflow/workflowReconciler'

/**
 * NP-04 regression: NetworkPolicy pod selector must match the pod's
 * `clerum.io/mcpserver` label. The label value differs by owner:
 *
 *   • HCC (external McpServer CRDs): label = McpServer.metadata.name
 *     → equals the endpoint URL hostname
 *
 *   • WRC (workflow workloads[] with transport): resourceBuilder sets
 *     label = the runtime-safe McpServer label for that workload
 *     → the endpoint URL hostname and label are resolved from the same
 *       canonical mapping, so long child recipe names stay label-safe
 *
 * The resolver distinguishes the two cases via `workloadIdsWithTransport`.
 */
describe('resolveMcpServerFullNames (NP-04)', () => {
  const RECIPE = 'e2e-mythos-research'

  it('workload-spawned: returns the supplied runtime-safe workload label', () => {
    const workloadIds = new Set(['web-search'])
    const workloadLabels = new Map([['web-search', 'e2e-mythos-research-web-search-ced3d40a']])
    const names = resolveMcpServerFullNames(
      RECIPE,
      [
        {
          id: 'web-search',
          // endpoint uses HASHED resource name (Deployment/Service name)
          endpoint:
            'http://e2e-mythos-research-web-search-ced3d40a.mcp-server.svc.cluster.local:3000/mcp',
        },
      ],
      workloadIds,
      workloadLabels
    )
    expect(names).toEqual(['e2e-mythos-research-web-search-ced3d40a'])
  })

  it('external McpServer CRD: extracts hostname from endpoint (= label value)', () => {
    const names = resolveMcpServerFullNames(
      RECIPE,
      [
        {
          id: 'airtable-svc', // raw id, distinct from hostname
          endpoint: 'http://e2e-airtable-mcp.mcp-server.svc.cluster.local:3000/mcp',
        },
      ],
      new Set<string>() // no workload with this id
    )
    expect(names).toEqual(['e2e-airtable-mcp'])
  })

  it('mixed recipe: workload-spawned + external in one call', () => {
    const workloadIds = new Set(['web-search'])
    const names = resolveMcpServerFullNames(
      RECIPE,
      [
        {
          id: 'airtable-svc',
          endpoint: 'http://e2e-airtable-mcp.mcp-server.svc.cluster.local:3000/mcp',
        },
        {
          id: 'web-search',
          endpoint:
            'http://e2e-mythos-research-web-search-abc123.mcp-server.svc.cluster.local:3000/mcp',
        },
      ],
      workloadIds
    )
    expect(names).toEqual([
      'e2e-airtable-mcp', // external → hostname
      'e2e-mythos-research-web-search', // workload fallback without explicit label map
    ])
  })

  it('legacy fallback: no endpoint, not a workload → {recipe}-{id}', () => {
    const names = resolveMcpServerFullNames(RECIPE, [{ id: 'legacy' }])
    expect(names).toEqual(['e2e-mythos-research-legacy'])
  })

  it('malformed external endpoint URL → falls back to id', () => {
    const names = resolveMcpServerFullNames(
      RECIPE,
      [{ id: 'broken', endpoint: 'not-a-url' }],
      new Set<string>()
    )
    expect(names).toEqual(['broken'])
  })

  it('undefined input returns empty array', () => {
    expect(resolveMcpServerFullNames(RECIPE, undefined)).toEqual([])
  })

  it('workloadIdsWithTransport omitted → treats all as external', () => {
    // Backward-compat: without the 3rd arg, any server with endpoint uses hostname
    const names = resolveMcpServerFullNames(RECIPE, [
      {
        id: 'airtable-svc',
        endpoint: 'http://e2e-airtable-mcp.mcp-server.svc.cluster.local:3000/mcp',
      },
    ])
    expect(names).toEqual(['e2e-airtable-mcp'])
  })
})
