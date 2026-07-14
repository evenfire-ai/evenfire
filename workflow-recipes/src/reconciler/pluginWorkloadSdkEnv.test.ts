import { describe, expect, it } from 'vitest'
import type { WorkflowRecipeCRD, WorkloadDef } from '../types'
import { buildDeployment, buildPluginWorkloadSdkEnv } from './resourceBuilder'

const workload = (overrides: Partial<WorkloadDef> = {}): WorkloadDef =>
  ({
    id: 'api',
    type: 'deployment',
    image: 'api:1',
    ...overrides,
  }) as WorkloadDef

const recipe = (
  pluginWorkloadSdk?: WorkflowRecipeCRD['spec']['pluginWorkloadSdk'],
  overrides: Partial<WorkflowRecipeCRD['spec']> = {}
): WorkflowRecipeCRD => ({
  apiVersion: 'clerum.io/v1alpha1',
  kind: 'WorkflowRecipe',
  metadata: { name: 'sdk-recipe', namespace: 'sandbox-recipes', uid: 'uid-1' },
  spec: {
    workloads: [workload()],
    pluginWorkloadSdk,
    ...overrides,
  },
})

describe('buildPluginWorkloadSdkEnv (plan §3.6)', () => {
  it('returns nothing when the feature flag is off', () => {
    expect(buildPluginWorkloadSdkEnv(workload(), recipe({ promptBridge: {} }), false)).toEqual([])
  })

  it('returns nothing when the recipe does not declare the capability', () => {
    expect(buildPluginWorkloadSdkEnv(workload(), recipe(undefined), true)).toEqual([])
  })

  it('injects endpoint + token secret ref for an allowed workload', () => {
    const env = buildPluginWorkloadSdkEnv(workload(), recipe({ promptBridge: {} }), true)
    expect(env).toEqual([
      {
        name: 'PLUGIN_WORKLOAD_SDK_ENDPOINT',
        value: 'http://wf-sdk-recipe-mcp-host.sandbox-recipes.svc.cluster.local:8099/sdk',
      },
      {
        name: 'PLUGIN_WORKLOAD_SDK_TOKEN',
        valueFrom: {
          secretKeyRef: {
            name: 'wf-sdk-recipe-plugin-workload-sdk-token',
            key: 'caller-api',
          },
        },
      },
    ])
  })

  it('excludes MCP transport workloads (they live outside sandbox-recipes)', () => {
    const mcpWorkload = workload({
      transport: { type: 'streamableHttp' },
      port: 3000,
    } as Partial<WorkloadDef>)
    expect(buildPluginWorkloadSdkEnv(mcpWorkload, recipe({ promptBridge: {} }), true)).toEqual([])
  })

  it('excludes the sandbox UI workload', () => {
    const r = recipe(
      { promptBridge: {} },
      { ui: { workloadRef: 'api' } as WorkflowRecipeCRD['spec']['ui'] }
    )
    expect(buildPluginWorkloadSdkEnv(workload(), r, true)).toEqual([])
  })

  it('respects allowedCallers when declared', () => {
    const r = recipe({ promptBridge: {}, allowedCallers: ['worker'] })
    expect(buildPluginWorkloadSdkEnv(workload(), r, true)).toEqual([])
    const allowed = buildPluginWorkloadSdkEnv(workload({ id: 'worker' }), r, true)
    expect(allowed).toHaveLength(2)
  })

  it('treats empty allowedCallers as all declared workloads', () => {
    const r = recipe({ promptBridge: {}, allowedCallers: [] })
    expect(buildPluginWorkloadSdkEnv(workload(), r, true)).toHaveLength(2)
  })
})

describe('buildDeployment SDK env integration', () => {
  it('places the SDK env vars on the container when enabled', () => {
    const deployment = buildDeployment(
      workload() as never,
      recipe({ promptBridge: {} }),
      'minimal',
      undefined,
      { pluginWorkloadSdkEnabled: true }
    )
    const env = deployment.spec!.template.spec!.containers[0].env ?? []
    const names = env.map(e => e.name)
    expect(names).toContain('PLUGIN_WORKLOAD_SDK_ENDPOINT')
    expect(names).toContain('PLUGIN_WORKLOAD_SDK_TOKEN')
  })

  it('omits the SDK env vars without build options (default off)', () => {
    const deployment = buildDeployment(workload() as never, recipe({ promptBridge: {} }))
    const env = deployment.spec!.template.spec!.containers[0].env ?? []
    expect(env.map(e => e.name)).not.toContain('PLUGIN_WORKLOAD_SDK_ENDPOINT')
  })
})
