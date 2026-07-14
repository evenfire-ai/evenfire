import { describe, expect, it } from 'vitest'
import type { WorkflowRecipeCRD, WorkloadDef } from '../types'
import { resolveWorkloadTemplates } from './workloadTemplates'

function makeRecipe(overrides: Partial<WorkflowRecipeCRD> = {}): WorkflowRecipeCRD {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: {
      name: 'qa-workflow',
      namespace: 'sandbox-recipes',
      uid: 'uid-qa-workflow',
      ...(overrides.metadata ?? {}),
    },
    spec: {
      workloads: [],
      ...(overrides.spec ?? {}),
    },
    status: overrides.status,
  }
}

function resolveFor(recipe: WorkflowRecipeCRD, workloads: WorkloadDef[]): void {
  resolveWorkloadTemplates({
    recipe,
    workloads,
    inputs: { db_name: 'clerum', mode: 'test' },
    computed: { db_url: 'postgres://postgres:5432/clerum' },
    resolveNamespace: workload => (workload.transport ? 'mcp-server' : 'sandbox-recipes'),
  })
}

describe('resolveWorkloadTemplates', () => {
  it('resolves classic workload host references with bare workload names', () => {
    const workloads: WorkloadDef[] = [
      { id: 'postgres', type: 'statefulset', image: 'postgres:16', port: 5432 },
      {
        id: 'api',
        type: 'deployment',
        image: 'api:test',
        env: [{ name: 'DATABASE_URL', value: 'postgres://{{postgres:host}}:{{postgres:port}}' }],
      },
    ]
    const recipe = makeRecipe({ spec: { workloads } })

    resolveFor(recipe, workloads)

    expect(workloads[1].env?.[0].value).toBe(
      'postgres://postgres.sandbox-recipes.svc.cluster.local:5432'
    )
  })

  it('resolves agentic workload references with assigned runtime names', () => {
    const workloads: WorkloadDef[] = [
      { id: 'postgres', type: 'statefulset', image: 'postgres:16', port: 5432 },
      {
        id: 'api',
        type: 'deployment',
        image: 'api:test',
        env: [{ name: 'DATABASE_URL', value: 'postgres://{{postgres:host}}/{{inputs.db_name}}' }],
        command: ['node'],
        args: ['--db-host={{postgres:host}}', '--mode={{inputs.mode}}'],
      },
    ]
    const recipe = makeRecipe({
      spec: { steps: [{ id: 'run', instruction: 'run' }], workloads },
      status: {
        phase: 'candidate',
        workloadInstances: {
          postgres: 'qa-workflow-postgres-abcd1234',
          api: 'qa-workflow-api-abcd1234',
        },
      },
    })

    resolveFor(recipe, workloads)

    const host = 'qa-workflow-postgres-abcd1234.sandbox-recipes.svc.cluster.local'
    expect(workloads[1].env?.[0].value).toBe(`postgres://${host}/clerum`)
    expect(workloads[1].command).toEqual(['node'])
    expect(workloads[1].args).toEqual([`--db-host=${host}`, '--mode=test'])
  })

  it('uses the assigned name instead of UID fallback when status exists', () => {
    const workloads: WorkloadDef[] = [
      { id: 'postgres', type: 'deployment', image: 'postgres:16', port: 5432 },
      {
        id: 'api',
        type: 'deployment',
        image: 'api:test',
        args: ['--host={{postgres:host}}'],
      },
    ]
    const recipe = makeRecipe({
      metadata: { name: 'qa-workflow', namespace: 'sandbox-recipes' },
      spec: { steps: [{ id: 'run', instruction: 'run' }], workloads },
      status: {
        phase: 'candidate',
        workloadInstances: { postgres: 'assigned-postgres-name' },
      },
    })

    resolveFor(recipe, workloads)

    expect(workloads[1].args).toEqual([
      '--host=assigned-postgres-name.sandbox-recipes.svc.cluster.local',
    ])
  })

  it('resolves computed values and transport workload namespaces', () => {
    const workloads: WorkloadDef[] = [
      {
        id: 'web-search',
        type: 'deployment',
        image: 'web-search:test',
        port: 3000,
        transport: { type: 'streamableHttp' },
      },
      {
        id: 'api',
        type: 'deployment',
        image: 'api:test',
        env: [
          { name: 'SEARCH_URL', value: 'http://{{web-search:host}}:{{web-search:port}}/mcp' },
          { name: 'DB_URL', value: '{{computed.db_url}}' },
        ],
      },
    ]
    const recipe = makeRecipe({ spec: { workloads } })

    resolveFor(recipe, workloads)

    expect(workloads[1].env?.[0].value).toBe(
      'http://web-search.mcp-server.svc.cluster.local:3000/mcp'
    )
    expect(workloads[1].env?.[1].value).toBe('postgres://postgres:5432/clerum')
  })

  it('resolves resource values from the recipe context', () => {
    const workloads: WorkloadDef[] = [
      {
        id: 'api',
        type: 'deployment',
        image: 'api:test',
        env: [{ name: 'LOG_LEVEL', value: '{{app-config:LOG_LEVEL}}' }],
        args: ['--feature={{app-config:FEATURE_FLAG}}'],
      },
    ]
    const recipe = makeRecipe({
      spec: {
        resources: [
          {
            id: 'app-config',
            type: 'configmap',
            data: { LOG_LEVEL: 'debug', FEATURE_FLAG: 'enabled' },
          },
        ],
        workloads,
      },
    })

    resolveFor(recipe, workloads)

    expect(workloads[0].env?.[0].value).toBe('debug')
    expect(workloads[0].args).toEqual(['--feature=enabled'])
  })

  it('reports missing computed references with the workload field path', () => {
    const workloads: WorkloadDef[] = [
      {
        id: 'api',
        type: 'deployment',
        image: 'api:test',
        env: [{ name: 'DATABASE_URL', value: '{{computed.missing}}' }],
      },
    ]
    const recipe = makeRecipe({ spec: { workloads } })

    expect(() => resolveFor(recipe, workloads)).toThrow(
      'spec.workloads[0].env[DATABASE_URL].value: Unresolved template reference: "computed.missing"'
    )
  })

  it('skips env entries without string value and does not serialize valueFrom objects', () => {
    const valueFrom = { secretKeyRef: { name: 'db-secret', key: 'url' } }
    const workloads: WorkloadDef[] = [
      { id: 'postgres', type: 'deployment', image: 'postgres:16', port: 5432 },
      {
        id: 'api',
        type: 'deployment',
        image: 'api:test',
        env: [{ name: 'DATABASE_URL', valueFrom } as never],
      },
    ]
    const recipe = makeRecipe({ spec: { workloads } })

    resolveFor(recipe, workloads)

    expect((workloads[1].env?.[0] as unknown as { valueFrom: unknown }).valueFrom).toBe(valueFrom)
    expect(JSON.stringify(workloads[1].env?.[0])).not.toContain('[object Object]')
  })

  it('adds the field path to unresolved template errors', () => {
    const workloads: WorkloadDef[] = [
      {
        id: 'api',
        type: 'deployment',
        image: 'api:test',
        args: ['--db-host={{missing:host}}'],
      },
    ]
    const recipe = makeRecipe({ spec: { workloads } })

    expect(() => resolveFor(recipe, workloads)).toThrow(
      'spec.workloads[0].args[0]: Unresolved template reference: "missing:host"'
    )
  })

  it('adds the field path to template injection errors', () => {
    const workloads: WorkloadDef[] = [
      {
        id: 'api',
        type: 'deployment',
        image: 'api:test',
        env: [{ name: 'ATTEMPT', value: '{{__proto__.x}}' }],
        args: ['--attempt={{__proto__.x}}'],
      },
    ]
    const recipe = makeRecipe({ spec: { workloads } })

    expect(() => resolveFor(recipe, workloads)).toThrow(
      'spec.workloads[0].env[ATTEMPT].value: Template injection blocked: "__proto__.x"'
    )

    workloads[0].env = []

    expect(() => resolveFor(recipe, workloads)).toThrow(
      'spec.workloads[0].args[0]: Template injection blocked: "__proto__.x"'
    )
  })

  it('reports workload host and port references as unresolved when the target workload has no port', () => {
    const workloads: WorkloadDef[] = [
      { id: 'worker', type: 'deployment', image: 'worker:test' },
      {
        id: 'api',
        type: 'deployment',
        image: 'api:test',
        env: [{ name: 'WORKER_HOST', value: '{{worker:host}}' }],
        args: ['--worker-port={{worker:port}}'],
      },
    ]
    const recipe = makeRecipe({ spec: { workloads } })

    expect(() => resolveFor(recipe, workloads)).toThrow(
      'spec.workloads[1].env[WORKER_HOST].value: Unresolved template reference: "worker:host"'
    )

    workloads[1].env = []

    expect(() => resolveFor(recipe, workloads)).toThrow(
      'spec.workloads[1].args[0]: Unresolved template reference: "worker:port"'
    )
  })
})
