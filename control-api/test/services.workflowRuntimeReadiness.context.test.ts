import { describe, expect, it } from 'vitest'
import { config } from '../src/config.js'
import { getWorkflowRuntimeReadiness } from '../src/services/workflows/workflowRecipeAccessService.js'
import { MockGateway } from './mockGateway.js'

/**
 * A workflow transport's readiness checks that the recipe's own Context
 * (`spec.contextRef` of the recipe, else its private `wf-<recipe>` Context)
 * allowlists the runtime MCP server. The McpServer CR is not consulted for the
 * Context: a server written before it stopped carrying one may still name a
 * different Context, and that stale value must not decide readiness.
 */

const NS = config.mcpServersNamespace
const RECIPE = 'digest'
const SERVER = 'wf-digest-transport'

async function arrange(serverExtraSpec: Record<string, unknown>) {
  const gateway = new MockGateway(NS)
  await gateway.createResource(
    'mcpservers',
    {
      metadata: { name: SERVER },
      spec: { managed: false, transport: { type: 'streamableHttp' }, ...serverExtraSpec },
      status: { conditions: [{ type: 'Ready', status: 'True' }] },
    },
    NS
  )
  await gateway.createResource(
    'contexts',
    {
      metadata: { name: `wf-${RECIPE}` },
      spec: { contextId: `wf-${RECIPE}`, mcpServers: [SERVER] },
    },
    NS
  )
  gateway.seedServiceEndpoints(SERVER, NS, 1)
  const recipe = {
    metadata: { name: RECIPE, namespace: 'sandbox-recipes' },
    spec: { workloads: [{ id: 'transport', transport: { type: 'streamableHttp' } }] },
    status: { phase: 'Active', workloadInstances: { transport: SERVER } },
  }
  return { gateway, recipe }
}

describe('workflow runtime readiness reads the recipe Context, not the McpServer one', () => {
  it('ready when the recipe Context allowlists the server', async () => {
    const { gateway, recipe } = await arrange({})
    expect(await getWorkflowRuntimeReadiness(gateway as never, recipe)).toEqual({ ready: true })
  })

  it('ready even when the McpServer CR still names another Context', async () => {
    const { gateway, recipe } = await arrange({ contextRef: 'some-other-context' })
    expect(await getWorkflowRuntimeReadiness(gateway as never, recipe)).toEqual({ ready: true })
  })
})
