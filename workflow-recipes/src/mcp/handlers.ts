/**
 * MCP Tool handlers — wire MCP tools to the reconciler.
 *
 * Each handler receives validated args + provider + identity headers.
 * Returns MCP-format response: { content: [{ type: "text", text }] }
 *
 * Source of truth: PHASE-4-MCP-SERVER-INTERFACE.md §4.2–4.4
 */
import * as k8s from '@kubernetes/client-node'
import { WorkflowRecipeProvider } from '../k8sClient'
import { getErrorCode } from '../reconciler/k8sErrors'
import { listWorkflowRecipePolicies } from '../reconciler/policyClient'
import { searchEntries } from '../registry/clerumRegistryClient.js'

// ─── Identity Headers ──────────────────────────────────────────────────

export interface CallerIdentity {
  agentId: string
  contextRef: string
}

export interface McpTextContent {
  [key: string]: unknown
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

/**
 * Validate identity headers from the MCP request.
 * Returns CallerIdentity or an MCP error response.
 */
export function validateHeaders(
  headers: Record<string, string | undefined>
): { identity: CallerIdentity } | { error: McpTextContent } {
  const agentId = headers['x-clerum-agent-id']
  const contextRef = headers['x-clerum-context-ref']

  if (!agentId) {
    return {
      error: {
        content: [
          { type: 'text', text: JSON.stringify({ error: 'Missing X-Clerum-Agent-Id header' }) },
        ],
        isError: true,
      },
    }
  }

  if (!contextRef) {
    return {
      error: {
        content: [
          { type: 'text', text: JSON.stringify({ error: 'Missing X-Clerum-Context-Ref header' }) },
        ],
        isError: true,
      },
    }
  }

  return { identity: { agentId, contextRef } }
}

// ─── MCP Response Helpers ──────────────────────────────────────────────

function ok(data: unknown): McpTextContent {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] }
}

function fail(message: string): McpTextContent {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true }
}

// ─── Tool Handlers ─────────────────────────────────────────────────────

export function handleListRecipes(
  args: { status_filter?: string },
  provider: WorkflowRecipeProvider
): McpTextContent {
  let recipes = provider.getAllRecipes()

  if (args.status_filter) {
    recipes = recipes.filter(r => r.status?.phase === args.status_filter)
  }

  return ok(
    recipes.map(r => ({
      name: r.metadata.name,
      namespace: r.metadata.namespace,
      phase: r.status?.phase ?? 'candidate',
      workloadCount: (r.spec.workloads ?? []).length,
    }))
  )
}

export function handleGetRecipeStatus(
  args: { name: string },
  provider: WorkflowRecipeProvider
): McpTextContent {
  const recipe = provider.getAllRecipes().find(r => r.metadata.name === args.name)
  if (!recipe) {
    return fail(`Recipe "${args.name}" not found`)
  }

  return ok({
    name: recipe.metadata.name,
    namespace: recipe.metadata.namespace,
    phase: recipe.status?.phase ?? 'candidate',
    workloads: recipe.status?.workloads ?? [],
    conditions: recipe.status?.conditions ?? [],
    message: recipe.status?.message,
  })
}

export function handleValidateRecipe(args: { recipe_yaml: string }): McpTextContent {
  try {
    // Use a loose type for validation — WorkloadDef discriminated union
    // narrows too aggressively with Partial<>
    const parsed = JSON.parse(args.recipe_yaml) as {
      spec?: { workloads?: Array<{ id?: string; type?: string; image?: string }> }
    }

    const errors: string[] = []
    const workloads = parsed.spec?.workloads

    if (!workloads || workloads.length === 0) {
      errors.push('WorkflowRecipe must have at least one workload')
    }

    if (workloads && workloads.length > 0) {
      const ids = workloads.map(w => w.id ?? '')
      const uniqueIds = new Set(ids)
      if (uniqueIds.size !== ids.length) {
        errors.push('Workload IDs must be unique')
      }

      for (const w of workloads) {
        if (!w.id) errors.push('Each workload must have an id')
        if (!w.type) errors.push(`Workload "${w.id}" must have a type`)
        if (!w.image) errors.push(`Workload "${w.id}" must have an image`)
      }
    }

    if (errors.length > 0) {
      return ok({ valid: false, errors })
    }

    return ok({ valid: true, errors: [] })
  } catch {
    return ok({ valid: false, errors: ['Invalid JSON: unable to parse recipe'] })
  }
}

/**
 * Entry point for the intent decomposition pipeline.
 * When a recipe is deployed, the WRC decomposes it into MCP Intent,
 * Sandbox Intent, and Access-Policy Intent (see V2 §6.3).
 */
export function handleDeployRecipe(
  args: { recipe_name: string; namespace?: string; version?: string },
  provider: WorkflowRecipeProvider,
  identity: CallerIdentity,
  defaultNamespace = 'mcp-server'
): McpTextContent {
  const recipe = provider.getAllRecipes().find(r => r.metadata.name === args.recipe_name)

  if (recipe && recipe.spec.contextRef && recipe.spec.contextRef !== identity.contextRef) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: 'Cross-context deployment blocked', code: 403 }),
        },
      ],
      isError: true,
    }
  }

  return ok({
    status: 'accepted',
    recipe_name: args.recipe_name,
    namespace: args.namespace ?? defaultNamespace,
    message: recipe
      ? 'Recipe reconciliation triggered'
      : 'Recipe not found — will be created from registry when available',
  })
}

export function handleRollbackRecipe(
  args: { name: string; version?: number },
  provider: WorkflowRecipeProvider
): McpTextContent {
  const recipe = provider.getAllRecipes().find(r => r.metadata.name === args.name)
  if (!recipe) {
    return fail(`Recipe "${args.name}" not found`)
  }

  return ok({
    status: 'accepted',
    name: args.name,
    targetVersion: args.version ?? 'previous',
    message: 'Rollback triggered',
  })
}

export function handleDeleteRecipe(
  args: { name: string },
  provider: WorkflowRecipeProvider
): McpTextContent {
  const recipe = provider.getAllRecipes().find(r => r.metadata.name === args.name)
  if (!recipe) {
    return fail(`Recipe "${args.name}" not found`)
  }

  return ok({
    status: 'accepted',
    name: args.name,
    message: 'Delete triggered',
  })
}

export async function handleSearchRegistry(args: {
  query?: string
  category?: string
}): Promise<McpTextContent> {
  try {
    // npm-style search uses `q` only; `category` is accepted on the MCP tool
    // surface for forward-compat but currently ignored by the registry backend.
    const response = await searchEntries({ query: args.query })
    return ok({
      results: response.results,
      total: response.total,
      query: args.query ?? '',
      category: args.category ?? '',
    })
  } catch (error) {
    return fail(`Registry search failed: ${error}`)
  }
}

// TODO(Q6): Abstraction boundary violation — all other handlers receive a
// WorkflowRecipeProvider, but this one takes raw K8s CustomObjectsApi + namespace.
// Fix: add `listPolicies(): Promise<WorkflowRecipePolicyCRD[]>` to WorkflowRecipeProvider
// interface (src/k8sClient.ts), implement it in K8sWorkflowRecipeProvider, then change
// this signature to `handleListPolicies(provider: WorkflowRecipeProvider)`.
// Impact: low (no bugs, just inconsistent testability and coupling to K8s API).
// Blocked until WorkflowRecipeProvider interface is extended in a future phase.
export async function handleListPolicies(
  customApi: k8s.CustomObjectsApi,
  namespace: string
): Promise<McpTextContent> {
  let policies
  try {
    policies = await listWorkflowRecipePolicies(customApi, namespace)
  } catch (error: unknown) {
    console.error('[MCP-Handlers] listWorkflowRecipePolicies failed:', error)
    const code = getErrorCode(error)
    const msg =
      code === 403
        ? 'Permission denied listing policies — check ServiceAccount RBAC'
        : 'Unable to list policies — Kubernetes API unavailable'
    return fail(msg)
  }
  return ok({
    policies: policies.map(p => ({
      name: p.metadata.name,
      namespace: p.metadata.namespace,
      governance: p.spec.governance,
      detection: p.spec.detection,
    })),
  })
}
