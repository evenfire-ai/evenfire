/**
 * Creates Kubernetes Secrets for workflow coordinator authentication.
 *
 * The coordinator Pod receives two JWT tokens via a Secret mount:
 * - mcp-host-token: Coordinator → mcp_host (execute, mode_read, etc.)
 * - wrc-token: Coordinator → WRC
 *   - platform coordinator: configure_model + model_injection_request + status/signal scopes
 *   - custom coordinator: model_injection_request + status/signal scopes only
 * */
import * as k8s from '@kubernetes/client-node'
import { randomBytes } from 'node:crypto'
import { JwtTokenFactory } from './jwtTokenFactory'
import { pluginWorkloadSdkTokenSecretKey } from './pluginWorkloadSdkTokens'
import { buildPluginWorkloadSdkTokenSecretName } from './resourceNames'

/** Secret/Pod residue so a failed eager roll cannot leave a stale env JWT. */
export const MCP_HOST_RUNTIME_TOKEN_GENERATION_ANNOTATION =
  'clerum.io/mcp-host-runtime-token-generation'

export function readMcpHostRuntimeTokenGeneration(
  secret: { metadata?: { annotations?: Record<string, string> | null } | null } | undefined
): string | undefined {
  const raw = secret?.metadata?.annotations?.[MCP_HOST_RUNTIME_TOKEN_GENERATION_ANNOTATION]
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  return trimmed.length > 0 ? trimmed : undefined
}

export function nextMcpHostRuntimeTokenGeneration(current?: string): string {
  const parsed = Number(current)
  if (Number.isInteger(parsed) && parsed >= 1) return String(parsed + 1)
  return '1'
}

export function buildCoordinatorTokenSecret(
  recipeName: string,
  mcpHostToken: string | undefined,
  wrcToken: string,
  namespace: string,
  snippetRunnerToken?: string,
  gfsToken?: string
): k8s.V1Secret {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: `wf-${recipeName}-coordinator-token`,
      namespace,
      labels: {
        'clerum.io/recipe': recipeName,
        'clerum.io/managed-by': 'wrc',
        'clerum.io/component': 'coordinator-token',
      },
      // ownerRef intentionally omitted. Historically this Secret and the
      // WorkflowRecipe lived in different namespaces so ownerRefs were unsafe.
      // Now both live in sandbox-recipes and native GC *could* be wired back
      // up, but the explicit cleanup in finalizationHandler.reconcileDelete()
      // still handles Pods, PVCs, and NetworkPolicies that do not all share
      // the same parent — so adding the ownerRef here would
      // only cover half the cleanup surface. Left unchanged until a broader
      // ownership refactor is scheduled.
    },
    type: 'Opaque',
    data: {
      ...(mcpHostToken ? { 'mcp-host-token': Buffer.from(mcpHostToken).toString('base64') } : {}),
      'wrc-token': Buffer.from(wrcToken).toString('base64'),
      ...(snippetRunnerToken
        ? { 'snippet-runner-token': Buffer.from(snippetRunnerToken).toString('base64') }
        : {}),
    },
    ...(gfsToken ? { stringData: { 'gfs-token': gfsToken } } : {}),
  }
}

/**
 * Recipe-scoped Plugin Workload SDK token Secret (plan §3.6). Each allowed
 * caller workload gets its own key (`caller-<workloadId>`) so the SDK server
 * can derive caller identity from the bearer token instead of trusting a
 * client header. Rotation = delete the Secret; the next reconcile mints fresh
 * per-caller tokens.
 */
export function buildPluginWorkloadSdkTokenSecret(
  recipeName: string,
  tokensByCaller: Record<string, string>,
  namespace: string
): k8s.V1Secret {
  const data: Record<string, string> = {}
  for (const [callerRef, token] of Object.entries(tokensByCaller)) {
    data[pluginWorkloadSdkTokenSecretKey(callerRef)] = Buffer.from(token).toString('base64')
  }
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: buildPluginWorkloadSdkTokenSecretName(recipeName),
      namespace,
      labels: {
        'clerum.io/recipe': recipeName,
        'clerum.io/managed-by': 'wrc',
        'clerum.io/component': 'plugin-workload-sdk-token',
      },
    },
    type: 'Opaque',
    data,
  }
}

/**
 * Builds the mcpHost runtime token Secret for workflow mcp-host pods.
 *
 * Contains the access and refresh tokens used by the mcp-host to communicate
 * with the workflow-approval-gateway for user approval requests.
 *
 * Like other workflow Secrets, this does NOT use ownerReferences because the
 * WorkflowRecipe lives in a different namespace. Cleanup is handled explicitly
 * by finalizationHandler.reconcileDelete().
 */
export function buildMcpHostRuntimeTokenSecret(
  recipeName: string,
  accessToken: string,
  refreshToken: string,
  namespace: string,
  mcpHostControlToken?: string,
  gfsToken?: string
): k8s.V1Secret {
  const data: Record<string, string> = {
    'mcp-host-runtime-access-token': Buffer.from(accessToken).toString('base64'),
    'mcp-host-runtime-refresh-token': Buffer.from(refreshToken).toString('base64'),
  }
  if (mcpHostControlToken) {
    data['mcp-host-workflow-control-token'] = Buffer.from(mcpHostControlToken).toString('base64')
  }
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: `wf-${recipeName}-mcp-host-runtime-tokens`,
      namespace,
      labels: {
        'clerum.io/recipe': recipeName,
        'clerum.io/managed-by': 'wrc',
        'clerum.io/component': 'mcp-host-runtime-token',
      },
    },
    type: 'Opaque',
    data,
    ...(gfsToken ? { stringData: { 'mcp-host-gfs-token': gfsToken } } : {}),
  }
}

export async function createCoordinatorTokens(
  recipeName: string,
  tokenFactory: JwtTokenFactory,
  namespace: string,
  options: {
    includeMcpHostToken?: boolean
    useCustomCoordinatorWrcToken?: boolean
    includeSnippetRunnerToken?: boolean
    gfsToken?: string
  } = {}
): Promise<k8s.V1Secret> {
  const includeMcpHostToken = options.includeMcpHostToken ?? true
  const mcpHostToken = includeMcpHostToken
    ? await tokenFactory.signCoordinatorToMcpHostToken(recipeName, namespace)
    : undefined
  const wrcToken = options.useCustomCoordinatorWrcToken
    ? await tokenFactory.signCustomCoordinatorToWrcToken(recipeName, namespace)
    : await tokenFactory.signCoordinatorToWrcToken(recipeName, namespace)
  const snippetRunnerToken =
    options.includeSnippetRunnerToken === true ? randomBytes(32).toString('base64url') : undefined

  return buildCoordinatorTokenSecret(
    recipeName,
    mcpHostToken,
    wrcToken,
    namespace,
    snippetRunnerToken,
    options.gfsToken
  )
}
