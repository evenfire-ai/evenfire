import { describe, expect, it } from 'vitest'
import {
  TOOLS,
  deleteRecipeSchema,
  deployRecipeSchema,
  getRecipeStatusSchema,
  listPoliciesSchema,
  listRecipesSchema,
  rollbackRecipeSchema,
  searchRegistrySchema,
  validateRecipeSchema,
} from './tools'

// ─── deploy_recipe ─────────────────────────────────────────────────

describe('deploy_recipe schema', () => {
  it("accepts {recipe_name: 'test'} (4.1a)", () => {
    const result = deployRecipeSchema.safeParse({ recipe_name: 'test' })
    expect(result.success).toBe(true)
  })

  it('rejects {} (missing recipe_name) (4.1b)', () => {
    const result = deployRecipeSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})

// ─── list_recipes ──────────────────────────────────────────────────

describe('list_recipes schema', () => {
  it("accepts {status_filter: 'active'} (4.2a)", () => {
    const result = listRecipesSchema.safeParse({ status_filter: 'active' })
    expect(result.success).toBe(true)
  })

  it('accepts {} (no filter) (4.2b)', () => {
    const result = listRecipesSchema.safeParse({})
    expect(result.success).toBe(true)
  })
})

// ─── get_recipe_status ─────────────────────────────────────────────

describe('get_recipe_status schema', () => {
  it("accepts {name: 'x'} (4.3a)", () => {
    const result = getRecipeStatusSchema.safeParse({ name: 'x' })
    expect(result.success).toBe(true)
  })

  it('rejects {} (4.3b)', () => {
    const result = getRecipeStatusSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})

// ─── rollback_recipe ───────────────────────────────────────────────

describe('rollback_recipe schema', () => {
  it("accepts {name: 'x'} (4.4a)", () => {
    const result = rollbackRecipeSchema.safeParse({ name: 'x' })
    expect(result.success).toBe(true)
  })

  it('rejects {} (4.4b)', () => {
    const result = rollbackRecipeSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})

// ─── delete_recipe ─────────────────────────────────────────────────

describe('delete_recipe schema', () => {
  it("accepts {name: 'x'} (4.5a)", () => {
    const result = deleteRecipeSchema.safeParse({ name: 'x' })
    expect(result.success).toBe(true)
  })

  it('rejects {} (4.5b)', () => {
    const result = deleteRecipeSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})

// ─── validate_recipe ───────────────────────────────────────────────

describe('validate_recipe schema', () => {
  it("accepts {recipe_yaml: '...'} (4.6a)", () => {
    const result = validateRecipeSchema.safeParse({ recipe_yaml: '{"spec":{}}' })
    expect(result.success).toBe(true)
  })

  it('rejects {} (4.6b)', () => {
    const result = validateRecipeSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})

// ─── search_registry ───────────────────────────────────────────────

describe('search_registry schema', () => {
  it("accepts {query: 'test'} (4.7a)", () => {
    const result = searchRegistrySchema.safeParse({ query: 'test' })
    expect(result.success).toBe(true)
  })

  it('accepts {} (4.7b)', () => {
    const result = searchRegistrySchema.safeParse({})
    expect(result.success).toBe(true)
  })
})

// ─── list_policies ─────────────────────────────────────────────────

describe('list_policies schema', () => {
  it('accepts {} (4.8a)', () => {
    const result = listPoliciesSchema.safeParse({})
    expect(result.success).toBe(true)
  })

  it('rejects extra fields (4.8b)', () => {
    const result = listPoliciesSchema.safeParse({ unexpected: 'field' })
    expect(result.success).toBe(false)
  })
})

// ─── TOOLS array ───────────────────────────────────────────────────

describe('TOOLS array', () => {
  it('has exactly 8 tool definitions', () => {
    expect(TOOLS).toHaveLength(8)
  })

  it('all tools have name, description, and schema', () => {
    for (const tool of TOOLS) {
      expect(tool.name).toBeDefined()
      expect(tool.description).toBeDefined()
      expect(tool.schema).toBeDefined()
    }
  })
})
