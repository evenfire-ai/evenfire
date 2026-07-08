// Canonical storage namespace for WorkflowRecipe CRDs.
//
// Recipes live in `sandbox-recipes` alongside the coordinator and mcp-host
// pods they orchestrate (Phase-8 non-MCP classification). MCP workloads
// declared in `spec.workloads[]` with a `transport` field are still rendered
// into `mcp-server` by the reconciler — that split is a server-side detail
// the UI never needs to mirror.
export const DEFAULT_WORKFLOW_RECIPE_NAMESPACE = 'sandbox-recipes'
