import { providerRequiresLlmSecret } from './llm'

export type WorkflowRecipeSecretRefUsage = {
  secretName: string
  namespace: string
  keys: Set<string>
}
export type WorkflowRecipeSecretRefMap = Map<string, WorkflowRecipeSecretRefUsage>

const DEFAULT_RECIPE_NAMESPACE = 'sandbox-recipes'
const DEFAULT_MCP_SERVER_NAMESPACE = 'mcp-server'
const DEFAULT_SANDBOX_UI_NAMESPACE = 'sandbox-ui'

function refMapKey(namespace: string, secretName: string) {
  return `${namespace}/${secretName}`
}

function resolveWorkloadSecretNamespace(
  spec: Record<string, unknown>,
  workload: Record<string, unknown>,
  namespaces: {
    recipeNamespace: string
    mcpServerNamespace: string
    sandboxUiNamespace: string
  }
) {
  if (workload.transport !== undefined && workload.transport !== null) {
    return namespaces.mcpServerNamespace
  }
  const ui = (spec.ui ?? {}) as Record<string, unknown>
  if (typeof ui.workloadRef === 'string' && ui.workloadRef && workload.id === ui.workloadRef) {
    return namespaces.sandboxUiNamespace
  }
  return namespaces.recipeNamespace
}

function addRef(
  refs: WorkflowRecipeSecretRefMap,
  secretName: unknown,
  secretKey: unknown,
  namespace: string
) {
  const name = typeof secretName === 'string' ? secretName.trim() : ''
  const key = typeof secretKey === 'string' ? secretKey.trim() : ''
  if (!name || !key) return
  const mapKey = refMapKey(namespace, name)
  if (!refs.has(mapKey)) refs.set(mapKey, { secretName: name, namespace, keys: new Set() })
  refs.get(mapKey)!.keys.add(key)
}

export function collectWorkflowRecipeSecretRefs(
  spec: Record<string, unknown>,
  namespaces = {
    recipeNamespace: DEFAULT_RECIPE_NAMESPACE,
    mcpServerNamespace: DEFAULT_MCP_SERVER_NAMESPACE,
    sandboxUiNamespace: DEFAULT_SANDBOX_UI_NAMESPACE,
  }
) {
  const refs: WorkflowRecipeSecretRefMap = new Map()

  // Keep in parity with control-api's WorkflowRecipe pending credential refs.
  // This powers the operator-facing Secrets UI after Marketplace/RecipeEditor installs.
  const workloads = Array.isArray(spec.workloads)
    ? (spec.workloads as Array<Record<string, unknown>>)
    : []
  for (const wl of workloads) {
    const envSecret = (wl.envSecret ?? {}) as Record<string, unknown>
    const keys = Array.isArray(envSecret.keys)
      ? (envSecret.keys as Array<Record<string, unknown>>)
      : []
    const namespace = resolveWorkloadSecretNamespace(spec, wl, namespaces)
    for (const k of keys) addRef(refs, envSecret.name, k.secretKey, namespace)
  }

  const steps = Array.isArray(spec.steps) ? (spec.steps as Array<Record<string, unknown>>) : []
  for (const step of steps) {
    const run = (step.run ?? {}) as Record<string, unknown>
    if (run.type !== 'snippet') continue
    const capabilities = (run.capabilities ?? {}) as Record<string, unknown>
    const entries = Array.isArray(capabilities.secrets)
      ? (capabilities.secrets as Array<Record<string, unknown>>)
      : []
    for (const entry of entries) {
      const secretRef = (entry.secretRef ?? {}) as Record<string, unknown>
      addRef(refs, secretRef.name, secretRef.key, namespaces.recipeNamespace)
    }
  }

  const oauthClients = Array.isArray(spec.oauthClients)
    ? (spec.oauthClients as Array<Record<string, unknown>>)
    : []
  for (const client of oauthClients) {
    for (const refField of ['clientIdRef', 'clientSecretRef'] as const) {
      const secretRef = (client[refField] ?? {}) as Record<string, unknown>
      addRef(refs, secretRef.name, secretRef.key, namespaces.recipeNamespace)
    }
  }

  // Agent LLM secrets are collected only for static-credentials providers.
  // Broker-backed agents (Codex) authenticate via tickets and must never
  // invent or surface an OAuth/LLM Secret from spec.agent.
  const agent = (spec.agent ?? {}) as Record<string, unknown>
  if (typeof agent.provider === 'string' && providerRequiresLlmSecret(agent.provider)) {
    const secretRef = (agent.secretRef ?? {}) as Record<string, unknown>
    addRef(refs, secretRef.name, secretRef.key, namespaces.recipeNamespace)
  }

  return refs
}

export function collectWorkflowRecipeSecretKeysForName(
  spec: Record<string, unknown>,
  secretName: string
) {
  const keys = new Set<string>()
  for (const ref of collectWorkflowRecipeSecretRefs(spec).values()) {
    if (ref.secretName === secretName) ref.keys.forEach(key => keys.add(key))
  }
  return keys
}
