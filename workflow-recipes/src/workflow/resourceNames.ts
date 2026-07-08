import { createHash } from 'node:crypto'

const MAX_SERVICE_NAME_LEN = 63
const MCP_HOST_SERVICE_PREFIX = 'wf-'
const MCP_HOST_SERVICE_SUFFIX = '-mcp-host'
const ARTIFACT_READER_SERVICE_SUFFIX = '-artifact-reader'
const SNIPPET_RUNNER_SERVICE_SUFFIX = '-snippet-runner'
const HASH_LEN = 8
const ROUTE_ALIAS_HASH_LEN = 16

function buildWorkflowServiceName(recipeName: string, suffix: string): string {
  const safeRecipeName =
    recipeName
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'workflow'
  const direct = `${MCP_HOST_SERVICE_PREFIX}${safeRecipeName}${suffix}`
  if (direct.length <= MAX_SERVICE_NAME_LEN) return direct

  const hash = createHash('sha256').update(recipeName).digest('hex').slice(0, HASH_LEN)
  const reservedLen = MCP_HOST_SERVICE_PREFIX.length + suffix.length + HASH_LEN + 1
  const maxStemLen = Math.max(1, MAX_SERVICE_NAME_LEN - reservedLen)
  const stem =
    safeRecipeName.slice(0, maxStemLen).replace(/-+$/g, '') || safeRecipeName.slice(0, maxStemLen)

  return `${MCP_HOST_SERVICE_PREFIX}${stem}-${hash}${suffix}`
}

export function buildMcpHostServiceName(recipeName: string): string {
  return buildWorkflowServiceName(recipeName, MCP_HOST_SERVICE_SUFFIX)
}

export function buildMcpHostUrl(recipeName: string, sandboxNamespace: string): string {
  return `http://${buildMcpHostServiceName(recipeName)}.${sandboxNamespace}.svc.cluster.local:8080`
}

export function buildMcpHostRouteAliasKey(recipeName: string, sandboxNamespace: string): string {
  return createHash('sha256')
    .update(`${sandboxNamespace}/${recipeName}`)
    .digest('hex')
    .slice(0, ROUTE_ALIAS_HASH_LEN)
}

export function buildMcpHostRouteAliasServiceName(
  recipeName: string,
  sandboxNamespace: string
): string {
  return `wf-${buildMcpHostRouteAliasKey(recipeName, sandboxNamespace)}-mcp-host`
}

export function buildMcpHostRouteAliasUrl(recipeName: string, sandboxNamespace: string): string {
  return `http://${buildMcpHostRouteAliasServiceName(recipeName, sandboxNamespace)}.${sandboxNamespace}.svc.cluster.local:8080`
}

/** Plugin Workload SDK server port on the recipe mcp-host (plan §3.2). */
export const PLUGIN_WORKLOAD_SDK_PORT = 8099

/** Legacy single-key data field retained for one-caller token migration. */
export const PLUGIN_WORKLOAD_SDK_LEGACY_TOKEN_DATA_KEY = 'plugin-workload-sdk-token'

/** Suffix for the K8s Secret metadata name (`wf-<recipe>-<suffix>`). */
export const PLUGIN_WORKLOAD_SDK_TOKEN_SECRET_SUFFIX = 'plugin-workload-sdk-token'

/** Name of the Secret carrying the recipe-scoped workload token. */
export function buildPluginWorkloadSdkTokenSecretName(recipeName: string): string {
  return `wf-${recipeName}-${PLUGIN_WORKLOAD_SDK_TOKEN_SECRET_SUFFIX}`
}

/** Endpoint plugin workloads use to reach the SDK server (plan §3.6). */
export function buildPluginWorkloadSdkEndpoint(
  recipeName: string,
  sandboxNamespace: string
): string {
  return `http://${buildMcpHostServiceName(recipeName)}.${sandboxNamespace}.svc.cluster.local:${PLUGIN_WORKLOAD_SDK_PORT}/sdk`
}

export function buildArtifactReaderServiceName(recipeName: string): string {
  return buildWorkflowServiceName(recipeName, ARTIFACT_READER_SERVICE_SUFFIX)
}

export function buildArtifactReaderUrl(recipeName: string, sandboxNamespace: string): string {
  return `http://${buildArtifactReaderServiceName(recipeName)}.${sandboxNamespace}.svc.cluster.local:8080`
}

export function buildSnippetRunnerServiceName(recipeName: string): string {
  return buildWorkflowServiceName(recipeName, SNIPPET_RUNNER_SERVICE_SUFFIX)
}

export function buildSnippetRunnerUrl(recipeName: string, sandboxNamespace: string): string {
  return `http://${buildSnippetRunnerServiceName(recipeName)}.${sandboxNamespace}.svc.cluster.local:8095`
}
