import { describe, expect, it } from 'vitest'
import {
  MCP_HOST_RUNTIME_AUTH_STATE_PATH,
  MCP_HOST_WORKFLOW_CONTROL_TOKEN_FILE_PATH,
  WORKFLOW_TOKEN_MOUNT_PATH,
  buildCoordinatorPod,
  buildMcpHostPod,
} from '../../../src/workflow/podFactory'
import type { AgentSpec, WorkflowConfig } from '../../../src/workflow/types'

const mockConfig: WorkflowConfig = {
  coordinatorImage: 'clerum/workflow-coordinator:test',
  mcpHostImage: 'clerum/mcp-host:test',
  wrcEndpoint: 'http://wrc:8082',
  sandboxNamespace: 'sandbox-recipes',
  mcpServerNamespace: 'mcp-server',
  imagePullPolicy: 'Never',
  maxWorkflowSteps: 100,
  workflowMaxWorkloadsPerRecipe: 25,
  workflowUiEgressInternalMaxItems: 25,
  workflowMaxSteps: 100,
  workflowDefaultRunDurationSeconds: 3600,
  workflowMaxRunDurationSeconds: 86_400,
  runtimeTokenTtlSeconds: 900,
  runtimeTokenRefreshBeforeSeconds: 300,
  workflowStepDependsOnMaxItems: 100,
  workflowStepAllowedToolsMaxItems: 50,
  workflowStepMcpServersMaxItems: 20,
  workflowStatefulSetMaxReplicas: 20,
  workflowStatefulSetMaxVolumeClaimTemplates: 4,
  workflowStatefulSetMaxPvcPreflightChecks: 80,
}

const mockAgent: AgentSpec = {
  provider: 'openai',
  model: 'gpt-4',
}

describe('Pod Factory — mcpHost Runtime Env Vars', () => {
  const mcpHostPod = buildMcpHostPod(
    'test-recipe',
    mockAgent,
    mockConfig,
    'test-recipe',
    'sandbox-recipes',
    'test-recipe-workflow-output',
    undefined,
    undefined,
    { mountWorkflowOutput: false }
  )
  const coordinatorPod = buildCoordinatorPod('test-recipe', mockConfig)
  const retiredApprovalEnvPrefix = 'APPROVAL'
  const retiredAccessEnvName = `${retiredApprovalEnvPrefix}_ACCESS_TOKEN`
  const retiredRefreshEnvName = `${retiredApprovalEnvPrefix}_REFRESH_TOKEN`
  const workflowLimitEnvNames = [
    'CLERUM_WORKFLOW_MAX_WORKLOADS_PER_RECIPE',
    'CLERUM_WORKFLOW_UI_EGRESS_INTERNAL_MAX_ITEMS',
    'CLERUM_WORKFLOW_MAX_STEPS',
    'CLERUM_WORKFLOW_STEP_DEPENDS_ON_MAX_ITEMS',
    'CLERUM_WORKFLOW_STEP_ALLOWED_TOOLS_MAX_ITEMS',
    'CLERUM_WORKFLOW_STEP_MCP_SERVERS_MAX_ITEMS',
    'CLERUM_WORKFLOW_STATEFULSET_MAX_REPLICAS',
    'CLERUM_WORKFLOW_STATEFULSET_MAX_VOLUME_CLAIM_TEMPLATES',
  ]

  function envNames(pod: typeof mcpHostPod): string[] {
    return pod.spec!.containers![0].env!.map(e => e.name)
  }

  function envByName(pod: typeof mcpHostPod, name: string) {
    return pod.spec!.containers![0].env!.find(e => e.name === name)
  }

  it('mcp-host pod has MCP_HOST_RUNTIME_ACCESS_TOKEN env var', () => {
    const env = envByName(mcpHostPod, 'MCP_HOST_RUNTIME_ACCESS_TOKEN')
    expect(env).toBeDefined()
    expect(env!.valueFrom!.secretKeyRef!.name).toBe('wf-test-recipe-mcp-host-runtime-tokens')
    expect(env!.valueFrom!.secretKeyRef!.key).toBe('mcp-host-runtime-access-token')
  })

  it('mcp-host pod has MCP_HOST_RUNTIME_REFRESH_TOKEN env var', () => {
    const env = envByName(mcpHostPod, 'MCP_HOST_RUNTIME_REFRESH_TOKEN')
    expect(env).toBeDefined()
    expect(env!.valueFrom!.secretKeyRef!.name).toBe('wf-test-recipe-mcp-host-runtime-tokens')
    expect(env!.valueFrom!.secretKeyRef!.key).toBe('mcp-host-runtime-refresh-token')
  })

  it('mcp-host pod has MCP_HOST_GATEWAY_URL env var', () => {
    const container = mcpHostPod.spec!.containers![0]
    const env = container.env!.find(e => e.name === 'MCP_HOST_GATEWAY_URL')
    expect(env).toBeDefined()
    expect(env!.value).toBe(
      'http://nginx-workflow-approval-gateway.control-plane.svc.cluster.local:8092'
    )
  })

  it('mcp-host pod uses the WorkflowRecipe caller key as runtime edge host name', () => {
    const env = envByName(mcpHostPod, 'CLERUM_HOST_NAME')
    expect(env!.value).toBe('sandbox-recipes/test-recipe')
  })

  it('mcp-host pod has MCP_HOST_WORKFLOW_CONTROL_TOKEN_FILE env var', () => {
    const env = envByName(mcpHostPod, 'MCP_HOST_WORKFLOW_CONTROL_TOKEN_FILE')
    expect(env!.value).toBe(MCP_HOST_WORKFLOW_CONTROL_TOKEN_FILE_PATH)
    expect(envByName(mcpHostPod, 'MCP_HOST_WORKFLOW_CONTROL_TOKEN')).toBeUndefined()
  })

  it('mcp-host pod does not expose retired approval token env vars', () => {
    expect(envNames(mcpHostPod)).not.toContain(retiredAccessEnvName)
    expect(envNames(mcpHostPod)).not.toContain(retiredRefreshEnvName)
  })

  it('mcp-host runtime access/refresh env vars read from one scoped Secret', () => {
    const tokenEnvNames = ['MCP_HOST_RUNTIME_ACCESS_TOKEN', 'MCP_HOST_RUNTIME_REFRESH_TOKEN']
    const refs = tokenEnvNames.map(name => envByName(mcpHostPod, name)!.valueFrom!.secretKeyRef!)
    expect(refs.map(ref => ref.name)).toEqual([
      'wf-test-recipe-mcp-host-runtime-tokens',
      'wf-test-recipe-mcp-host-runtime-tokens',
    ])
    expect(refs.map(ref => ref.key)).toEqual([
      'mcp-host-runtime-access-token',
      'mcp-host-runtime-refresh-token',
    ])
  })

  it('mcp-host mounts workflow-control token as a full rotating Secret volume', () => {
    const container = mcpHostPod.spec!.containers![0]
    const mount = container.volumeMounts!.find(item => item.name === 'workflow-tokens')
    const volume = mcpHostPod.spec!.volumes!.find(item => item.name === 'workflow-tokens')
    expect(mount).toMatchObject({
      mountPath: WORKFLOW_TOKEN_MOUNT_PATH,
      readOnly: true,
    })
    expect(mount!.subPath).toBeUndefined()
    expect(volume!.secret).toMatchObject({
      secretName: 'wf-test-recipe-mcp-host-runtime-tokens',
      defaultMode: 0o440,
    })
  })

  it('mcp-host keeps refreshed runtime auth state outside /output', () => {
    const container = mcpHostPod.spec!.containers![0]
    const env = envByName(mcpHostPod, 'MCP_HOST_RUNTIME_AUTH_STATE_DIR')
    const mount = container.volumeMounts!.find(item => item.name === 'workflow-auth-state')
    const volume = mcpHostPod.spec!.volumes!.find(item => item.name === 'workflow-auth-state')
    expect(env!.value).toBe(MCP_HOST_RUNTIME_AUTH_STATE_PATH)
    expect(mount).toMatchObject({ mountPath: MCP_HOST_RUNTIME_AUTH_STATE_PATH })
    expect(volume!.emptyDir).toEqual({ sizeLimit: '16Mi' })
  })

  it('projects only the verified WorkflowRecipe GFS token scopes into the mcp-host pod', () => {
    const scopedPod = buildMcpHostPod(
      'test-child-run',
      mockAgent,
      mockConfig,
      'test-recipe',
      'sandbox-recipes',
      'test-recipe-workflow-output',
      undefined,
      undefined,
      { gfsScopes: ['gfs.read', 'gfs.write'], mountWorkflowOutput: false }
    )

    expect(envByName(scopedPod, 'MCP_HOST_GFS_SCOPES')?.value).toBe('gfs.read,gfs.write')
    expect(envByName(mcpHostPod, 'MCP_HOST_GFS_SCOPES')).toBeUndefined()
  })

  it('mcp-host pod exposes the logical approval recipe name', () => {
    const pod = buildMcpHostPod(
      'test-child-run',
      mockAgent,
      mockConfig,
      'test-recipe',
      'sandbox-recipes',
      'test-recipe-workflow-output',
      undefined,
      undefined,
      { mountWorkflowOutput: false }
    )
    const container = pod.spec!.containers![0]
    const env = container.env!.find(e => e.name === 'CLERUM_WORKFLOW_APPROVAL_RECIPE')
    expect(env).toBeDefined()
    expect(env!.value).toBe('test-recipe')
  })

  it('coordinator pod does NOT have MCP_HOST_RUNTIME_ACCESS_TOKEN', () => {
    const env = envByName(coordinatorPod, 'MCP_HOST_RUNTIME_ACCESS_TOKEN')
    expect(env).toBeUndefined()
  })

  it('coordinator pod does NOT have MCP_HOST_RUNTIME_REFRESH_TOKEN', () => {
    const env = envByName(coordinatorPod, 'MCP_HOST_RUNTIME_REFRESH_TOKEN')
    expect(env).toBeUndefined()
  })

  it('coordinator pod does NOT have MCP_HOST_GATEWAY_URL', () => {
    const container = coordinatorPod.spec!.containers![0]
    const env = container.env!.find(e => e.name === 'MCP_HOST_GATEWAY_URL')
    expect(env).toBeUndefined()
  })

  it('coordinator pod does NOT have MCP_HOST_WORKFLOW_CONTROL_TOKEN', () => {
    const env = envByName(coordinatorPod, 'MCP_HOST_WORKFLOW_CONTROL_TOKEN')
    expect(env).toBeUndefined()
  })

  it('coordinator pod does not expose retired approval token env vars', () => {
    expect(envNames(coordinatorPod)).not.toContain(retiredAccessEnvName)
    expect(envNames(coordinatorPod)).not.toContain(retiredRefreshEnvName)
  })

  it('does not forward WRC runtime limit env vars to child pods', () => {
    for (const name of workflowLimitEnvNames) {
      expect(envNames(coordinatorPod)).not.toContain(name)
      expect(envNames(mcpHostPod)).not.toContain(name)
    }
  })
})
