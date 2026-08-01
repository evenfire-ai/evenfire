import { describe, expect, it } from 'vitest'
import { privateWorkflowContextName } from '../../../src/reconciler/workflowContext'
import {
  MCP_HOST_TOKEN_FILE_PATH,
  SNIPPET_RUNNER_TOKEN_FILE_PATH,
  WORKFLOW_OUTPUT_AFFINITY_TOPOLOGY_KEY,
  WORKFLOW_OUTPUT_ANCHOR_COMPONENT,
  WORKFLOW_OUTPUT_CLAIM_LABEL,
  WORKFLOW_OUTPUT_PREPARE_COMPONENT,
  WORKFLOW_OUTPUT_ROOT_MOUNT_PATH,
  WORKFLOW_TOKEN_MOUNT_PATH,
  WRC_TOKEN_FILE_PATH,
  buildArtifactReaderHeadlessService,
  buildArtifactReaderPod,
  buildCoordinatorPod,
  buildMcpHostHeadlessService,
  buildMcpHostPod,
  buildSnippetRunnerHeadlessService,
  buildSnippetRunnerPod,
  buildWorkflowOutputAnchorPod,
  buildWorkflowOutputPreparePod,
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
  workflowDefaultRunDurationSeconds: 3600,
  workflowMaxRunDurationSeconds: 86_400,
  runtimeTokenTtlSeconds: 900,
  runtimeTokenRefreshBeforeSeconds: 300,
  workflowMaxWorkloadsPerRecipe: 25,
  workflowUiEgressInternalMaxItems: 25,
  workflowMaxSteps: 100,
  workflowStepDependsOnMaxItems: 100,
  workflowStepAllowedToolsMaxItems: 50,
  workflowStepMcpServersMaxItems: 20,
  workflowStatefulSetMaxReplicas: 20,
  workflowStatefulSetMaxVolumeClaimTemplates: 4,
  workflowStatefulSetMaxPvcPreflightChecks: 80,
}

const agent: AgentSpec = {
  model: 'gpt-4o',
  provider: 'openai',
}

function expectWorkflowOutputAnchorAffinity(
  pod: { spec?: { affinity?: any; nodeName?: string } },
  claimLabel = 'clerum-workflow-output'
): void {
  const required =
    pod.spec!.affinity!.podAffinity!.requiredDuringSchedulingIgnoredDuringExecution![0]

  expect(pod.spec!.nodeName).toBeUndefined()
  expect(required.topologyKey).toBe(WORKFLOW_OUTPUT_AFFINITY_TOPOLOGY_KEY)
  expect(required.labelSelector!.matchExpressions).toEqual([
    { key: WORKFLOW_OUTPUT_CLAIM_LABEL, operator: 'In', values: [claimLabel] },
    { key: 'clerum.io/component', operator: 'In', values: [WORKFLOW_OUTPUT_ANCHOR_COMPONENT] },
  ])
}

describe('Pod Factory', () => {
  describe('buildWorkflowOutputAnchorPod', () => {
    it('creates a hardened recipe-scoped anchor for RWO output placement', () => {
      const pod = buildWorkflowOutputAnchorPod('my-wf', config, {
        workflowOutputClaimName: 'my-wf-workflow-output',
      })

      expect(pod.metadata!.name).toBe('my-wf-workflow-output-anchor')
      expect(pod.metadata!.labels).toMatchObject({
        'clerum.io/recipe': 'my-wf',
        'clerum.io/component': WORKFLOW_OUTPUT_ANCHOR_COMPONENT,
        [WORKFLOW_OUTPUT_CLAIM_LABEL]: 'my-wf-workflow-output',
      })
      expect(pod.spec!.automountServiceAccountToken).toBe(false)
      expect(pod.spec!.enableServiceLinks).toBe(false)
      expect(pod.spec!.restartPolicy).toBe('Always')
      expect(pod.spec!.containers![0].volumeMounts).toContainEqual({
        name: 'recipe-output',
        mountPath: '/output-anchor',
      })
      expect(pod.spec!.volumes![0].persistentVolumeClaim!.claimName).toBe('my-wf-workflow-output')
    })
  })

  describe('buildWorkflowOutputPreparePod', () => {
    it('creates a one-shot pod that prepares only the run-scoped output path', () => {
      const pod = buildWorkflowOutputPreparePod('my-wf-run-123', config, {
        workflowOutputClaimName: 'my-wf-workflow-output',
        workflowOutputSubPath: 'workflow-output/my-wf/run-123',
        workflowOutputScope: 'my-wf',
      })
      const container = pod.spec!.containers![0]

      expect(pod.metadata!.name).toBe('my-wf-run-123-workflow-output-prepare')
      expect(pod.metadata!.labels).toMatchObject({
        'clerum.io/recipe': 'my-wf-run-123',
        'clerum.io/component': WORKFLOW_OUTPUT_PREPARE_COMPONENT,
        [WORKFLOW_OUTPUT_CLAIM_LABEL]: 'my-wf-workflow-output',
      })
      expect(pod.spec!.automountServiceAccountToken).toBe(false)
      expect(pod.spec!.enableServiceLinks).toBe(false)
      expect(pod.spec!.hostNetwork).toBe(false)
      expect(pod.spec!.hostPID).toBe(false)
      expect(pod.spec!.hostIPC).toBe(false)
      expect(pod.spec!.restartPolicy).toBe('Never')
      expect(pod.spec!.activeDeadlineSeconds).toBe(180)
      expect(pod.spec!.nodeName).toBeUndefined()
      expectWorkflowOutputAnchorAffinity(pod, 'my-wf-workflow-output')
      expect(container.command![0]).toBe('node')
      expect(container.env).toEqual(
        expect.arrayContaining([
          { name: 'WORKFLOW_OUTPUT_ROOT', value: WORKFLOW_OUTPUT_ROOT_MOUNT_PATH },
          { name: 'WORKFLOW_OUTPUT_SUB_PATH', value: 'workflow-output/my-wf/run-123' },
        ])
      )
      expect(container.volumeMounts).toEqual([
        { name: 'recipe-output', mountPath: WORKFLOW_OUTPUT_ROOT_MOUNT_PATH },
      ])
      expect(pod.spec!.volumes![0].persistentVolumeClaim!.claimName).toBe('my-wf-workflow-output')
    })

    it('keeps the privileged filesystem step isolated from workflow runtime pods', () => {
      const pod = buildWorkflowOutputPreparePod('my-wf-run-123', config, {
        workflowOutputClaimName: 'my-wf-workflow-output',
        workflowOutputSubPath: 'workflow-output/my-wf/run-123',
        workflowOutputScope: 'my-wf',
      })
      const security = pod.spec!.containers![0].securityContext!
      const script = pod.spec!.containers![0].command![2]

      expect(security).toMatchObject({
        runAsUser: 0,
        runAsGroup: 0,
        runAsNonRoot: false,
        readOnlyRootFilesystem: true,
        allowPrivilegeEscalation: false,
        capabilities: { drop: ['ALL'], add: ['CHOWN', 'FOWNER', 'DAC_OVERRIDE'] },
      })
      expect(script).toContain('path.isAbsolute(subPath)')
      expect(script).toContain("segment === '..'")
      expect(script).toContain('fs.lstatSync(current)')
      expect(script).toContain('stat.isSymbolicLink()')
    })
  })
  describe('buildCoordinatorPod', () => {
    const pod = buildCoordinatorPod('my-wf', config, { needsMcpHost: true })

    it('sets correct Pod name', () => {
      expect(pod.metadata!.name).toBe('my-wf-coordinator')
    })

    it('injects snippet runner endpoint and token only when snippets are needed', () => {
      const pod = buildCoordinatorPod('my-wf', config, {
        needsMcpHost: false,
        needsSnippetRunner: true,
      })
      const env = pod.spec!.containers![0].env!

      expect(env.find(e => e.name === 'CLERUM_SNIPPET_RUNNER_URL')?.value).toBe(
        'http://wf-my-wf-snippet-runner.sandbox-recipes.svc.cluster.local:8095'
      )
      expect(env.find(e => e.name === 'SNIPPET_RUNNER_TOKEN_FILE')?.value).toBe(
        SNIPPET_RUNNER_TOKEN_FILE_PATH
      )
      expect(env.find(e => e.name === 'SNIPPET_RUNNER_TOKEN')).toBeUndefined()
    })

    it('sets sandbox-recipes namespace', () => {
      expect(pod.metadata!.namespace).toBe('sandbox-recipes')
    })

    it('sets clerum.io/component label', () => {
      expect(pod.metadata!.labels!['clerum.io/component']).toBe('workflow-coordinator')
      expect(pod.metadata!.labels!['clerum.io/coordinator-tier']).toBe('builtin')
    })

    it('enforces I-02: automountServiceAccountToken false', () => {
      expect(pod.spec!.automountServiceAccountToken).toBe(false)
    })

    it('enforces I-07: runAsNonRoot', () => {
      expect(pod.spec!.securityContext!.runAsNonRoot).toBe(true)
    })

    it('enforces I-07: readOnlyRootFilesystem', () => {
      expect(pod.spec!.containers![0].securityContext!.readOnlyRootFilesystem).toBe(true)
    })

    it('enforces I-07: drop ALL capabilities', () => {
      expect(pod.spec!.containers![0].securityContext!.capabilities!.drop).toEqual(['ALL'])
    })

    it('sets restartPolicy: Never (WRC manages restart)', () => {
      expect(pod.spec!.restartPolicy).toBe('Never')
    })

    it('exposes the health and metrics HTTP port', () => {
      expect(pod.spec!.containers![0].ports).toEqual([{ name: 'http', containerPort: 8090 }])
    })

    it('mounts SOUL.md ConfigMap', () => {
      const vol = pod.spec!.volumes!.find(v => v.name === 'soul-md')
      expect(vol).toBeDefined()
      expect(vol!.configMap!.name).toBe('wf-my-wf-soul-md')
    })

    it('mounts workflow config ConfigMap', () => {
      const vol = pod.spec!.volumes!.find(v => v.name === 'workflow-config')
      expect(vol).toBeDefined()
      expect(vol!.configMap!.name).toBe('my-wf-workflow-config')
    })

    it('injects MCP_HOST_TOKEN_FILE for the mounted coordinator Secret', () => {
      const env = pod.spec!.containers![0].env!.find(e => e.name === 'MCP_HOST_TOKEN_FILE')
      expect(env!.value).toBe(MCP_HOST_TOKEN_FILE_PATH)
      expect(pod.spec!.containers![0].env!.find(e => e.name === 'MCP_HOST_TOKEN')).toBeUndefined()
    })

    it('defaults to no mcp-host endpoint unless the runtime plan opts in', () => {
      const defaultPod = buildCoordinatorPod('my-wf', config)
      const envNames = defaultPod.spec!.containers![0].env!.map(e => e.name)

      expect(envNames).not.toContain('MCP_HOST_ENDPOINT')
      expect(envNames).not.toContain('CLERUM_MCPHOST_URL')
      expect(envNames).not.toContain('MCP_HOST_TOKEN_FILE')
    })

    it('mounts coordinator runtime tokens as a full Secret volume', () => {
      const container = pod.spec!.containers![0]
      const env = container.env!.find(e => e.name === 'WRC_TOKEN_FILE')
      const mount = container.volumeMounts!.find(m => m.name === 'workflow-tokens')
      const volume = pod.spec!.volumes!.find(v => v.name === 'workflow-tokens')
      expect(env!.value).toBe(WRC_TOKEN_FILE_PATH)
      expect(container.env!.find(e => e.name === 'WRC_TOKEN')).toBeUndefined()
      expect(mount).toMatchObject({
        mountPath: WORKFLOW_TOKEN_MOUNT_PATH,
        readOnly: true,
      })
      expect(mount!.subPath).toBeUndefined()
      expect(volume!.secret).toMatchObject({
        secretName: 'wf-my-wf-coordinator-token',
        defaultMode: 0o440,
      })
    })

    it('uses a kube-safe mcp-host service URL for long recipe names', () => {
      const longRecipe = 'e2e-ondemand-approval-9ade863f-5368-4850-9016-510293e56f76'
      const longPod = buildCoordinatorPod(longRecipe, config, { needsMcpHost: true })
      const endpoint = longPod.spec!.containers![0].env!.find(e => e.name === 'MCP_HOST_ENDPOINT')

      expect(endpoint!.value).toMatch(
        /^http:\/\/wf-[a-z0-9-]+-mcp-host\.sandbox-recipes\.svc\.cluster\.local:8080$/
      )
      expect(endpoint!.value!.length).toBeLessThan(120)
    })

    it('can omit mcp-host endpoint and token for pure snippet workflows', () => {
      const snippetPod = buildCoordinatorPod('my-wf', config, { needsMcpHost: false })
      const envNames = snippetPod.spec!.containers![0].env!.map(e => e.name)

      expect(envNames).not.toContain('MCP_HOST_ENDPOINT')
      expect(envNames).not.toContain('MCP_HOST_TOKEN')
      expect(envNames).not.toContain('WRC_ENDPOINT')
      expect(envNames).toContain('WRC_TOKEN_FILE')
      expect(envNames).toContain('CLERUM_WORKFLOW_NAME')
      expect(envNames).toContain('CLERUM_WRC_URL')
    })

    it('binds the workflow run id and correlation id to the same coordinator value', () => {
      const runId = '00000000-0000-4000-8000-000000000001'
      const teamId = '11111111-1111-4111-8111-111111111111'
      const userId = '22222222-2222-4222-8222-222222222222'
      const runPod = buildCoordinatorPod('my-wf', config, {
        workflowRunId: runId,
        workflowTeamId: teamId,
        workflowUserId: userId,
      })
      const env = runPod.spec!.containers![0].env!
      const runIdEnv = env.find(e => e.name === 'CLERUM_WORKFLOW_RUN_ID')
      const correlationIdEnv = env.find(e => e.name === 'CLERUM_CORRELATION_ID')
      const teamEnv = runPod.spec!.containers![0].env!.find(
        e => e.name === 'CLERUM_WORKFLOW_TEAM_ID'
      )
      const userEnv = runPod.spec!.containers![0].env!.find(
        e => e.name === 'CLERUM_WORKFLOW_USER_ID'
      )

      expect(runIdEnv!.value).toBe(runId)
      expect(correlationIdEnv!.value).toBe(runId)
      expect(teamEnv!.value).toBe(teamId)
      expect(userEnv!.value).toBe(userId)
    })

    it('mounts workflow output PVC when workflow output is enabled', () => {
      const outputPod = buildCoordinatorPod('my-wf', config, {
        needsMcpHost: false,
        mountWorkflowOutput: true,
      })
      const mounts = outputPod.spec!.containers![0].volumeMounts!
      const outputMount = mounts.find(m => m.mountPath === '/output')
      const pvcVolume = outputPod.spec!.volumes!.find(v => v.name === 'recipe-output')

      expect(outputMount).toMatchObject({
        name: 'recipe-output',
        mountPath: '/output',
        subPath: 'workflow-output/my-wf',
      })
      expect(pvcVolume!.persistentVolumeClaim!.claimName).toBe('clerum-workflow-output')
      expectWorkflowOutputAnchorAffinity(outputPod)
    })

    it('co-locates workflow output pods with the recipe-scoped anchor by hostname', () => {
      const outputPod = buildCoordinatorPod('my-wf', config, {
        needsMcpHost: true,
        mountWorkflowOutput: true,
        workflowOutputClaimName: 'my-wf-workflow-output',
      })

      expectWorkflowOutputAnchorAffinity(outputPod, 'my-wf-workflow-output')
    })

    it('uses custom coordinator image and hardening options', () => {
      const customPod = buildCoordinatorPod('my-wf', config, {
        needsMcpHost: false,
        customCoordinator: true,
        coordinatorImageOverride: 'clerum/workflow-custom-sdk-e2e:test',
        mountWorkflowOutput: true,
        workflowOutputClaimName: 'my-wf-workflow-output',
      })
      const container = customPod.spec!.containers![0]
      const envNames = container.env!.map(e => e.name)
      const envByName = new Map(container.env!.map(e => [e.name, e]))
      const tmp = customPod.spec!.volumes!.find(v => v.name === 'tmp')
      const outputMount = container.volumeMounts!.find(m => m.mountPath === '/output')
      const forbiddenCustomCredentialEnv = [
        'MCP_HOST_TOKEN',
        'MCP_HOST_RUNTIME_ACCESS_TOKEN',
        'MCP_HOST_RUNTIME_REFRESH_TOKEN',
        'MCP_HOST_WORKFLOW_CONTROL_TOKEN',
        'MCP_HOST_GATEWAY_URL',
        'OPENAI_API_KEY',
        'ZAI_API_KEY',
        'BAILIAN_API_KEY',
        'CLAUDE_API_KEY',
        'CLERUM_MODEL_API_KEY',
      ]

      expect(container.image).toBe('clerum/workflow-custom-sdk-e2e:test')
      expect(customPod.metadata!.labels!['clerum.io/coordinator-tier']).toBe('custom')
      expect(customPod.spec!.enableServiceLinks).toBe(false)
      expect(customPod.spec!.hostNetwork).toBe(false)
      expect(customPod.spec!.hostPID).toBe(false)
      expect(customPod.spec!.hostIPC).toBe(false)
      expect(customPod.spec!.activeDeadlineSeconds).toBe(3300)
      expect(container.livenessProbe!.initialDelaySeconds).toBe(30)
      expect(tmp!.emptyDir).toEqual({ sizeLimit: '64Mi' })
      expect(container.resources!.requests!['ephemeral-storage']).toBe('64Mi')
      expect(container.resources!.limits!['ephemeral-storage']).toBe('256Mi')
      expect(envByName.get('WRC_TOKEN')).toBeUndefined()
      expect(envByName.get('WRC_TOKEN_FILE')?.value).toBe(WRC_TOKEN_FILE_PATH)
      for (const envName of forbiddenCustomCredentialEnv) {
        expect(envNames).not.toContain(envName)
      }
      expect(outputMount!.subPath).toBe('workflow-output/my-wf')
      expect(
        customPod.spec!.volumes!.find(v => v.name === 'recipe-output')!.persistentVolumeClaim!
          .claimName
      ).toBe('my-wf-workflow-output')
    })

    it('passes only scoped Secret-backed broker tokens to custom coordinators that need mcp-host', () => {
      const customBrokerPod = buildCoordinatorPod('my-wf', config, {
        customCoordinator: true,
        needsMcpHost: true,
        coordinatorImageOverride: 'clerum/workflow-custom-sdk-e2e:test',
      })
      const container = customBrokerPod.spec!.containers![0]
      const envNames = container.env!.map(e => e.name)
      const envByName = new Map(container.env!.map(e => [e.name, e]))
      const forbiddenCustomCredentialEnv = [
        'MCP_HOST_RUNTIME_ACCESS_TOKEN',
        'MCP_HOST_RUNTIME_REFRESH_TOKEN',
        'MCP_HOST_WORKFLOW_CONTROL_TOKEN',
        'MCP_HOST_GATEWAY_URL',
        'OPENAI_API_KEY',
        'ZAI_API_KEY',
        'BAILIAN_API_KEY',
        'CLAUDE_API_KEY',
        'CLERUM_MODEL_API_KEY',
      ]

      expect(customBrokerPod.metadata!.labels!['clerum.io/coordinator-tier']).toBe('custom')
      expect(envNames).toContain('CLERUM_MCPHOST_URL')
      expect(envByName.get('WRC_TOKEN')).toBeUndefined()
      expect(envByName.get('WRC_TOKEN_FILE')?.value).toBe(WRC_TOKEN_FILE_PATH)
      expect(envByName.get('MCP_HOST_TOKEN')).toBeUndefined()
      expect(envByName.get('MCP_HOST_TOKEN_FILE')?.value).toBe(MCP_HOST_TOKEN_FILE_PATH)
      for (const envName of forbiddenCustomCredentialEnv) {
        expect(envNames).not.toContain(envName)
      }
    })

    it('has NO ownerReference (cross-namespace GC safety)', () => {
      // Runtime cleanup is handled by the WRC finalizer; the pod itself lives
      // with the WorkflowRecipe in sandbox-recipes.
      expect(pod.metadata!.ownerReferences).toBeUndefined()
    })
  })

  describe('buildMcpHostPod Plugin SDK broker wiring', () => {
    it('injects the real WRC endpoint into the mcp-host', () => {
      const pod = buildMcpHostPod(
        'my-wf',
        agent,
        config,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { mountWorkflowOutput: false, pluginWorkloadSdkEnabled: true }
      )
      expect(pod.spec?.containers?.[0].env).toContainEqual({
        name: 'CLERUM_WRC_URL',
        value: 'http://wrc:8082',
      })
    })
  })

  describe('buildMcpHostPod', () => {
    const pod = buildMcpHostPod(
      'my-wf',
      agent,
      config,
      'my-wf',
      'sandbox-recipes',
      'my-wf-workflow-output',
      undefined,
      undefined,
      { mountWorkflowOutput: false }
    )

    it('sets correct Pod name', () => {
      expect(pod.metadata!.name).toBe('my-wf-mcp-host')
    })

    it('requires an explicit workflow output claim when output mounting is requested', () => {
      expect(() =>
        buildMcpHostPod(
          'my-wf',
          agent,
          config,
          'my-wf',
          'sandbox-recipes',
          undefined,
          undefined,
          undefined,
          { mountWorkflowOutput: true }
        )
      ).toThrow('workflowOutputClaimName is required')
    })

    it('sets CLERUM_WORKFLOW_ENABLED=true', () => {
      const env = pod.spec!.containers![0].env!.find(e => e.name === 'CLERUM_WORKFLOW_ENABLED')
      expect(env!.value).toBe('true')
    })

    it('binds workflow identity env used by mcp-host artifact JWT checks', () => {
      const env = pod.spec!.containers![0].env!
      expect(env.find(e => e.name === 'CLERUM_WORKFLOW_RECIPE')?.value).toBe('my-wf')
      expect(env.find(e => e.name === 'CLERUM_WORKFLOW_NAMESPACE')?.value).toBe('sandbox-recipes')
    })

    it('sets CLERUM_CONTEXT_REF to the private effective Context by default', () => {
      const env = pod.spec!.containers![0].env!
      expect(env.find(e => e.name === 'CLERUM_CONTEXT_REF')?.value).toBe(
        privateWorkflowContextName('my-wf')
      )
    })

    it('sets CLERUM_CONTEXT_REF from the caller-provided effective Context', () => {
      const contextPod = buildMcpHostPod(
        'my-wf',
        agent,
        config,
        'my-wf',
        'sandbox-recipes',
        'workflow-output',
        'my-wf',
        'context1',
        { mountWorkflowOutput: false }
      )

      const env = contextPod.spec!.containers![0].env!
      expect(env.find(e => e.name === 'CLERUM_CONTEXT_REF')?.value).toBe('context1')
    })

    it('sets model provider from agent spec', () => {
      const env = pod.spec!.containers![0].env!.find(e => e.name === 'CLERUM_MODEL_PROVIDER')
      expect(env!.value).toBe('openai')
    })

    it('enforces I-03: no API key in Pod spec', () => {
      const envNames = pod.spec!.containers![0].env!.map(e => e.name)
      expect(envNames).not.toContain('OPENAI_API_KEY')
      expect(envNames).not.toContain('CLAUDE_API_KEY')
      expect(envNames).not.toContain('CLERUM_MODEL_API_KEY')
    })

    it('enforces I-02: automountServiceAccountToken false', () => {
      expect(pod.spec!.automountServiceAccountToken).toBe(false)
    })

    it('exposes port 8080', () => {
      expect(pod.spec!.containers![0].ports![0].containerPort).toBe(8080)
    })

    it('has readiness probe on /v1/runtime/health (matches mcp-host server route)', () => {
      expect(pod.spec!.containers![0].readinessProbe!.httpGet!.path).toBe('/v1/runtime/health')
    })

    it('co-locates mcp-host with the recipe-scoped workflow output anchor', () => {
      const outputPod = buildMcpHostPod(
        'my-wf',
        agent,
        config,
        'my-wf',
        'sandbox-recipes',
        'my-wf-workflow-output',
        undefined,
        undefined,
        { mountWorkflowOutput: true }
      )

      expectWorkflowOutputAnchorAffinity(outputPod, 'my-wf-workflow-output')
    })

    it('does not pin the mcp-host pod to a fixed node name when mounting workflow output', () => {
      const pinnedPod = buildMcpHostPod(
        'my-wf',
        agent,
        config,
        'my-wf',
        'sandbox-recipes',
        'workflow-output',
        'my-wf',
        undefined,
        { mountWorkflowOutput: true }
      )

      expectWorkflowOutputAnchorAffinity(pinnedPod, 'workflow-output')
      // Guard against pod-name pinning via the downward API. The quoted form
      // matches the full JSON value so the legitimate fieldPath
      // "metadata.namespace" (Plugin Workload SDK activation gate) does not
      // false-positive on the "metadata.name" prefix.
      expect(JSON.stringify(pinnedPod)).not.toContain('"metadata.name"')
      expect(JSON.stringify(pinnedPod)).not.toContain('nodeName')
    })
  })

  describe('buildMcpHostHeadlessService', () => {
    const svc = buildMcpHostHeadlessService('my-wf', 'sandbox-recipes')

    it('sets clusterIP: None (headless)', () => {
      expect(svc.spec!.clusterIP).toBe('None')
    })

    it('names service with wf- prefix', () => {
      expect(svc.metadata!.name).toBe('wf-my-wf-mcp-host')
    })

    it('truncates long service names to satisfy the kubernetes 63-char limit', () => {
      const longSvc = buildMcpHostHeadlessService(
        'e2e-ondemand-simple-8b94b2cb-256d-45ec-ac90-2b76e4e555f0',
        'sandbox-recipes'
      )

      expect(longSvc.metadata!.name!.length).toBeLessThanOrEqual(63)
      expect(longSvc.metadata!.name).toMatch(/^wf-[a-z0-9-]+-mcp-host$/)
    })

    it('selects mcp-host component for recipe', () => {
      expect(svc.spec!.selector!['clerum.io/component']).toBe('workflow-mcp-host')
      expect(svc.spec!.selector!['clerum.io/recipe']).toBe('my-wf')
    })
  })

  describe('buildArtifactReaderPod', () => {
    const pod = buildArtifactReaderPod('my-wf', {
      ...config,
      artifactReaderImage: 'clerum/workflow-recipes:test',
    })

    it('uses a platform-controlled image and never the custom coordinator image', () => {
      expect(pod.metadata!.name).toBe('my-wf-artifact-reader')
      expect(pod.spec!.containers![0].image).toBe('clerum/workflow-recipes:test')
      expect(pod.spec!.containers![0].command).toEqual([
        'node',
        'dist/workflow/artifactReaderServer.js',
      ])
      expect(pod.spec!.containers![0].readinessProbe).toMatchObject({
        httpGet: { path: '/health', port: 8080 },
        initialDelaySeconds: 1,
        periodSeconds: 2,
      })
    })

    it('mounts only the run output subPath for read and WRC-authorized cleanup', () => {
      const outputMount = pod.spec!.containers![0].volumeMounts!.find(
        m => m.mountPath === '/output'
      )
      const outputVolume = pod.spec!.volumes!.find(v => v.name === 'recipe-output')

      expect(outputMount).toMatchObject({
        name: 'recipe-output',
        mountPath: '/output',
        subPath: 'workflow-output/my-wf',
      })
      expect(outputMount).not.toHaveProperty('readOnly')
      expect(outputVolume!.persistentVolumeClaim!.claimName).toBe('clerum-workflow-output')
    })

    it('uses the supplied run-scoped subPath for dedicated workflow output PVCs', () => {
      const dedicatedPod = buildArtifactReaderPod(
        'my-wf',
        {
          ...config,
          artifactReaderImage: 'clerum/workflow-recipes:test',
        },
        {
          workflowOutputClaimName: 'my-wf-workflow-output',
          workflowOutputSubPath: 'workflow-output/my-wf/run-123',
        }
      )
      const outputMount = dedicatedPod.spec!.containers![0].volumeMounts!.find(
        m => m.mountPath === '/output'
      )

      expect(outputMount).toMatchObject({
        name: 'recipe-output',
        mountPath: '/output',
        subPath: 'workflow-output/my-wf/run-123',
      })
      expect(outputMount).not.toHaveProperty('readOnly')
    })

    it('co-locates with mcp-host by hostname when sharing workflow output', () => {
      const dedicatedPod = buildArtifactReaderPod(
        'my-wf',
        {
          ...config,
          artifactReaderImage: 'clerum/workflow-recipes:test',
        },
        {
          workflowOutputClaimName: 'my-wf-workflow-output',
          workflowOutputSubPath: 'workflow-output/my-wf/run-123',
        }
      )

      expectWorkflowOutputAnchorAffinity(dedicatedPod, 'my-wf-workflow-output')
      expect(
        dedicatedPod.spec!.affinity!.podAffinity!.requiredDuringSchedulingIgnoredDuringExecution![0]
          .labelSelector!.matchExpressions
      ).toContainEqual({
        key: 'clerum.io/component',
        operator: 'In',
        values: [WORKFLOW_OUTPUT_ANCHOR_COMPONENT],
      })
    })

    it('uses restricted pod security and no service account token', () => {
      const container = pod.spec!.containers![0]
      const envByName = new Map(container.env!.map(env => [env.name, env]))

      expect(pod.spec!.automountServiceAccountToken).toBe(false)
      expect(pod.spec!.enableServiceLinks).toBe(false)
      expect(pod.spec!.securityContext).toMatchObject({
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        seccompProfile: { type: 'RuntimeDefault' },
      })
      expect(container.securityContext).toMatchObject({
        readOnlyRootFilesystem: true,
        allowPrivilegeEscalation: false,
        capabilities: { drop: ['ALL'] },
      })
      expect(envByName.get('CLERUM_WORKFLOW_RECIPE')?.value).toBe('my-wf')
      expect(envByName.get('CLERUM_WORKFLOW_NAMESPACE')?.value).toBe('sandbox-recipes')
      expect(container.env!.map(env => env.name)).not.toContain('MCP_HOST_TOKEN')
      expect(container.env!.map(env => env.name)).not.toContain('WRC_TOKEN')
    })
  })

  describe('buildArtifactReaderHeadlessService', () => {
    const svc = buildArtifactReaderHeadlessService('my-wf', 'sandbox-recipes')

    it('targets only the artifact-reader pod for the exact recipe', () => {
      expect(svc.metadata!.name).toBe('wf-my-wf-artifact-reader')
      expect(svc.spec!.clusterIP).toBe('None')
      expect(svc.spec!.selector).toEqual({
        'clerum.io/component': 'workflow-artifact-reader',
        'clerum.io/recipe': 'my-wf',
      })
      expect(svc.spec!.ports![0].port).toBe(8080)
    })
  })

  describe('buildSnippetRunnerPod', () => {
    const pod = buildSnippetRunnerPod(
      'my-wf',
      { ...config, snippetRunnerImage: 'clerum/workflow-snippet-runner:test' },
      {
        secretAliases: [{ alias: 'api_key', secretName: 'api-secret', secretKey: 'key' }],
        mountWorkflowOutput: true,
      }
    )
    const container = pod.spec!.containers![0]

    it('uses the platform-owned snippet runner image and hardens the pod', () => {
      expect(container.image).toBe('clerum/workflow-snippet-runner:test')
      expect(pod.spec!.automountServiceAccountToken).toBe(false)
      expect(pod.spec!.enableServiceLinks).toBe(false)
      expect(container.securityContext!.readOnlyRootFilesystem).toBe(true)
      expect(container.securityContext!.allowPrivilegeEscalation).toBe(false)
      expect(container.securityContext!.capabilities!.drop).toEqual(['ALL'])
    })

    it('mounts workflow config read-only and workflow output for artifacts', () => {
      expect(container.env!.find(e => e.name === 'WORKFLOW_CONFIG_PATH')?.value).toBe(
        '/etc/workflow/config.json'
      )
      expect(container.volumeMounts!.find(m => m.name === 'workflow-config')).toMatchObject({
        mountPath: '/etc/workflow',
        readOnly: true,
      })
      expect(pod.spec!.volumes!.find(v => v.name === 'workflow-config')!.configMap!.name).toBe(
        'my-wf-workflow-config'
      )
      expect(container.volumeMounts!.find(m => m.mountPath === '/output')!.subPath).toBe(
        'workflow-output/my-wf'
      )
    })

    it('co-locates with existing workflow output anchors by hostname', () => {
      const affinityPod = buildSnippetRunnerPod(
        'my-wf',
        { ...config, snippetRunnerImage: 'clerum/workflow-snippet-runner:test' },
        {
          workflowOutputClaimName: 'my-wf-workflow-output',
          mountWorkflowOutput: true,
        }
      )

      expectWorkflowOutputAnchorAffinity(affinityPod, 'my-wf-workflow-output')
    })

    it('injects only declared snippet secret aliases', () => {
      expect(
        container.env!.find(e => e.name === 'CLERUM_SNIPPET_SECRET_API_KEY')?.valueFrom
          ?.secretKeyRef
      ).toEqual({
        name: 'api-secret',
        key: 'key',
      })
    })

    it('creates a headless service on the snippet runner port', () => {
      const service = buildSnippetRunnerHeadlessService('my-wf', 'sandbox-recipes')
      expect(service.spec!.clusterIP).toBe('None')
      expect(service.spec!.selector!['clerum.io/component']).toBe('workflow-snippet-runner')
      expect(service.spec!.ports![0].port).toBe(8095)
    })
  })
})
