/**
 * Registry connection types shared by coordinator and CLI clients.
 */

export interface RegistryRecipe {
  name: string
  version: string
  description: string
  recipeType: 'only-workloads' | 'workflow'
  ociReference: string
  stepCount: number
  mcpServerIds: string[]
  hasAgent: boolean
  hasSoulMd: boolean
  outputType?: string
  sdkVersion?: string
  qualityTier: 'verified' | 'unverified'
  deprecated: boolean
  createdAt: string
}

export interface ArtifactManifest {
  soulMd?: string
  stepSoulMds?: Record<string, string>
}

export interface PushRecipeRequest {
  name: string
  version: string
  description: string
  author: string
  origin: 'agent-generated' | 'human-authored' | 'community'
  category: string
  visibility: 'public' | 'private'
  recipe: string
  artifacts?: ArtifactManifest
}

export interface PushRecipeResponse {
  name: string
  version: string
  recipeType: 'only-workloads' | 'workflow'
  stepCount: number
  ociReference: string
  artifacts?: ArtifactManifest
  createdAt: string
}

export interface SearchParams {
  q?: string
  category?: string
  recipeType?: 'only-workloads' | 'workflow' | 'all'
  origin?: 'agent-generated' | 'human-authored' | 'community'
  hasAgent?: boolean
  hasSoulMd?: boolean
  deprecated?: boolean
  visibility?: 'public' | 'private' | 'all'
  sort?: 'name' | 'downloads' | 'createdAt' | 'stepCount'
  limit?: number
  offset?: number
}

export interface SearchResult {
  recipes: RegistryRecipe[]
  total: number
  limit: number
  offset: number
}
