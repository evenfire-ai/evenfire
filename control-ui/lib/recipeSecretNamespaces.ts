/**
 * Recipe-secret namespace resolution.
 *
 * WorkflowRecipe secret VALUES are written by control-ui to the Kubernetes
 * namespace where the consuming pod runs, then validated server-side. In a
 * single-tenant cluster those namespaces are the bare `sandbox-recipes` /
 * `mcp-server`. In an MCC per-tenant ("shared mode") cluster they are suffixed
 * with the tenant slug — `sandbox-recipes-<slug>` / `mcp-server-<slug>` — and
 * control-api enforces exactly that suffixed pair (see
 * `WORKFLOW_RECIPE_SECRET_NAMESPACES` in control-api recipes route, sourced from
 * `config.sandboxNamespace` / `config.mcpServersNamespace`).
 *
 * control-ui must therefore learn the right pair instead of hardcoding the bare
 * names. It has two authoritative sources:
 *   - the recipe's OWN namespace (EDIT mode — the CRD already lives in the
 *     tenant sandbox namespace), and
 *   - the server's configured namespaces, fetched from GET /admin/auth/me
 *     (CREATE mode — the recipe namespace does not exist yet at secret-write
 *     time because secrets are written BEFORE createRecipe()).
 *
 * Both collapse to the bare defaults on single-tenant clusters, preserving
 * existing behavior byte-for-byte.
 */

export const DEFAULT_SANDBOX_SECRET_NAMESPACE = 'sandbox-recipes'
export const DEFAULT_MCP_SERVER_SECRET_NAMESPACE = 'mcp-server'

export interface RecipeSecretNamespaces {
  sandbox: string
  mcpServer: string
}

/**
 * Derive the mcp-server namespace that shares the tenant suffix of a given
 * sandbox-recipes namespace, by prefix-swap:
 *   'sandbox-recipes'       -> 'mcp-server'
 *   'sandbox-recipes-acme'  -> 'mcp-server-acme'
 * Any base that is not a 'sandbox-recipes' namespace falls back to the bare
 * default (we cannot infer a suffix from it).
 */
export function deriveMcpServerNs(sandboxNs: string): string {
  if (sandboxNs === DEFAULT_SANDBOX_SECRET_NAMESPACE) {
    return DEFAULT_MCP_SERVER_SECRET_NAMESPACE
  }
  if (sandboxNs.startsWith(`${DEFAULT_SANDBOX_SECRET_NAMESPACE}-`)) {
    return `${DEFAULT_MCP_SERVER_SECRET_NAMESPACE}${sandboxNs.slice(
      DEFAULT_SANDBOX_SECRET_NAMESPACE.length
    )}`
  }
  return DEFAULT_MCP_SERVER_SECRET_NAMESPACE
}

/**
 * Resolve the tenant-correct recipe-secret namespace pair.
 *
 * Priority:
 *  1. EDIT (recipeNamespace present): the recipe's own namespace is
 *     authoritative for `sandbox`. For `mcpServer`, prefer the server-fetched
 *     value when it pairs with this exact sandbox namespace (removes the
 *     equal-suffix assumption); otherwise derive by prefix-swap.
 *  2. CREATE (no recipeNamespace): use the server-fetched pair (the only source,
 *     since the recipe namespace does not exist yet).
 *  3. Fallback: the bare single-tenant defaults.
 */
export function resolveRecipeSecretNamespaces(opts: {
  recipeNamespace?: string | null
  fetched?: RecipeSecretNamespaces | null
}): RecipeSecretNamespaces {
  const ns = opts.recipeNamespace?.trim()
  if (ns) {
    const mcpServer =
      opts.fetched && opts.fetched.sandbox === ns ? opts.fetched.mcpServer : deriveMcpServerNs(ns)
    return { sandbox: ns, mcpServer }
  }
  if (opts.fetched?.sandbox && opts.fetched?.mcpServer) {
    return { sandbox: opts.fetched.sandbox, mcpServer: opts.fetched.mcpServer }
  }
  return {
    sandbox: DEFAULT_SANDBOX_SECRET_NAMESPACE,
    mcpServer: DEFAULT_MCP_SERVER_SECRET_NAMESPACE,
  }
}
