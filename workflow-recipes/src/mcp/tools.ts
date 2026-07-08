/**
 * MCP Tool definitions — 8 tools for WorkflowRecipe management.
 *
 * Each tool exports:
 * - A zod schema for input validation
 * - A name + description for MCP registration
 *
 * Source of truth: PHASE-4-MCP-SERVER-INTERFACE.md §4.1
 */
import { z } from 'zod/v3'

// ─── Tool Schemas ──────────────────────────────────────────────────────

export const deployRecipeSchema = z.object({
  recipe_name: z.string().describe('Name of the WorkflowRecipe to deploy'),
  namespace: z.string().optional().describe('Target namespace (defaults to config)'),
  version: z.string().optional().describe('Specific version from registry'),
})

export const listRecipesSchema = z.object({
  status_filter: z.string().optional().describe("Filter by recipe phase (e.g. 'active', 'failed')"),
})

export const getRecipeStatusSchema = z.object({
  name: z.string().describe('Name of the WorkflowRecipe'),
})

export const rollbackRecipeSchema = z.object({
  name: z.string().describe('Name of the WorkflowRecipe to rollback'),
  version: z.number().optional().describe('Target version to rollback to'),
})

export const deleteRecipeSchema = z.object({
  name: z.string().describe('Name of the WorkflowRecipe to delete'),
})

export const validateRecipeSchema = z.object({
  recipe_yaml: z.string().describe('WorkflowRecipe YAML string to validate'),
})

export const searchRegistrySchema = z.object({
  query: z.string().optional().describe('Search query'),
  category: z.string().optional().describe('Filter by category'),
  visibility: z
    .enum(['public', 'private', 'all'])
    .optional()
    .describe('Filter by visibility (default: public for unauth, all for auth)'),
})

export const listPoliciesSchema = z.object({}).strict()

// ─── Tool Definitions (name + description) ─────────────────────────────

export interface ToolDef {
  name: string
  description: string
  schema: z.ZodObject<z.ZodRawShape>
}

export const TOOLS: ToolDef[] = [
  {
    name: 'deploy_recipe',
    description: 'Deploy a WorkflowRecipe — triggers WRC intent decomposition (see V2 §6.3)',
    schema: deployRecipeSchema,
  },
  {
    name: 'list_recipes',
    description: 'List all WorkflowRecipes with optional status filter',
    schema: listRecipesSchema,
  },
  {
    name: 'get_recipe_status',
    description: 'Get detailed status of a WorkflowRecipe',
    schema: getRecipeStatusSchema,
  },
  {
    name: 'rollback_recipe',
    description: 'Trigger rollback on a WorkflowRecipe',
    schema: rollbackRecipeSchema,
  },
  {
    name: 'delete_recipe',
    description: 'Delete a WorkflowRecipe and its managed resources',
    schema: deleteRecipeSchema,
  },
  {
    name: 'validate_recipe',
    description: 'Validate WorkflowRecipe YAML without deploying',
    schema: validateRecipeSchema,
  },
  {
    name: 'search_registry',
    description: 'Search the WorkflowRecipe registry',
    schema: searchRegistrySchema,
  },
  {
    name: 'list_policies',
    description: 'List active WorkflowRecipePolicies',
    schema: listPoliciesSchema,
  },
]
