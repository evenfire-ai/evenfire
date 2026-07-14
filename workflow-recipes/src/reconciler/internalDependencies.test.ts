import { describe, expect, it } from 'vitest'
import type { CronJobDef, DeploymentDef, WorkflowRecipeCRD, WorkloadDef } from '../types'
import { evaluateInternalDependencies } from './internalDependencies'
import { resolveWorkloadTemplates } from './workloadTemplates'

function recipe(
  workloads: WorkloadDef[],
  overrides: Partial<WorkflowRecipeCRD> = {}
): WorkflowRecipeCRD {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name: 'recipe-recap', namespace: 'sandbox-recipes', uid: 'uid-recap' },
    spec: { workloads },
    status: { phase: 'approved', workloadInstances: {} },
    ...overrides,
  }
}

function deployment(id: string, port?: number, extra: Partial<DeploymentDef> = {}): WorkloadDef {
  return { id, type: 'deployment', image: `${id}:test`, ...(port ? { port } : {}), ...extra }
}

function cron(id: string, extra: Partial<CronJobDef> = {}): WorkloadDef {
  return { id, type: 'cronjob', image: `${id}:test`, schedule: '* * * * *', ...extra }
}

function evaluate(r: WorkflowRecipeCRD) {
  return evaluateInternalDependencies({
    recipe: r,
    workloads: r.spec.workloads ?? [],
    uiWorkloadId: r.spec.ui?.workloadRef,
    strictUnknownTargetNamespaces: ['sandbox-recipes'],
    resolveNamespace: workload => resolveNamespaceForTest(r, workload),
  })
}

function resolveNamespaceForTest(r: WorkflowRecipeCRD, workload: WorkloadDef): string {
  return workload.transport
    ? 'mcp-server'
    : workload.id === r.spec.ui?.workloadRef
      ? 'sandbox-ui'
      : 'sandbox-recipes'
}

describe('evaluateInternalDependencies', () => {
  it('infers LeadForge-like api, worker, and cron dependencies from resolved workload hosts', () => {
    const r = recipe([
      deployment('api', 8080, {
        env: [{ name: 'DB_HOST', value: 'prospector-db.sandbox-recipes.svc.cluster.local' }],
      }),
      deployment('worker', undefined, {
        env: [{ name: 'CACHE_HOST', value: 'prospector-cache.sandbox-recipes.svc.cluster.local' }],
      }),
      cron('prospector-prospect-cron', {
        env: [
          {
            name: 'DB_HOST',
            value: 'postgres://prospector-db.sandbox-recipes.svc.cluster.local:5432',
          },
          {
            name: 'CACHE_HOST',
            value: 'redis://prospector-cache.sandbox-recipes.svc.cluster.local:6379',
          },
        ],
      }),
      deployment('prospector-db', 5432),
      deployment('prospector-cache', 6379),
    ])

    const out = evaluate(r)

    expect(out.issues).toEqual([])
    expect(out.dependencies).toHaveLength(4)
    expect(
      out.dependencies.map(d => `${d.sourceWorkloadId}->${d.targetWorkloadId}:${d.port}`)
    ).toEqual([
      'api->prospector-db:5432',
      'prospector-prospect-cron->prospector-cache:6379',
      'prospector-prospect-cron->prospector-db:5432',
      'worker->prospector-cache:6379',
    ])
  })

  it('infers dependencies after WRC resolves workload host and port templates', () => {
    const r = recipe([
      deployment('api', 8080, {
        env: [{ name: 'DB_URL', value: 'postgres://{{db:host}}:{{db:port}}/app' }],
      }),
      deployment('db', 5432),
    ])

    resolveWorkloadTemplates({
      recipe: r,
      workloads: r.spec.workloads ?? [],
      inputs: {},
      resolveNamespace: workload => resolveNamespaceForTest(r, workload),
    })

    expect((r.spec.workloads?.[0] as DeploymentDef).env?.[0].value).toBe(
      'postgres://db.sandbox-recipes.svc.cluster.local:5432/app'
    )
    const out = evaluate(r)

    expect(out.issues).toEqual([])
    expect(out.dependencies).toHaveLength(1)
    expect(out.dependencies[0]).toMatchObject({
      sourceWorkloadId: 'api',
      targetWorkloadId: 'db',
      port: 5432,
      fields: ['env.DB_URL'],
    })
  })

  it('fails closed if workload host templates reach evaluation before resolution', () => {
    const out = evaluate(
      recipe([
        deployment('api', 8080, {
          env: [{ name: 'DB_URL', value: 'postgres://{{db:host}}:{{db:port}}/app' }],
        }),
        deployment('db', 5432),
      ])
    )

    expect(out.dependencies).toEqual([])
    expect(out.issues).toHaveLength(1)
    expect(out.issues[0]).toMatchObject({
      reason: 'InvalidInternalDependency',
      sourceWorkloadId: 'api',
      targetWorkloadId: 'db',
    })
    expect(out.issues[0].message).toContain('must run after workload template resolution')
  })

  it('fails closed if a workload port template remains unresolved next to a resolved host', () => {
    const out = evaluate(
      recipe([
        deployment('api', 8080, {
          env: [
            {
              name: 'DB_URL',
              value: 'postgres://db.sandbox-recipes.svc.cluster.local:{{db:port}}/app',
            },
          ],
        }),
        deployment('db', 5432),
      ])
    )

    expect(out.dependencies).toEqual([])
    expect(out.issues).toHaveLength(1)
    expect(out.issues[0]).toMatchObject({
      reason: 'InvalidInternalDependency',
      sourceWorkloadId: 'api',
      targetWorkloadId: 'db',
    })
    expect(out.issues[0].message).toContain('{{db:port}}')
  })

  it('matches status-assigned runtime Service names and collapses duplicate env command args refs', () => {
    const r = recipe(
      [
        deployment('recap-worker', undefined, {
          env: [{ name: 'A', value: 'recap-db-a1b2c3d4.sandbox-recipes.svc.cluster.local' }],
          command: ['node', 'recap-db-a1b2c3d4.sandbox-recipes.svc.cluster.local'],
          args: ['--db=recap-db-a1b2c3d4.sandbox-recipes.svc.cluster.local'],
        }),
        deployment('recap-db', 5432),
      ],
      { status: { phase: 'approved', workloadInstances: { 'recap-db': 'recap-db-a1b2c3d4' } } }
    )

    const out = evaluate(r)

    expect(out.issues).toEqual([])
    expect(out.dependencies).toHaveLength(1)
    expect(out.dependencies[0]).toMatchObject({
      sourceWorkloadId: 'recap-worker',
      targetWorkloadId: 'recap-db',
      targetServiceName: 'recap-db-a1b2c3d4',
      fields: ['env.A', 'command[1]', 'args[0]'],
    })
  })

  it('fails closed when a resolved cluster-local reference uses the wrong explicit port', () => {
    const out = evaluate(
      recipe([
        deployment('api', 8080, {
          env: [
            {
              name: 'DB_URL',
              value: 'postgres://db.sandbox-recipes.svc.cluster.local:15432/app',
            },
          ],
        }),
        deployment('db', 5432),
      ])
    )

    expect(out.dependencies).toEqual([])
    expect(out.issues).toHaveLength(1)
    expect(out.issues[0]).toMatchObject({
      reason: 'InvalidInternalDependency',
      sourceWorkloadId: 'api',
      targetWorkloadId: 'db',
    })
    expect(out.issues[0].message).toContain('port 15432')
    expect(out.issues[0].message).toContain('declares port 5432')
  })

  it('allows WRC-owned HTTP transport sources in mcp-server to reach sandbox-recipes targets', () => {
    const r = recipe([
      deployment('mcp-recap', 3000, {
        transport: { type: 'streamableHttp', path: '/mcp' },
        env: [{ name: 'DB', value: 'recap-db.sandbox-recipes.svc.cluster.local' }],
      }),
      deployment('recap-db', 5432),
    ])

    const out = evaluate(r)

    expect(out.issues).toEqual([])
    expect(out.dependencies[0]).toMatchObject({
      sourceWorkloadId: 'mcp-recap',
      sourceNamespace: 'mcp-server',
      targetWorkloadId: 'recap-db',
      targetNamespace: 'sandbox-recipes',
    })
  })

  it('still fails closed for WRC-owned transport sources pointing at unknown sandbox-recipes targets', () => {
    const out = evaluate(
      recipe([
        deployment('mcp-recap', 3000, {
          transport: { type: 'streamableHttp', path: '/mcp' },
          env: [{ name: 'DB', value: 'recap-db.sandbox-recipes.svc.cluster.local' }],
        }),
      ])
    )

    expect(out.dependencies).toEqual([])
    expect(out.issues).toHaveLength(1)
    expect(out.issues[0]).toMatchObject({
      reason: 'InvalidInternalDependency',
      sourceWorkloadId: 'mcp-recap',
    })
    expect(out.issues[0].message).toContain('not an eligible runtime Service')
  })

  it('ignores shared HCC/control-api MCP URLs while inferring same-recipe workload hosts', () => {
    const out = evaluate(
      recipe([
        deployment('prospector-api', 8080, {
          env: [
            { name: 'PG_HOST', value: 'prospector-db.sandbox-recipes.svc.cluster.local' },
            {
              name: 'CONTACT_FINDER_MCP_URL',
              value: 'http://mcp-contact-finder.mcp-server.svc.cluster.local:3000/mcp',
            },
            {
              name: 'WEB_RESEARCH_MCP_URL',
              value: 'http://web-research.mcp-server.svc.cluster.local:3000/mcp',
            },
          ],
        }),
        deployment('prospector-db', 5432),
      ])
    )

    expect(out.issues).toEqual([])
    expect(out.dependencies).toHaveLength(1)
    expect(out.dependencies[0]).toMatchObject({
      sourceWorkloadId: 'prospector-api',
      targetWorkloadId: 'prospector-db',
      port: 5432,
    })
  })

  it('ignores unresolved shared mcp-server FQDNs because HCC owns that lane', () => {
    const out = evaluate(
      recipe([
        deployment('recap-api', 8080, {
          env: [
            {
              name: 'FATHOM_MCP_URL',
              value: 'http://mcp-fathom.mcp-server.svc.cluster.local:3000/mcp',
            },
          ],
        }),
      ])
    )

    expect(out.issues).toEqual([])
    expect(out.dependencies).toEqual([])
  })

  it('excludes UI sources from the internal-dependency lane', () => {
    const r = recipe(
      [
        deployment('ui', 3000, {
          env: [{ name: 'DB', value: 'db.sandbox-recipes.svc.cluster.local' }],
        }),
        deployment('db', 5432),
      ],
      {
        spec: { ui: { workloadRef: 'ui', port: 3000 }, workloads: [] } as WorkflowRecipeCRD['spec'],
      }
    )
    r.spec.workloads = [deployment('ui', 3000), deployment('db', 5432)]
    r.spec.workloads[0].env = [{ name: 'DB', value: 'db.sandbox-recipes.svc.cluster.local' }]

    const out = evaluate(r)

    expect(out.issues).toEqual([])
    expect(out.dependencies).toEqual([])
  })

  it('fails closed for managed-runtime lookalikes, missing target ports, and stdio ownership', () => {
    const lookalike = evaluate(
      recipe([
        deployment('api', 8080, {
          env: [{ name: 'DB', value: 'db.sandbox-recipes.svc.cluster.local' }],
        }),
      ])
    )
    const missingPort = evaluate(
      recipe([
        deployment('api', 8080, {
          env: [{ name: 'DB', value: 'db.sandbox-recipes.svc.cluster.local' }],
        }),
        deployment('db'),
      ])
    )
    const stdio = evaluate(
      recipe([
        deployment('stdio', 3000, {
          transport: { type: 'stdio' },
          env: [{ name: 'DB', value: 'db.sandbox-recipes.svc.cluster.local' }],
        }),
        deployment('db', 5432),
      ])
    )

    expect(lookalike.issues[0].reason).toBe('InvalidInternalDependency')
    expect(missingPort.issues[0].message).toContain('has no port')
    expect(stdio.issues[0].reason).toBe('OwnershipConflict')
  })
})
