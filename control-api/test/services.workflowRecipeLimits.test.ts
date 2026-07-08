import { describe, expect, it, vi } from 'vitest'
import {
  validateWorkflowRecipeEgressPreflight,
  validateWorkflowRecipeLimits,
} from '../src/services/workflowRecipeLimits.js'

const DEFAULT_LIMITS = {
  workflowMaxWorkloadsPerRecipe: 25,
  workflowUiEgressInternalMaxItems: 25,
  workflowMaxSteps: 100,
  workflowStepDependsOnMaxItems: 100,
  workflowStepAllowedToolsMaxItems: 50,
  workflowStepMcpServersMaxItems: 20,
}

function steps(count: number) {
  return Array.from({ length: count }, (_, i) => ({ id: `s${i}`, instruction: `Step ${i}` }))
}

describe('validateWorkflowRecipeLimits', () => {
  it('accepts default runtime boundaries', () => {
    const dependencyIds = Array.from({ length: 100 }, (_, i) => `dep${i}`)
    const errors = validateWorkflowRecipeLimits(
      {
        workloads: [
          { id: 'api', type: 'deployment', image: 'api:v1' },
          { id: 'worker', type: 'deployment', image: 'worker:v1' },
          { id: 'cron', type: 'job', image: 'job:v1' },
        ],
        ui: {
          workloadRef: 'api',
          port: 8080,
          egress: {
            internal: [
              { workloadRef: 'api', port: 8000 },
              { workloadRef: 'worker', port: 8000 },
              { workloadRef: 'cron', port: 8000 },
            ],
          },
        },
        steps: [
          {
            id: 's0',
            instruction: 'Aggregate',
            dependsOn: dependencyIds.map(() => 's1'),
            mcpServers: Array.from({ length: 20 }, (_, i) => `srv${i}`),
            allowedTools: { include: Array.from({ length: 50 }, (_, i) => `srv0__tool${i}`) },
          },
          ...steps(99).map((step, i) => ({ ...step, id: `s${i + 1}` })),
        ],
      },
      DEFAULT_LIMITS
    )

    expect(errors).toEqual([])
  })

  it.each([
    [
      'workflow workloads',
      {
        workloads: Array.from({ length: 26 }, (_, index) => ({
          id: `service-${index}`,
          type: 'deployment',
          image: 'nginx:1.30.1-alpine',
        })),
      },
      [{ field: 'spec.workloads', message: 'must contain at most 25 items' }],
    ],
    [
      'UI internal egress refs',
      {
        ui: {
          workloadRef: 'web',
          port: 8080,
          egress: {
            internal: Array.from({ length: 26 }, (_, index) => ({
              workloadRef: `api-${index}`,
              port: 8000,
            })),
          },
        },
      },
      [{ field: 'spec.ui.egress.internal', message: 'must contain at most 25 items' }],
    ],
    [
      'workflow steps',
      { steps: steps(101) },
      [{ field: 'spec.steps', message: 'must contain at most 100 items' }],
    ],
    [
      'step dependency fan-in',
      {
        steps: [
          { id: 's0', instruction: 'Step 0' },
          {
            id: 'aggregate',
            instruction: 'Aggregate',
            dependsOn: Array.from({ length: 101 }, () => 's0'),
          },
        ],
      },
      [{ field: 'spec.steps[1].dependsOn', message: 'must contain at most 100 items' }],
    ],
    [
      'step MCP server refs',
      {
        steps: [
          {
            id: 'research',
            instruction: 'Research',
            mcpServers: Array.from({ length: 21 }, (_, i) => `srv${i}`),
          },
        ],
      },
      [{ field: 'spec.steps[0].mcpServers', message: 'must contain at most 20 items' }],
    ],
    [
      'step allowed tools include list',
      {
        steps: [
          {
            id: 'research',
            instruction: 'Research',
            allowedTools: { include: Array.from({ length: 51 }, (_, i) => `srv0__tool${i}`) },
          },
        ],
      },
      [
        {
          field: 'spec.steps[0].allowedTools.include',
          message: 'must contain at most 50 items',
        },
      ],
    ],
  ])('rejects one item over the configured default for %s', (_name, spec, expectedErrors) => {
    const errors = validateWorkflowRecipeLimits(spec, DEFAULT_LIMITS)

    expect(errors).toEqual(expectedErrors)
  })

  it('uses configured lower runtime limits instead of CRD ceilings', () => {
    const errors = validateWorkflowRecipeLimits(
      {
        workloads: [
          { id: 'api', type: 'deployment', image: 'api:v1' },
          { id: 'worker', type: 'deployment', image: 'worker:v1' },
          { id: 'cron', type: 'job', image: 'job:v1' },
        ],
        ui: {
          workloadRef: 'api',
          port: 8080,
          egress: {
            internal: [
              { workloadRef: 'api', port: 8000 },
              { workloadRef: 'worker', port: 8000 },
              { workloadRef: 'cron', port: 8000 },
            ],
          },
        },
        steps: [
          ...steps(4),
          {
            id: 'aggregate',
            instruction: 'Aggregate',
            dependsOn: ['s0', 's1', 's2'],
            mcpServers: ['srv0', 'srv1', 'srv2'],
            allowedTools: { include: ['srv0__a', 'srv0__b', 'srv0__c'] },
          },
        ],
      },
      {
        workflowMaxSteps: 4,
        workflowMaxWorkloadsPerRecipe: 2,
        workflowUiEgressInternalMaxItems: 2,
        workflowStepDependsOnMaxItems: 2,
        workflowStepAllowedToolsMaxItems: 2,
        workflowStepMcpServersMaxItems: 2,
      }
    )

    expect(errors).toEqual([
      { field: 'spec.workloads', message: 'must contain at most 2 items' },
      { field: 'spec.ui.egress.internal', message: 'must contain at most 2 items' },
      { field: 'spec.steps', message: 'must contain at most 4 items' },
      { field: 'spec.steps[4].dependsOn', message: 'must contain at most 2 items' },
      { field: 'spec.steps[4].mcpServers', message: 'must contain at most 2 items' },
      {
        field: 'spec.steps[4].allowedTools.include',
        message: 'must contain at most 2 items',
      },
    ])
  })

  it('rejects duplicate step ids and unknown step dependencies before Kubernetes admission', () => {
    const errors = validateWorkflowRecipeLimits(
      {
        steps: [
          { id: 'research', instruction: 'Research' },
          { id: 'research', instruction: 'Duplicate' },
          { id: 'summary', instruction: 'Summarize', dependsOn: ['missing'] },
        ],
      },
      DEFAULT_LIMITS
    )

    expect(errors).toContainEqual({
      field: 'spec.steps[1].id',
      message: 'duplicate step id "research"',
    })
    expect(errors).toContainEqual({
      field: 'spec.steps[2].dependsOn[0]',
      message: 'references unknown step id "missing"',
    })
  })

  it('rejects workload/runtime/step egress cardinality before Kubernetes', () => {
    const hosts = Array.from({ length: 21 }, (_, index) => `api-${index}.example.com`)
    const errors = validateWorkflowRecipeLimits(
      {
        workloads: [
          {
            id: 'web-search',
            transport: { type: 'streamableHttp' },
            egressBindings: hosts.map(dns => ({ dns, port: 443, protocol: 'TCP' })),
          },
        ],
        runtimeEgress: { http: { allowedHosts: hosts } },
        steps: [
          {
            id: 'fetch',
            instruction: 'Fetch data',
            run: { capabilities: { http: { allowedHosts: hosts } } },
          },
        ],
      },
      DEFAULT_LIMITS
    )

    expect(errors).toContainEqual({
      field: 'spec.workloads[0].egressBindings',
      message: 'must contain at most 20 items',
    })
    expect(errors).toContainEqual({
      field: 'spec.runtimeEgress.http.allowedHosts',
      message: 'must contain at most 20 items',
    })
    expect(errors).toContainEqual({
      field: 'spec.steps[0].run.capabilities.http.allowedHosts',
      message: 'must contain at most 20 items',
    })
  })

  it.each(['deployment', 'statefulset', 'job', 'cronjob', 'daemonset'])(
    'accepts exact-host egressBindings on non-transport %s workloads before Kubernetes',
    type => {
      const errors = validateWorkflowRecipeLimits(
        {
          workloads: [
            {
              id: 'worker',
              type,
              image: 'worker:latest',
              egressBindings: [{ dns: 'api.example.com', port: 443 }],
            },
          ],
        },
        DEFAULT_LIMITS
      )

      expect(errors).toEqual([])
    }
  )

  it('rejects public-web egressBindings on non-transport workloads before Kubernetes', () => {
    const errors = validateWorkflowRecipeLimits(
      {
        workloads: [
          {
            id: 'worker',
            type: 'deployment',
            image: 'worker:latest',
            egressBindings: [{ egressClass: 'public-web' }],
          },
        ],
      },
      DEFAULT_LIMITS
    )

    expect(errors).toContainEqual({
      field: 'spec.workloads[0].egressBindings[0].egressClass',
      message:
        'public-web is only supported on MCP transport workloads; non-transport workloads must use exact-host egressBindings',
    })
  })
})

describe('validateWorkflowRecipeEgressPreflight', () => {
  it('rejects WorkflowRecipe workload CIDR egress before WRC/Kubernetes', async () => {
    const errors = await validateWorkflowRecipeEgressPreflight({
      workloads: [
        {
          id: 'web-search',
          transport: { type: 'streamableHttp' },
          egressBindings: [{ cidr: '8.8.8.8/32', port: 443 }],
        },
      ],
    })

    expect(errors).toContainEqual({
      field: 'spec.workloads[0].egressBindings[0].cidr',
      message: 'cidr is not supported on this egress surface; use dns exact-host or public-web',
    })
  })

  it('preflights exact-host egressBindings on non-transport workloads', async () => {
    const resolveDns = vi.fn(async () => ['93.184.216.34'])
    const errors = await validateWorkflowRecipeEgressPreflight(
      {
        workloads: [
          {
            id: 'worker',
            type: 'deployment',
            image: 'worker:latest',
            egressBindings: [{ dns: 'api.example.com', port: 443 }],
          },
        ],
      },
      { resolveDns }
    )

    expect(errors).toEqual([])
    expect(resolveDns).toHaveBeenCalledWith('api.example.com')
  })

  it('rejects public-web egressBindings on non-transport workloads during preflight', async () => {
    const resolveDns = vi.fn(async () => ['93.184.216.34'])
    const errors = await validateWorkflowRecipeEgressPreflight(
      {
        workloads: [
          {
            id: 'worker',
            type: 'deployment',
            image: 'worker:latest',
            egressBindings: [{ egressClass: 'public-web' }],
          },
        ],
      },
      { resolveDns }
    )

    expect(errors).toContainEqual({
      field: 'spec.workloads[0].egressBindings[0].egressClass',
      message:
        'public-web is only supported on MCP transport workloads; non-transport workloads must use exact-host egressBindings',
    })
    expect(resolveDns).not.toHaveBeenCalled()
  })

  it('accepts cluster-local sibling refs on non-transport workloads without resolving DNS', async () => {
    const resolveDns = vi.fn(async () => ['10.0.0.5'])
    const errors = await validateWorkflowRecipeEgressPreflight(
      {
        workloads: [
          {
            id: 'chat-api',
            type: 'deployment',
            image: 'chat-api:latest',
            egressBindings: [
              { dns: 'db.sandbox-recipes.svc.cluster.local', port: 5432, protocol: 'TCP' },
            ],
          },
          {
            id: 'db',
            type: 'statefulset',
            image: 'postgres:16',
          },
        ],
      },
      { resolveDns }
    )

    expect(errors).toEqual([])
    expect(resolveDns).not.toHaveBeenCalled()
  })

  it('accepts mixed cluster-local sibling and public exact-host refs while resolving only public DNS', async () => {
    const resolveDns = vi.fn(async () => ['93.184.216.34'])
    const errors = await validateWorkflowRecipeEgressPreflight(
      {
        workloads: [
          {
            id: 'chat-api',
            type: 'deployment',
            image: 'chat-api:latest',
            egressBindings: [
              {
                dns: 'helpdesk-db.sandbox-recipes.svc.cluster.local',
                port: 5432,
                protocol: 'TCP',
              },
              { dns: 'api.anthropic.com', port: 443, protocol: 'TCP' },
            ],
          },
          {
            id: 'helpdesk-db',
            type: 'statefulset',
            image: 'postgres:16',
          },
        ],
      },
      { resolveDns }
    )

    expect(errors).toEqual([])
    expect(resolveDns).toHaveBeenCalledTimes(1)
    expect(resolveDns).toHaveBeenCalledWith('api.anthropic.com')
  })

  it('rejects cluster-local egressBindings on transport workloads', async () => {
    const resolveDns = vi.fn(async () => ['10.0.0.5'])
    const errors = await validateWorkflowRecipeEgressPreflight(
      {
        workloads: [
          {
            id: 'mcp',
            transport: { type: 'streamableHttp' },
            egressBindings: [
              { dns: 'db.sandbox-recipes.svc.cluster.local', port: 5432, protocol: 'TCP' },
            ],
          },
          {
            id: 'db',
            type: 'statefulset',
            image: 'postgres:16',
          },
        ],
      },
      { resolveDns }
    )

    expect(errors).toContainEqual({
      field: 'spec.workloads[0].egressBindings[0].dns',
      message: 'cluster-local egressBindings are only supported on non-transport workloads',
    })
    expect(resolveDns).not.toHaveBeenCalled()
  })

  it('rejects cluster-local dns that does not match a sibling workload', async () => {
    const resolveDns = vi.fn(async () => ['10.0.0.5'])
    const errors = await validateWorkflowRecipeEgressPreflight(
      {
        workloads: [
          {
            id: 'chat-api',
            type: 'deployment',
            image: 'chat-api:latest',
            egressBindings: [
              { dns: 'other.sandbox-recipes.svc.cluster.local', port: 5432, protocol: 'TCP' },
            ],
          },
        ],
      },
      { resolveDns }
    )

    expect(errors).toContainEqual(
      expect.objectContaining({
        field: 'spec.workloads[0].egressBindings[0].dns',
        message: expect.stringContaining('does not match any workload id in this recipe'),
      })
    )
    expect(resolveDns).not.toHaveBeenCalled()
  })

  it('rejects cluster-local dns that targets a namespace outside the recipe runtime namespace', async () => {
    const resolveDns = vi.fn(async () => ['10.0.0.5'])
    const errors = await validateWorkflowRecipeEgressPreflight(
      {
        workloads: [
          {
            id: 'chat-api',
            type: 'deployment',
            image: 'chat-api:latest',
            egressBindings: [
              { dns: 'db.other-namespace.svc.cluster.local', port: 5432, protocol: 'TCP' },
            ],
          },
          {
            id: 'db',
            type: 'statefulset',
            image: 'postgres:16',
          },
        ],
      },
      { resolveDns }
    )

    expect(errors).toContainEqual(
      expect.objectContaining({
        field: 'spec.workloads[0].egressBindings[0].dns',
        message: expect.stringContaining('targets namespace "other-namespace"'),
      })
    )
    expect(resolveDns).not.toHaveBeenCalled()
  })

  it('rejects non-transport workload exact-host DNS that resolves to blocked ranges', async () => {
    const resolveDns = vi.fn(async () => ['10.0.0.5'])
    const errors = await validateWorkflowRecipeEgressPreflight(
      {
        workloads: [
          {
            id: 'worker',
            type: 'deployment',
            image: 'worker:latest',
            egressBindings: [{ dns: 'api.example.com', port: 443 }],
          },
        ],
      },
      { resolveDns }
    )

    expect(errors).toContainEqual(
      expect.objectContaining({
        field: 'spec.workloads[0].egressBindings[0].dns',
        message: expect.stringContaining('10.0.0.5'),
      })
    )
  })

  it('rejects workload exact-host DNS that resolves to blocked ranges with workload field paths', async () => {
    const resolveDns = vi.fn(async () => ['10.0.0.5'])
    const errors = await validateWorkflowRecipeEgressPreflight(
      {
        workloads: [
          {
            id: 'web-search',
            transport: { type: 'streamableHttp' },
            egressBindings: [{ dns: 'duckduckgo.com', port: 443 }],
          },
        ],
      },
      { resolveDns }
    )

    expect(errors).toContainEqual(
      expect.objectContaining({
        field: 'spec.workloads[0].egressBindings[0].dns',
        message: expect.stringContaining('10.0.0.5'),
      })
    )
  })

  it('preflights runtime and step allowedHosts with actionable field paths', async () => {
    const resolveDns = vi.fn(async (hostname: string) => {
      if (hostname === 'runtime.example.com') return ['93.184.216.34']
      return []
    })

    const errors = await validateWorkflowRecipeEgressPreflight(
      {
        runtimeEgress: { http: { allowedHosts: ['runtime.example.com'] } },
        steps: [
          {
            id: 'fetch',
            instruction: 'Fetch data',
            run: {
              capabilities: {
                http: { allowedHosts: ['missing.example.com'] },
              },
            },
          },
        ],
      },
      { resolveDns }
    )

    expect(errors).toEqual([
      expect.objectContaining({
        field: 'spec.steps[0].run.capabilities.http.allowedHosts[0].dns',
        message: expect.stringContaining('did not resolve'),
      }),
    ])
  })

  it('rejects runtime public-web HTTP egress that also declares allowedHosts', async () => {
    const errors = await validateWorkflowRecipeEgressPreflight({
      runtimeEgress: { http: { egressClass: 'public-web', allowedHosts: ['api.example.com'] } },
    })

    expect(errors).toContainEqual({
      field: 'spec.runtimeEgress.http.allowedHosts',
      message: 'allowedHosts must be omitted when egressClass is public-web',
    })
  })

  it('rejects step public-web HTTP shapes that would be rejected later by WRC', async () => {
    const errors = await validateWorkflowRecipeEgressPreflight({
      runtimeEgress: { http: { egressClass: 'public-web' } },
      steps: [
        {
          id: 'fetch',
          instruction: 'Fetch data',
          run: {
            capabilities: {
              http: { egressClass: 'public-web', allowedHosts: ['api.example.com'] },
            },
          },
        },
      ],
    })

    expect(errors).toContainEqual({
      field: 'spec.steps[0].run.capabilities.http.allowedHosts',
      message: 'allowedHosts must be omitted when egressClass is public-web',
    })
  })

  it('rejects step public-web HTTP egress unless runtime HTTP egress is also public-web', async () => {
    const errors = await validateWorkflowRecipeEgressPreflight({
      steps: [
        {
          id: 'fetch',
          instruction: 'Fetch data',
          run: {
            capabilities: {
              http: { egressClass: 'public-web' },
            },
          },
        },
      ],
    })

    expect(errors).toContainEqual({
      field: 'spec.steps[0].run.capabilities.http.egressClass',
      message: 'public-web requires spec.runtimeEgress.http.egressClass public-web',
    })
  })

  it('rejects step HTTP allowedHosts when workflow runtime HTTP egress is public-web', async () => {
    const errors = await validateWorkflowRecipeEgressPreflight({
      runtimeEgress: { http: { egressClass: 'public-web' } },
      steps: [
        {
          id: 'fetch',
          instruction: 'Fetch data',
          run: {
            capabilities: {
              http: { allowedHosts: ['api.example.com'] },
            },
          },
        },
      ],
    })

    expect(errors).toContainEqual({
      field: 'spec.steps[0].run.capabilities.http.allowedHosts',
      message: 'allowedHosts cannot be used when spec.runtimeEgress.http.egressClass is public-web',
    })
  })
})
