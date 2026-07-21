/**
 * Pod specs for the two-pod model. Security invariants enforced on every pod:
 * automountServiceAccountToken=false, runAsNonRoot, readOnlyRootFilesystem,
 * drop ALL capabilities.
 */
import * as k8s from '@kubernetes/client-node'
import { createHash } from 'node:crypto'
import { privateWorkflowContextName } from '../reconciler/workflowContext'
import type { WorkflowRecipeGfsScope } from '../types'
import { truncateRfc1123WithHash } from './networkPolicyFactory'
import {
  PLUGIN_WORKLOAD_SDK_PORT,
  buildArtifactReaderServiceName,
  buildMcpHostRouteAliasServiceName,
  buildMcpHostServiceName,
  buildMcpHostUrl,
  buildPluginWorkloadSdkTokenSecretName,
  buildSnippetRunnerServiceName,
  buildSnippetRunnerUrl,
} from './resourceNames'
import {
  DEFAULT_CUSTOM_COORDINATOR_ACTIVE_DEADLINE_SECONDS,
  WORKFLOW_OUTPUT_PVC_NAME,
} from './runtimeConstants'
import { AgentSpec, WorkflowConfig } from './types'

/** Directory where the mcp-host mounts per-caller SDK bearer tokens (Secret volume). */
export const PLUGIN_WORKLOAD_SDK_WORKLOAD_TOKENS_DIR = '/var/run/clerum/plugin-workload-sdk/tokens'

/**
 * Allowlist of env vars forwarded from the WRC controller's process.env into
 * each spawned mcp-host pod. Explicit list prevents leaking arbitrary secrets.
 */
export const MCP_HOST_ENV_PASSTHROUGH: readonly string[] = Object.freeze([
  'CLERUM_MAX_STEP_TIMEOUT_SECONDS',
  'CLERUM_MCP_TOOL_TIMEOUT_MS',
  'CLERUM_MCP_TOOL_MAX_TOTAL_TIMEOUT_MS',
  'MCP_HOST_WORKFLOW_MAX_OUTPUT_TOKENS',
])

/**
 * Runtime limits forwarded from the WRC controller into spawned coordinator
 * pods. Keep this separate from mcp-host passthrough so approval gateway
 * credentials and broker-only settings cannot drift into coordinator-only runs.
 */
export const COORDINATOR_ENV_PASSTHROUGH: readonly string[] = Object.freeze([
  'CLERUM_WORKFLOW_PREVIOUS_OUTPUT_PROMPT_MAX_CHARS',
  'MCP_HOST_STEP_TIMEOUT_SECONDS',
])

/**
 * Allowlist for snippet-runner pods. Keep this narrower than coordinator and
 * mcp-host env propagation because snippets run user-authored code.
 */
export const SNIPPET_RUNNER_ENV_PASSTHROUGH: readonly string[] = Object.freeze([
  'CLERUM_MCP_TOOL_TIMEOUT_MS',
  'CLERUM_MCP_TOOL_MAX_TOTAL_TIMEOUT_MS',
])

export const WORKFLOW_TOKEN_VOLUME_NAME = 'workflow-tokens'
export const WORKFLOW_TOKEN_MOUNT_PATH = '/var/run/clerum/workflow-tokens'
export const WRC_TOKEN_FILE_PATH = `${WORKFLOW_TOKEN_MOUNT_PATH}/wrc-token`
export const MCP_HOST_TOKEN_FILE_PATH = `${WORKFLOW_TOKEN_MOUNT_PATH}/mcp-host-token`
export const SNIPPET_RUNNER_TOKEN_FILE_PATH = `${WORKFLOW_TOKEN_MOUNT_PATH}/snippet-runner-token`
export const GFS_TOKEN_FILE_PATH = WORKFLOW_TOKEN_MOUNT_PATH + '/gfs-token'
export const MCP_HOST_WORKFLOW_CONTROL_TOKEN_FILE_PATH = `${WORKFLOW_TOKEN_MOUNT_PATH}/mcp-host-workflow-control-token`
export const MCP_HOST_RUNTIME_AUTH_STATE_PATH = '/var/run/clerum/workflow-auth'
export const WORKFLOW_OUTPUT_AFFINITY_TOPOLOGY_KEY = 'kubernetes.io/hostname'
export const WORKFLOW_OUTPUT_CLAIM_LABEL = 'clerum.io/workflow-output-claim'
export const WORKFLOW_OUTPUT_SCOPE_LABEL = 'clerum.io/workflow-output-scope'
export const WORKFLOW_OUTPUT_ANCHOR_COMPONENT = 'workflow-output-anchor'
export const WORKFLOW_OUTPUT_PREPARE_COMPONENT = 'workflow-output-prepare'
export const WORKFLOW_OUTPUT_ROOT_MOUNT_PATH = '/workflow-output-root'

export type WorkflowOutputRuntimeComponent =
  | 'workflow-mcp-host'
  | 'workflow-coordinator'
  | 'workflow-artifact-reader'
  | 'workflow-snippet-runner'
  | typeof WORKFLOW_OUTPUT_ANCHOR_COMPONENT
  | typeof WORKFLOW_OUTPUT_PREPARE_COMPONENT

const WORKFLOW_OUTPUT_PREPARE_SCRIPT = `
const fs = require('fs');
const path = require('path');

const root = process.env.WORKFLOW_OUTPUT_ROOT;
const subPath = process.env.WORKFLOW_OUTPUT_SUB_PATH;
if (!root || !path.isAbsolute(root)) {
  throw new Error('WORKFLOW_OUTPUT_ROOT must be an absolute path');
}
if (!subPath || path.isAbsolute(subPath)) {
  throw new Error('WORKFLOW_OUTPUT_SUB_PATH must be a non-empty relative path');
}

const segments = subPath.split('/');
if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
  throw new Error('WORKFLOW_OUTPUT_SUB_PATH contains an unsafe segment');
}

let current = root;
for (const segment of segments) {
  current = path.join(current, segment);
  let stat;
  try {
    stat = fs.lstatSync(current);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      fs.mkdirSync(current, { mode: 0o770 });
      stat = fs.lstatSync(current);
    } else {
      throw error;
    }
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('workflow output path component is not a normal directory: ' + current);
  }
  // WRC-managed runtime pods mount /output as UID/GID 1000; the prepare pod
  // creates run-scoped directories for that contract before non-root pods start.
  fs.chownSync(current, 1000, 1000);
  fs.chmodSync(current, 0o770);
}
`

/**
 * Build an explicit, reviewable env subset from the WRC controller's
 * `process.env`. Undefined / empty values are skipped so the pod spec stays
 * minimal. Exported so callers (and unit tests) can inject a fake env map.
 */
export function buildPropagatedEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env,
  allowlist: readonly string[] = MCP_HOST_ENV_PASSTHROUGH
): k8s.V1EnvVar[] {
  const out: k8s.V1EnvVar[] = []
  for (const name of allowlist) {
    const value = sourceEnv[name]
    if (value !== undefined && value !== '') {
      out.push({ name, value })
    }
  }
  return out
}

function defaultWorkflowOutputSubPath(recipeName: string): string {
  return `workflow-output/${recipeName}`
}

function buildWorkflowTokenVolume(secretName: string): k8s.V1Volume {
  return {
    name: WORKFLOW_TOKEN_VOLUME_NAME,
    secret: {
      secretName,
      defaultMode: 0o440,
    },
  }
}

function buildWorkflowTokenVolumeMount(): k8s.V1VolumeMount {
  return {
    name: WORKFLOW_TOKEN_VOLUME_NAME,
    mountPath: WORKFLOW_TOKEN_MOUNT_PATH,
    readOnly: true,
  }
}

export function workflowOutputLabelValue(value: string): string {
  return truncateRfc1123WithHash(value.trim() || 'workflow-output')
}

function buildWorkflowOutputLabels(
  workflowOutputClaimName: string,
  workflowOutputScope: string
): Record<string, string> {
  return {
    [WORKFLOW_OUTPUT_CLAIM_LABEL]: workflowOutputLabelValue(workflowOutputClaimName),
    [WORKFLOW_OUTPUT_SCOPE_LABEL]: workflowOutputLabelValue(workflowOutputScope),
  }
}

function buildWorkflowOutputAffinity(workflowOutputClaimName: string): k8s.V1Affinity {
  return {
    podAffinity: {
      requiredDuringSchedulingIgnoredDuringExecution: [
        {
          labelSelector: {
            matchExpressions: [
              {
                key: WORKFLOW_OUTPUT_CLAIM_LABEL,
                operator: 'In',
                values: [workflowOutputLabelValue(workflowOutputClaimName)],
              },
              {
                key: 'clerum.io/component',
                operator: 'In',
                values: [WORKFLOW_OUTPUT_ANCHOR_COMPONENT],
              },
            ],
          },
          topologyKey: WORKFLOW_OUTPUT_AFFINITY_TOPOLOGY_KEY,
        },
      ],
    },
  }
}

export function buildWorkflowOutputAnchorPodName(runtimeScopeRecipeName: string): string {
  return truncateRfc1123WithHash(`${runtimeScopeRecipeName}-workflow-output-anchor`)
}

export function buildWorkflowOutputPreparePodName(recipeName: string): string {
  const suffix = '-workflow-output-prepare'
  const direct = `${recipeName}${suffix}`
  if (direct.length <= 63) return truncateRfc1123WithHash(direct)

  const hash = createHash('sha256').update(recipeName).digest('hex').slice(0, 8)
  const maxStemLength = 63 - suffix.length - hash.length - 1
  const stem = recipeName
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '')
    .slice(0, Math.max(1, maxStemLength))
    .replace(/-+$/g, '')
  return `${stem || 'workflow'}-${hash}${suffix}`
}

export interface WorkflowOutputAnchorPodOptions {
  workflowOutputClaimName: string
}

export function buildWorkflowOutputAnchorPod(
  runtimeScopeRecipeName: string,
  config: WorkflowConfig,
  options: WorkflowOutputAnchorPodOptions
): k8s.V1Pod {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: buildWorkflowOutputAnchorPodName(runtimeScopeRecipeName),
      namespace: config.sandboxNamespace,
      labels: {
        'clerum.io/recipe': runtimeScopeRecipeName,
        'clerum.io/component': WORKFLOW_OUTPUT_ANCHOR_COMPONENT,
        'clerum.io/managed-by': 'wrc',
        ...buildWorkflowOutputLabels(options.workflowOutputClaimName, runtimeScopeRecipeName),
      },
    },
    spec: {
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      // Keep the anchor self-healing. If its node disappears, new runs follow
      // the rescheduled anchor; already-running RWO consumers remain bound by
      // Kubernetes' requiredDuringSchedulingIgnoredDuringExecution semantics.
      restartPolicy: 'Always',
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
        seccompProfile: { type: 'RuntimeDefault' },
      },
      containers: [
        {
          name: 'workflow-output-anchor',
          image: config.artifactReaderImage ?? config.coordinatorImage,
          imagePullPolicy: config.imagePullPolicy,
          command: ['node', '-e', 'setInterval(() => {}, 1 << 30)'],
          securityContext: {
            readOnlyRootFilesystem: true,
            allowPrivilegeEscalation: false,
            capabilities: { drop: ['ALL'] },
          },
          volumeMounts: [{ name: 'recipe-output', mountPath: '/output-anchor' }],
          resources: {
            requests: { cpu: '5m', memory: '16Mi', 'ephemeral-storage': '8Mi' },
            limits: { cpu: '25m', memory: '64Mi', 'ephemeral-storage': '32Mi' },
          },
        },
      ],
      volumes: [
        {
          name: 'recipe-output',
          persistentVolumeClaim: { claimName: options.workflowOutputClaimName },
        },
      ],
    },
  }
}

export interface WorkflowOutputPreparePodOptions {
  workflowOutputClaimName: string
  workflowOutputSubPath: string
  workflowOutputScope: string
}

export function buildWorkflowOutputPreparePod(
  recipeName: string,
  config: WorkflowConfig,
  options: WorkflowOutputPreparePodOptions
): k8s.V1Pod {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: buildWorkflowOutputPreparePodName(recipeName),
      namespace: config.sandboxNamespace,
      labels: {
        'clerum.io/recipe': recipeName,
        'clerum.io/component': WORKFLOW_OUTPUT_PREPARE_COMPONENT,
        'clerum.io/managed-by': 'wrc',
        ...buildWorkflowOutputLabels(options.workflowOutputClaimName, options.workflowOutputScope),
      },
    },
    spec: {
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      hostNetwork: false,
      hostPID: false,
      hostIPC: false,
      affinity: buildWorkflowOutputAffinity(options.workflowOutputClaimName),
      restartPolicy: 'Never',
      activeDeadlineSeconds: 180,
      securityContext: {
        seccompProfile: { type: 'RuntimeDefault' },
      },
      containers: [
        {
          name: 'prepare-workflow-output',
          image: config.artifactReaderImage ?? config.coordinatorImage,
          imagePullPolicy: config.imagePullPolicy,
          command: ['node', '-e', WORKFLOW_OUTPUT_PREPARE_SCRIPT],
          env: [
            { name: 'WORKFLOW_OUTPUT_ROOT', value: WORKFLOW_OUTPUT_ROOT_MOUNT_PATH },
            { name: 'WORKFLOW_OUTPUT_SUB_PATH', value: options.workflowOutputSubPath },
          ],
          securityContext: {
            runAsUser: 0,
            runAsGroup: 0,
            runAsNonRoot: false,
            readOnlyRootFilesystem: true,
            allowPrivilegeEscalation: false,
            capabilities: { drop: ['ALL'], add: ['CHOWN', 'FOWNER', 'DAC_OVERRIDE'] },
          },
          volumeMounts: [{ name: 'recipe-output', mountPath: WORKFLOW_OUTPUT_ROOT_MOUNT_PATH }],
          resources: {
            requests: { cpu: '5m', memory: '16Mi', 'ephemeral-storage': '8Mi' },
            limits: { cpu: '50m', memory: '64Mi', 'ephemeral-storage': '32Mi' },
          },
        },
      ],
      volumes: [
        {
          name: 'recipe-output',
          persistentVolumeClaim: { claimName: options.workflowOutputClaimName },
        },
      ],
    },
  }
}

export interface CoordinatorPodOptions {
  needsMcpHost?: boolean
  needsSnippetRunner?: boolean
  needsGfsPublish?: boolean
  mountWorkflowOutput?: boolean
  coordinatorImageOverride?: string
  workflowOutputClaimName?: string
  workflowOutputSubPath?: string
  customCoordinator?: boolean
  activeDeadlineSeconds?: number
  workflowRunId?: string
  workflowTeamId?: string
  workflowUserId?: string
  workflowOutputScope?: string
}

export function buildCoordinatorPod(
  recipeName: string,
  config: WorkflowConfig,
  options: CoordinatorPodOptions = {}
): k8s.V1Pod {
  const needsMcpHost = options.needsMcpHost ?? false
  const needsSnippetRunner = options.needsSnippetRunner ?? false
  const needsGfsPublish = options.needsGfsPublish ?? false
  const image = options.coordinatorImageOverride ?? config.coordinatorImage
  const workflowOutputClaimName = options.workflowOutputClaimName ?? WORKFLOW_OUTPUT_PVC_NAME
  const workflowOutputScope = options.workflowOutputScope ?? recipeName
  const workflowOutputSubPath =
    options.workflowOutputSubPath ?? defaultWorkflowOutputSubPath(recipeName)
  const mcpHostEndpoint = buildMcpHostUrl(recipeName, config.sandboxNamespace)
  const snippetRunnerEndpoint = buildSnippetRunnerUrl(recipeName, config.sandboxNamespace)
  const outputMount: k8s.V1VolumeMount = {
    name: 'recipe-output',
    mountPath: '/output',
    ...(workflowOutputSubPath ? { subPath: workflowOutputSubPath } : {}),
  }
  const workflowOutputAffinity = options.mountWorkflowOutput
    ? buildWorkflowOutputAffinity(workflowOutputClaimName)
    : undefined

  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: `${recipeName}-coordinator`,
      namespace: config.sandboxNamespace,
      labels: {
        'clerum.io/recipe': recipeName,
        'clerum.io/component': 'workflow-coordinator',
        'clerum.io/coordinator-tier': options.customCoordinator ? 'custom' : 'builtin',
        'clerum.io/managed-by': 'wrc',
        ...(options.mountWorkflowOutput
          ? buildWorkflowOutputLabels(workflowOutputClaimName, workflowOutputScope)
          : {}),
      },
      // No ownerRef: workflow runtime cleanup is handled explicitly by the
      // WRC finalizer. The WorkflowRecipe CRD and this pod both live in
      // sandbox-recipes; transport-only children live separately in mcp-server.
    },
    spec: {
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      ...(workflowOutputAffinity ? { affinity: workflowOutputAffinity } : {}),
      ...(options.customCoordinator
        ? {
            hostNetwork: false,
            hostPID: false,
            hostIPC: false,
            activeDeadlineSeconds:
              options.activeDeadlineSeconds ?? DEFAULT_CUSTOM_COORDINATOR_ACTIVE_DEADLINE_SECONDS,
          }
        : {}),
      restartPolicy: 'Never',
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
        seccompProfile: { type: 'RuntimeDefault' },
      },
      containers: [
        {
          name: 'coordinator',
          image,
          imagePullPolicy: config.imagePullPolicy,
          ports: [{ name: 'http', containerPort: 8090 }],
          securityContext: {
            readOnlyRootFilesystem: true,
            allowPrivilegeEscalation: false,
            capabilities: { drop: ['ALL'] },
          },
          env: [
            { name: 'RECIPE_NAME', value: recipeName },
            { name: 'CLERUM_WORKFLOW_NAME', value: recipeName },
            ...(options.workflowRunId
              ? [
                  { name: 'CLERUM_WORKFLOW_RUN_ID', value: options.workflowRunId },
                  { name: 'CLERUM_CORRELATION_ID', value: options.workflowRunId },
                ]
              : []),
            ...(options.workflowTeamId
              ? [{ name: 'CLERUM_WORKFLOW_TEAM_ID', value: options.workflowTeamId }]
              : []),
            ...(options.workflowUserId
              ? [{ name: 'CLERUM_WORKFLOW_USER_ID', value: options.workflowUserId }]
              : []),
            { name: 'CLERUM_NAMESPACE', value: config.sandboxNamespace },
            { name: 'CLERUM_WRC_URL', value: config.wrcEndpoint },
            ...(needsMcpHost
              ? [
                  {
                    name: 'MCP_HOST_ENDPOINT',
                    value: mcpHostEndpoint,
                  },
                  {
                    name: 'CLERUM_MCPHOST_URL',
                    value: mcpHostEndpoint,
                  },
                  { name: 'MCP_HOST_TOKEN_FILE', value: MCP_HOST_TOKEN_FILE_PATH },
                ]
              : []),
            ...(needsSnippetRunner
              ? [
                  {
                    name: 'CLERUM_SNIPPET_RUNNER_URL',
                    value: snippetRunnerEndpoint,
                  },
                  { name: 'SNIPPET_RUNNER_TOKEN_FILE', value: SNIPPET_RUNNER_TOKEN_FILE_PATH },
                ]
              : []),
            ...(needsGfsPublish ? [{ name: 'GFS_ACCESS_FILE', value: GFS_TOKEN_FILE_PATH }] : []),
            { name: 'WORKFLOW_CONFIG_PATH', value: '/etc/workflow/config.json' },
            { name: 'SOUL_MD_PATH', value: '/etc/soul/SOUL.md' },
            { name: 'CLERUM_WORKFLOW_OUTPUT_DIR', value: '/output' },
            ...buildPropagatedEnv(process.env, COORDINATOR_ENV_PASSTHROUGH),
            { name: 'WRC_TOKEN_FILE', value: WRC_TOKEN_FILE_PATH },
          ],
          volumeMounts: [
            { name: 'workflow-config', mountPath: '/etc/workflow', readOnly: true },
            { name: 'soul-md', mountPath: '/etc/soul', readOnly: true },
            buildWorkflowTokenVolumeMount(),
            { name: 'tmp', mountPath: '/tmp' },
            ...(options.mountWorkflowOutput ? [outputMount] : []),
          ],
          resources: {
            requests: {
              cpu: '100m',
              memory: '128Mi',
              ...(options.customCoordinator ? { 'ephemeral-storage': '64Mi' } : {}),
            },
            limits: {
              cpu: '500m',
              memory: '512Mi',
              ...(options.customCoordinator ? { 'ephemeral-storage': '256Mi' } : {}),
            },
          },
          livenessProbe: {
            httpGet: { path: '/health', port: 8090 },
            initialDelaySeconds: options.customCoordinator ? 30 : 10,
            periodSeconds: 30,
          },
        },
      ],
      volumes: [
        { name: 'workflow-config', configMap: { name: `${recipeName}-workflow-config` } },
        { name: 'soul-md', configMap: { name: `wf-${recipeName}-soul-md` } },
        buildWorkflowTokenVolume(`wf-${recipeName}-coordinator-token`),
        { name: 'tmp', emptyDir: options.customCoordinator ? { sizeLimit: '64Mi' } : {} },
        ...(options.mountWorkflowOutput
          ? [
              {
                name: 'recipe-output',
                persistentVolumeClaim: { claimName: workflowOutputClaimName },
              },
            ]
          : []),
      ],
    },
  }
}

export interface McpHostPodOptions {
  /** Verified scopes derived from the WorkflowRecipe spec and used to mint the mounted GFS token. */
  gfsScopes?: readonly WorkflowRecipeGfsScope[]
  workflowOutputScope?: string
  mountWorkflowOutput: boolean
  /**
   * Plugin Workload SDK (plan §3.6): when true, the pod receives
   * PLUGIN_WORKLOAD_SDK_ENABLED + the recipe-scoped workload token so the
   * SDK server can start (subject to the triple activation gate inside
   * mcp-host). MCP_HOST_POD_NAMESPACE is injected unconditionally — the
   * downward API leg of the gate must exist even when the flag is off.
   */
  pluginWorkloadSdkEnabled?: boolean
}

export function buildMcpHostPod(
  recipeName: string,
  agent: AgentSpec,
  config: WorkflowConfig,
  approvalRecipeName: string | undefined,
  approvalRecipeNamespace: string | undefined,
  workflowOutputClaimName: string | undefined,
  workflowOutputSubPath: string | undefined,
  contextRef: string | undefined,
  options: McpHostPodOptions
): k8s.V1Pod {
  const mountWorkflowOutput = options.mountWorkflowOutput
  if (mountWorkflowOutput && !workflowOutputClaimName) {
    throw new Error('workflowOutputClaimName is required for workflow mcp-host pods')
  }
  const resolvedApprovalRecipeName = approvalRecipeName ?? recipeName
  const resolvedApprovalRecipeNamespace = approvalRecipeNamespace ?? config.sandboxNamespace
  const resolvedContextRef = contextRef ?? privateWorkflowContextName(recipeName)
  const workflowOutputScope = options.workflowOutputScope ?? resolvedApprovalRecipeName
  const resolvedWorkflowOutputSubPath =
    workflowOutputSubPath ?? defaultWorkflowOutputSubPath(recipeName)
  const workflowOutputAffinity =
    mountWorkflowOutput && workflowOutputClaimName
      ? buildWorkflowOutputAffinity(workflowOutputClaimName)
      : undefined
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: `${recipeName}-mcp-host`,
      namespace: config.sandboxNamespace,
      labels: {
        'clerum.io/recipe': recipeName,
        'clerum.io/component': 'workflow-mcp-host',
        'clerum.io/managed-by': 'wrc',
        ...(mountWorkflowOutput && workflowOutputClaimName
          ? buildWorkflowOutputLabels(workflowOutputClaimName, workflowOutputScope)
          : {}),
      },
      // No ownerRef: workflow runtime cleanup is handled explicitly by the
      // WRC finalizer. The WorkflowRecipe CRD and this pod both live in
      // sandbox-recipes; transport-only children live separately in mcp-server.
    },
    spec: {
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      ...(workflowOutputAffinity ? { affinity: workflowOutputAffinity } : {}),
      restartPolicy: 'Never',
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
        seccompProfile: { type: 'RuntimeDefault' },
      },
      containers: [
        {
          name: 'mcp-host',
          image: config.mcpHostImage,
          imagePullPolicy: config.imagePullPolicy,
          securityContext: {
            readOnlyRootFilesystem: true,
            allowPrivilegeEscalation: false,
            capabilities: { drop: ['ALL'] },
          },
          env: [
            { name: 'CLERUM_WORKFLOW_ENABLED', value: 'true' },
            { name: 'CLERUM_HOST_NAME', value: `${config.sandboxNamespace}/${recipeName}` },
            { name: 'CLERUM_WORKFLOW_RECIPE', value: recipeName },
            { name: 'CLERUM_WORKFLOW_NAMESPACE', value: config.sandboxNamespace },
            { name: 'CLERUM_WORKFLOW_APPROVAL_RECIPE', value: resolvedApprovalRecipeName },
            {
              name: 'CLERUM_WORKFLOW_APPROVAL_RECIPE_NAMESPACE',
              value: resolvedApprovalRecipeNamespace,
            },
            // Effective Context CRD: explicit contextRef when allowed, otherwise
            // the private wf-<recipe> Context derived by WRC.
            { name: 'CLERUM_CONTEXT_REF', value: resolvedContextRef },
            { name: 'PORT', value: '8080' },
            // Workflow auth: WRC signs tokens with iss=clerum-wrc, aud=mcp-host.
            // authMiddleware uses CLERUM_AUTH_JWT_PUBLIC_KEY + CLERUM_AUTH_JWT_ISSUER.
            // workflowRouter uses WRC_PUBLIC_KEY_PEM (same key, separate config).
            {
              name: 'CLERUM_AUTH_JWT_PUBLIC_KEY',
              valueFrom: {
                configMapKeyRef: {
                  name: 'clerum-wrc-public-key',
                  key: 'CLERUM_WRC_SIGNING_PUBLIC_KEY',
                },
              },
            },
            { name: 'CLERUM_AUTH_JWT_ISSUER', value: 'clerum-wrc' },
            { name: 'CLERUM_AUTH_JWT_AUDIENCE', value: 'mcp-host' },
            {
              name: 'WRC_PUBLIC_KEY_PEM',
              valueFrom: {
                configMapKeyRef: {
                  name: 'clerum-wrc-public-key',
                  key: 'CLERUM_WRC_SIGNING_PUBLIC_KEY',
                },
              },
            },
            { name: 'CLERUM_MODEL_PROVIDER', value: agent.provider },
            { name: 'CLERUM_MODEL', value: agent.model },
            // mcpHost runtime tokens — mcp-host uses these to call the approval gateway.
            // Coordinator does NOT get these env vars (least privilege).
            {
              name: 'MCP_HOST_RUNTIME_ACCESS_TOKEN',
              valueFrom: {
                secretKeyRef: {
                  name: `wf-${recipeName}-mcp-host-runtime-tokens`,
                  key: 'mcp-host-runtime-access-token',
                },
              },
            },
            {
              name: 'MCP_HOST_RUNTIME_REFRESH_TOKEN',
              valueFrom: {
                secretKeyRef: {
                  name: `wf-${recipeName}-mcp-host-runtime-tokens`,
                  key: 'mcp-host-runtime-refresh-token',
                },
              },
            },
            {
              name: 'MCP_HOST_GATEWAY_URL',
              value: 'http://nginx-workflow-approval-gateway.control-plane.svc.cluster.local:8092',
            },
            {
              name: 'MCP_HOST_WORKFLOW_CONTROL_TOKEN_FILE',
              value: MCP_HOST_WORKFLOW_CONTROL_TOKEN_FILE_PATH,
            },
            {
              name: 'MCP_HOST_RUNTIME_AUTH_STATE_DIR',
              value: MCP_HOST_RUNTIME_AUTH_STATE_PATH,
            },
            ...(options.gfsScopes && options.gfsScopes.length > 0
              ? [{ name: 'MCP_HOST_GFS_SCOPES', value: options.gfsScopes.join(',') }]
              : []),
            // Downward API namespace — defense-in-depth leg of the Plugin
            // Workload SDK triple activation gate. Always injected so a
            // misplaced Deployment fails the gate closed.
            {
              name: 'MCP_HOST_POD_NAMESPACE',
              valueFrom: { fieldRef: { fieldPath: 'metadata.namespace' } },
            },
            ...(options.pluginWorkloadSdkEnabled
              ? [
                  { name: 'PLUGIN_WORKLOAD_SDK_ENABLED', value: 'true' },
                  {
                    name: 'PLUGIN_WORKLOAD_SDK_WORKLOAD_TOKENS_DIR',
                    value: PLUGIN_WORKLOAD_SDK_WORKLOAD_TOKENS_DIR,
                  },
                ]
              : []),
            // API keys are delivered via POST /configure, not embedded here.
            //
            // Controller env passthrough (MCP_HOST_ENV_PASSTHROUGH allowlist).
            // Enables runtime tuning of mcp-host behavior (e.g. longer
            // per-step timeout ceilings) without rebuilding the image —
            // operators just `kubectl set env` on the WRC Deployment and
            // the next recipe-spawned mcp-host receives it.
            ...buildPropagatedEnv(),
          ],
          ports: [{ containerPort: 8080 }],
          volumeMounts: [
            buildWorkflowTokenVolumeMount(),
            { name: 'workflow-auth-state', mountPath: MCP_HOST_RUNTIME_AUTH_STATE_PATH },
            { name: 'tmp', mountPath: '/tmp' },
            ...(mountWorkflowOutput
              ? [
                  {
                    name: 'recipe-output',
                    mountPath: '/output',
                    ...(resolvedWorkflowOutputSubPath
                      ? { subPath: resolvedWorkflowOutputSubPath }
                      : {}),
                  },
                ]
              : []),
            ...(options.pluginWorkloadSdkEnabled
              ? [
                  {
                    name: 'plugin-workload-sdk-tokens',
                    mountPath: PLUGIN_WORKLOAD_SDK_WORKLOAD_TOKENS_DIR,
                    readOnly: true,
                  },
                ]
              : []),
          ],
          resources: {
            requests: { cpu: '200m', memory: '256Mi' },
            limits: { cpu: '2000m', memory: '2Gi' },
          },
          readinessProbe: {
            httpGet: { path: '/v1/runtime/health', port: 8080 },
            initialDelaySeconds: 5,
            periodSeconds: 10,
            failureThreshold: 6,
          },
          livenessProbe: {
            httpGet: { path: '/v1/runtime/health', port: 8080 },
            initialDelaySeconds: 15,
            periodSeconds: 30,
          },
        },
      ],
      volumes: [
        buildWorkflowTokenVolume(`wf-${recipeName}-mcp-host-runtime-tokens`),
        { name: 'workflow-auth-state', emptyDir: { sizeLimit: '16Mi' } },
        { name: 'tmp', emptyDir: {} },
        ...(mountWorkflowOutput
          ? [
              {
                name: 'recipe-output',
                // Workflow output PVC ownership is derived by WorkflowRuntimePlan:
                // WRC-managed claim by runtime scope or operator-owned external claim.
                persistentVolumeClaim: { claimName: workflowOutputClaimName! },
              },
            ]
          : []),
        ...(options.pluginWorkloadSdkEnabled
          ? [
              {
                name: 'plugin-workload-sdk-tokens',
                secret: { secretName: buildPluginWorkloadSdkTokenSecretName(recipeName) },
              },
            ]
          : []),
      ],
    },
  }
}

export function buildMcpHostHeadlessService(
  recipeName: string,
  sandboxNamespace: string
): k8s.V1Service {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: buildMcpHostServiceName(recipeName),
      namespace: sandboxNamespace,
      labels: {
        'clerum.io/component': 'workflow-mcp-host',
        'clerum.io/recipe': recipeName,
        'clerum.io/managed-by': 'wrc',
      },
      // No ownerRef: workflow runtime cleanup is handled explicitly by the
      // WRC finalizer. The WorkflowRecipe CRD and this service both live in
      // sandbox-recipes; transport-only children live separately in mcp-server.
    },
    spec: {
      clusterIP: 'None',
      selector: {
        'clerum.io/component': 'workflow-mcp-host',
        'clerum.io/recipe': recipeName,
      },
      ports: [
        {
          name: 'http',
          port: 8080,
          targetPort: 8080 as unknown as k8s.IntOrString,
          protocol: 'TCP',
        },
        // Plugin Workload SDK server (plan §3.6). Reachable only from
        // sandbox-recipes pods via NetworkPolicy; the mcp-host refuses to
        // start the listener unless the triple activation gate passes.
        {
          name: 'plugin-sdk',
          port: PLUGIN_WORKLOAD_SDK_PORT,
          targetPort: PLUGIN_WORKLOAD_SDK_PORT as unknown as k8s.IntOrString,
          protocol: 'TCP',
        },
      ],
    },
  }
}

export function buildMcpHostRouteAliasHeadlessService(
  recipeName: string,
  sandboxNamespace: string
): k8s.V1Service {
  const svc = buildMcpHostHeadlessService(recipeName, sandboxNamespace)
  return {
    ...svc,
    metadata: {
      ...svc.metadata,
      name: buildMcpHostRouteAliasServiceName(recipeName, sandboxNamespace),
      labels: {
        ...svc.metadata?.labels,
        'clerum.io/route-alias-for': buildMcpHostServiceName(recipeName),
      },
    },
  }
}

export interface ArtifactReaderPodOptions {
  workflowOutputClaimName?: string
  workflowOutputSubPath?: string
  workflowOutputScope?: string
}

export function buildArtifactReaderPod(
  recipeName: string,
  config: WorkflowConfig,
  options: ArtifactReaderPodOptions = {}
): k8s.V1Pod {
  const workflowOutputClaimName = options.workflowOutputClaimName ?? WORKFLOW_OUTPUT_PVC_NAME
  const workflowOutputScope = options.workflowOutputScope ?? recipeName
  const workflowOutputSubPath = Object.prototype.hasOwnProperty.call(
    options,
    'workflowOutputSubPath'
  )
    ? options.workflowOutputSubPath
    : defaultWorkflowOutputSubPath(recipeName)
  const workflowOutputAffinity = buildWorkflowOutputAffinity(workflowOutputClaimName)

  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: `${recipeName}-artifact-reader`,
      namespace: config.sandboxNamespace,
      labels: {
        'clerum.io/recipe': recipeName,
        'clerum.io/component': 'workflow-artifact-reader',
        'clerum.io/managed-by': 'wrc',
        ...buildWorkflowOutputLabels(workflowOutputClaimName, workflowOutputScope),
      },
    },
    spec: {
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      ...(workflowOutputAffinity ? { affinity: workflowOutputAffinity } : {}),
      restartPolicy: 'Always',
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
        seccompProfile: { type: 'RuntimeDefault' },
      },
      containers: [
        {
          name: 'artifact-reader',
          image: config.artifactReaderImage ?? config.coordinatorImage,
          imagePullPolicy: config.imagePullPolicy,
          command: ['node', 'dist/workflow/artifactReaderServer.js'],
          ports: [{ name: 'http', containerPort: 8080 }],
          securityContext: {
            readOnlyRootFilesystem: true,
            allowPrivilegeEscalation: false,
            capabilities: { drop: ['ALL'] },
          },
          env: [
            { name: 'PORT', value: '8080' },
            { name: 'CLERUM_WORKFLOW_RECIPE', value: recipeName },
            { name: 'CLERUM_WORKFLOW_NAMESPACE', value: config.sandboxNamespace },
            {
              name: 'WRC_PUBLIC_KEY_PEM',
              valueFrom: {
                configMapKeyRef: {
                  name: 'clerum-wrc-public-key',
                  key: 'CLERUM_WRC_SIGNING_PUBLIC_KEY',
                },
              },
            },
          ],
          volumeMounts: [
            { name: 'tmp', mountPath: '/tmp' },
            {
              name: 'recipe-output',
              mountPath: '/output',
              // Read/write is intentional: artifact-reader serves downloads but
              // also handles WRC-signed artifact_delete cleanup when run TTL
              // expires and the child recipe is deleted.
              ...(workflowOutputSubPath ? { subPath: workflowOutputSubPath } : {}),
            },
          ],
          resources: {
            requests: { cpu: '25m', memory: '64Mi', 'ephemeral-storage': '32Mi' },
            limits: { cpu: '100m', memory: '128Mi', 'ephemeral-storage': '64Mi' },
          },
          readinessProbe: {
            httpGet: { path: '/health', port: 8080 },
            initialDelaySeconds: 1,
            periodSeconds: 2,
            failureThreshold: 15,
          },
          livenessProbe: {
            httpGet: { path: '/health', port: 8080 },
            initialDelaySeconds: 10,
            periodSeconds: 30,
          },
        },
      ],
      volumes: [
        { name: 'tmp', emptyDir: { sizeLimit: '32Mi' } },
        {
          name: 'recipe-output',
          persistentVolumeClaim: { claimName: workflowOutputClaimName },
        },
      ],
    },
  }
}

export function buildArtifactReaderHeadlessService(
  recipeName: string,
  sandboxNamespace: string
): k8s.V1Service {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: buildArtifactReaderServiceName(recipeName),
      namespace: sandboxNamespace,
      labels: {
        'clerum.io/component': 'workflow-artifact-reader',
        'clerum.io/recipe': recipeName,
        'clerum.io/managed-by': 'wrc',
      },
    },
    spec: {
      clusterIP: 'None',
      selector: {
        'clerum.io/component': 'workflow-artifact-reader',
        'clerum.io/recipe': recipeName,
      },
      ports: [
        {
          port: 8080,
          targetPort: 8080 as unknown as k8s.IntOrString,
          protocol: 'TCP',
        },
      ],
    },
  }
}

export interface SnippetRunnerSecretAlias {
  alias: string
  secretName: string
  secretKey: string
}

export interface SnippetRunnerPodOptions {
  workflowOutputClaimName?: string
  workflowOutputSubPath?: string
  mountWorkflowOutput?: boolean
  secretAliases?: SnippetRunnerSecretAlias[]
  workflowOutputScope?: string
}

export function buildSnippetRunnerPod(
  recipeName: string,
  config: WorkflowConfig,
  options: SnippetRunnerPodOptions = {}
): k8s.V1Pod {
  const workflowOutputClaimName = options.workflowOutputClaimName ?? WORKFLOW_OUTPUT_PVC_NAME
  const workflowOutputScope = options.workflowOutputScope ?? recipeName
  const workflowOutputSubPath =
    options.workflowOutputSubPath ?? defaultWorkflowOutputSubPath(recipeName)
  const mountWorkflowOutput = options.mountWorkflowOutput ?? false
  const secretAliasEnv: k8s.V1EnvVar[] = (options.secretAliases ?? []).map(secret => ({
    name: `CLERUM_SNIPPET_SECRET_${secret.alias.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}`,
    valueFrom: {
      secretKeyRef: {
        name: secret.secretName,
        key: secret.secretKey,
      },
    },
  }))
  const workflowOutputAffinity = mountWorkflowOutput
    ? buildWorkflowOutputAffinity(workflowOutputClaimName)
    : undefined

  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: `${recipeName}-snippet-runner`,
      namespace: config.sandboxNamespace,
      labels: {
        'clerum.io/recipe': recipeName,
        'clerum.io/component': 'workflow-snippet-runner',
        'clerum.io/managed-by': 'wrc',
        ...(mountWorkflowOutput
          ? buildWorkflowOutputLabels(workflowOutputClaimName, workflowOutputScope)
          : {}),
      },
    },
    spec: {
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      ...(workflowOutputAffinity ? { affinity: workflowOutputAffinity } : {}),
      restartPolicy: 'Always',
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
        seccompProfile: { type: 'RuntimeDefault' },
      },
      containers: [
        {
          name: 'snippet-runner',
          image: config.snippetRunnerImage ?? config.coordinatorImage,
          imagePullPolicy: config.imagePullPolicy,
          command: ['node', 'dist/workflow/snippetRunnerServer.js'],
          ports: [{ name: 'http', containerPort: 8095 }],
          securityContext: {
            readOnlyRootFilesystem: true,
            allowPrivilegeEscalation: false,
            capabilities: { drop: ['ALL'] },
          },
          env: [
            { name: 'PORT', value: '8095' },
            { name: 'CLERUM_WORKFLOW_NAME', value: recipeName },
            { name: 'CLERUM_NAMESPACE', value: config.sandboxNamespace },
            { name: 'WORKFLOW_CONFIG_PATH', value: '/etc/workflow/config.json' },
            ...(mountWorkflowOutput
              ? [{ name: 'CLERUM_WORKFLOW_OUTPUT_DIR', value: '/output' }]
              : []),
            { name: 'SNIPPET_RUNNER_TOKEN_FILE', value: SNIPPET_RUNNER_TOKEN_FILE_PATH },
            ...buildPropagatedEnv(process.env, SNIPPET_RUNNER_ENV_PASSTHROUGH),
            ...secretAliasEnv,
          ],
          volumeMounts: [
            { name: 'workflow-config', mountPath: '/etc/workflow', readOnly: true },
            buildWorkflowTokenVolumeMount(),
            { name: 'tmp', mountPath: '/tmp' },
            ...(mountWorkflowOutput
              ? [
                  {
                    name: 'recipe-output',
                    mountPath: '/output',
                    ...(workflowOutputSubPath ? { subPath: workflowOutputSubPath } : {}),
                  },
                ]
              : []),
          ],
          resources: {
            requests: { cpu: '100m', memory: '128Mi', 'ephemeral-storage': '64Mi' },
            limits: { cpu: '500m', memory: '512Mi', 'ephemeral-storage': '256Mi' },
          },
          readinessProbe: {
            httpGet: { path: '/health', port: 8095 },
            initialDelaySeconds: 1,
            periodSeconds: 2,
            failureThreshold: 15,
          },
          livenessProbe: {
            httpGet: { path: '/health', port: 8095 },
            initialDelaySeconds: 10,
            periodSeconds: 30,
          },
        },
      ],
      volumes: [
        { name: 'tmp', emptyDir: { sizeLimit: '64Mi' } },
        { name: 'workflow-config', configMap: { name: `${recipeName}-workflow-config` } },
        buildWorkflowTokenVolume(`wf-${recipeName}-coordinator-token`),
        ...(mountWorkflowOutput
          ? [
              {
                name: 'recipe-output',
                persistentVolumeClaim: { claimName: workflowOutputClaimName },
              },
            ]
          : []),
      ],
    },
  }
}

export function buildSnippetRunnerHeadlessService(
  recipeName: string,
  sandboxNamespace: string
): k8s.V1Service {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: buildSnippetRunnerServiceName(recipeName),
      namespace: sandboxNamespace,
      labels: {
        'clerum.io/component': 'workflow-snippet-runner',
        'clerum.io/recipe': recipeName,
        'clerum.io/managed-by': 'wrc',
      },
    },
    spec: {
      clusterIP: 'None',
      selector: {
        'clerum.io/component': 'workflow-snippet-runner',
        'clerum.io/recipe': recipeName,
      },
      ports: [
        {
          port: 8095,
          targetPort: 8095 as unknown as k8s.IntOrString,
          protocol: 'TCP',
        },
      ],
    },
  }
}
