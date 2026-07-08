import { describe, expect, it, vi } from 'vitest'
import {
  COORDINATOR_ENV_PASSTHROUGH,
  MCP_HOST_ENV_PASSTHROUGH,
  SNIPPET_RUNNER_ENV_PASSTHROUGH,
  buildCoordinatorPod,
  buildMcpHostPod,
  buildPropagatedEnv,
  buildSnippetRunnerPod,
} from '../../../src/workflow/podFactory'
import { AgentSpec, WorkflowConfig } from '../../../src/workflow/types'

const config: WorkflowConfig = {
  coordinatorImage: 'clerum/workflow-coordinator:test',
  mcpHostImage: 'clerum/mcp-host:test',
  wrcEndpoint: 'http://wrc:8082',
  sandboxNamespace: 'sandbox-recipes',
  mcpServerNamespace: 'mcp-server',
  imagePullPolicy: 'IfNotPresent',
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
const agent: AgentSpec = { provider: 'zai', model: 'glm-4.7' }

describe('buildPropagatedEnv', () => {
  it('is empty when no allowlisted var is set', () => {
    expect(buildPropagatedEnv({}, ['CLERUM_MAX_STEP_TIMEOUT_SECONDS'])).toEqual([])
  })

  it('propagates a single allowlisted var with its value', () => {
    expect(
      buildPropagatedEnv({ CLERUM_MAX_STEP_TIMEOUT_SECONDS: '10800' }, [
        'CLERUM_MAX_STEP_TIMEOUT_SECONDS',
      ])
    ).toEqual([{ name: 'CLERUM_MAX_STEP_TIMEOUT_SECONDS', value: '10800' }])
  })

  it('skips empty string values (treats as unset)', () => {
    expect(
      buildPropagatedEnv({ CLERUM_MAX_STEP_TIMEOUT_SECONDS: '' }, [
        'CLERUM_MAX_STEP_TIMEOUT_SECONDS',
      ])
    ).toEqual([])
  })

  it('never leaks non-allowlisted vars (defense in depth)', () => {
    const fakeEnv = {
      CLERUM_MAX_STEP_TIMEOUT_SECONDS: '10800',
      GCP_SA_KEY: 'SHOULD-NEVER-LEAK',
      AWS_SECRET_ACCESS_KEY: 'SHOULD-NEVER-LEAK',
    }
    const out = buildPropagatedEnv(fakeEnv, ['CLERUM_MAX_STEP_TIMEOUT_SECONDS'])
    expect(out).toEqual([{ name: 'CLERUM_MAX_STEP_TIMEOUT_SECONDS', value: '10800' }])
    expect(JSON.stringify(out)).not.toContain('SHOULD-NEVER-LEAK')
  })

  it('MCP_HOST_ENV_PASSTHROUGH is frozen and lists reviewed runtime tuning vars only', () => {
    // Guard against silent widening of the allowlist — every addition needs
    // explicit review for secret-leak risk. Update this count when adding
    // a new entry on purpose.
    expect(Object.isFrozen(MCP_HOST_ENV_PASSTHROUGH)).toBe(true)
    expect(MCP_HOST_ENV_PASSTHROUGH).toEqual([
      'CLERUM_MAX_STEP_TIMEOUT_SECONDS',
      'CLERUM_MCP_TOOL_TIMEOUT_MS',
      'CLERUM_MCP_TOOL_MAX_TOTAL_TIMEOUT_MS',
      'MCP_HOST_WORKFLOW_MAX_OUTPUT_TOKENS',
    ])
  })

  it('SNIPPET_RUNNER_ENV_PASSTHROUGH is frozen and lists MCP timeout vars only', () => {
    expect(Object.isFrozen(SNIPPET_RUNNER_ENV_PASSTHROUGH)).toBe(true)
    expect(SNIPPET_RUNNER_ENV_PASSTHROUGH).toEqual([
      'CLERUM_MCP_TOOL_TIMEOUT_MS',
      'CLERUM_MCP_TOOL_MAX_TOTAL_TIMEOUT_MS',
    ])
  })

  it('COORDINATOR_ENV_PASSTHROUGH is frozen and lists runtime limit env vars only', () => {
    expect(Object.isFrozen(COORDINATOR_ENV_PASSTHROUGH)).toBe(true)
    expect(COORDINATOR_ENV_PASSTHROUGH).toEqual([
      'CLERUM_WORKFLOW_PREVIOUS_OUTPUT_PROMPT_MAX_CHARS',
      'MCP_HOST_STEP_TIMEOUT_SECONDS',
    ])
  })
})

describe('buildMcpHostPod env passthrough', () => {
  it('includes CLERUM_MAX_STEP_TIMEOUT_SECONDS in the pod spec when set', () => {
    vi.stubEnv('CLERUM_MAX_STEP_TIMEOUT_SECONDS', '10800')
    try {
      const pod = buildMcpHostPod(
        'r',
        agent,
        config,
        'r',
        'sandbox-recipes',
        'r-workflow-output',
        undefined,
        undefined,
        { mountWorkflowOutput: false }
      )
      const env = pod.spec!.containers![0].env!
      const match = env.find(e => e.name === 'CLERUM_MAX_STEP_TIMEOUT_SECONDS')
      expect(match).toBeDefined()
      expect(match!.value).toBe('10800')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('omits CLERUM_MAX_STEP_TIMEOUT_SECONDS when the WRC env has it unset', () => {
    vi.stubEnv('CLERUM_MAX_STEP_TIMEOUT_SECONDS', '')
    try {
      const pod = buildMcpHostPod(
        'r',
        agent,
        config,
        'r',
        'sandbox-recipes',
        'r-workflow-output',
        undefined,
        undefined,
        { mountWorkflowOutput: false }
      )
      const env = pod.spec!.containers![0].env!
      expect(env.find(e => e.name === 'CLERUM_MAX_STEP_TIMEOUT_SECONDS')).toBeUndefined()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('includes mcp-host max output tokens when configured on WRC', () => {
    vi.stubEnv('MCP_HOST_WORKFLOW_MAX_OUTPUT_TOKENS', '4096')
    try {
      const pod = buildMcpHostPod(
        'r',
        agent,
        config,
        'r',
        'sandbox-recipes',
        'r-workflow-output',
        undefined,
        undefined,
        { mountWorkflowOutput: false }
      )
      const env = pod.spec!.containers![0].env!
      expect(env.find(e => e.name === 'MCP_HOST_WORKFLOW_MAX_OUTPUT_TOKENS')?.value).toBe('4096')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('does not include coordinator-only runtime limit env vars', () => {
    vi.stubEnv('MCP_HOST_STEP_TIMEOUT_SECONDS', '300')
    try {
      const pod = buildMcpHostPod(
        'r',
        agent,
        config,
        'r',
        'sandbox-recipes',
        'r-workflow-output',
        undefined,
        undefined,
        { mountWorkflowOutput: false }
      )
      const envNames = pod.spec!.containers![0].env!.map(e => e.name)
      expect(envNames).not.toContain('MCP_HOST_STEP_TIMEOUT_SECONDS')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('buildSnippetRunnerPod env passthrough', () => {
  it('passes MCP timeout env only to snippet runner pods', () => {
    vi.stubEnv('CLERUM_MCP_TOOL_TIMEOUT_MS', '3600000')
    vi.stubEnv('CLERUM_MCP_TOOL_MAX_TOTAL_TIMEOUT_MS', '3600000')
    vi.stubEnv('MCP_HOST_RUNTIME_ACCESS_TOKEN', 'runtime-access-token')

    const pod = buildSnippetRunnerPod('r', config)
    const envNames = pod.spec!.containers![0].env!.map(e => e.name)

    expect(envNames).toContain('CLERUM_MCP_TOOL_TIMEOUT_MS')
    expect(envNames).toContain('CLERUM_MCP_TOOL_MAX_TOTAL_TIMEOUT_MS')
    expect(envNames).not.toContain('MCP_HOST_RUNTIME_ACCESS_TOKEN')
  })
})

describe('buildCoordinatorPod env passthrough', () => {
  it('includes mcp-host step timeout in the coordinator pod spec when set', () => {
    vi.stubEnv('MCP_HOST_STEP_TIMEOUT_SECONDS', '300')
    try {
      const pod = buildCoordinatorPod('r', config, { needsMcpHost: false })
      const env = pod.spec!.containers![0].env!
      expect(env.find(e => e.name === 'MCP_HOST_STEP_TIMEOUT_SECONDS')?.value).toBe('300')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('includes previous output prompt cap in the coordinator pod spec when set', () => {
    vi.stubEnv('CLERUM_WORKFLOW_PREVIOUS_OUTPUT_PROMPT_MAX_CHARS', '16384')
    try {
      const pod = buildCoordinatorPod('r', config, { needsMcpHost: false })
      const env = pod.spec!.containers![0].env!
      expect(
        env.find(e => e.name === 'CLERUM_WORKFLOW_PREVIOUS_OUTPUT_PROMPT_MAX_CHARS')?.value
      ).toBe('16384')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('does not pass broker runtime credentials into coordinator pods without mcp-host', () => {
    vi.stubEnv('MCP_HOST_RUNTIME_ACCESS_TOKEN', 'runtime-access-token')
    vi.stubEnv('MCP_HOST_RUNTIME_REFRESH_TOKEN', 'runtime-refresh-token')
    vi.stubEnv('MCP_HOST_WORKFLOW_CONTROL_TOKEN', 'runtime-control-token')
    vi.stubEnv('MCP_HOST_GATEWAY_URL', 'http://gateway.test')
    try {
      const pod = buildCoordinatorPod('r', config, { needsMcpHost: false })
      const envNames = pod.spec!.containers![0].env!.map(e => e.name)
      expect(envNames).not.toContain('MCP_HOST_RUNTIME_ACCESS_TOKEN')
      expect(envNames).not.toContain('MCP_HOST_RUNTIME_REFRESH_TOKEN')
      expect(envNames).not.toContain('MCP_HOST_WORKFLOW_CONTROL_TOKEN')
      expect(envNames).not.toContain('MCP_HOST_GATEWAY_URL')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
