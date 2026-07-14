/**
 * Registry Client — multi-registry search and pull for WorkflowRecipes.
 *
 * Supports public registries (no auth), private registries (credentials from K8s Secret),
 * and configurable backends (DOCR, GHCR, generic OCI).
 *
 * Source of truth: CLERUM-RECIPE-REGISTRY-SPEC.md §2.4, §3
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type RegistryType = 'public' | 'private'
export type OciBackend = 'docr' | 'ghcr' | 'generic-oci'
export type RecipeVisibility = 'public' | 'private'

export interface RegistryEndpoint {
  name: string
  url: string
  type: RegistryType
  ociBackend?: OciBackend
  default?: boolean
  credentialsSecret?: string
  /** Resolved credentials (populated at runtime from K8s Secret). */
  credentials?: { username: string; password: string }
}

export interface RegistrySearchParams {
  query?: string
  category?: string
  visibility?: 'public' | 'private' | 'all'
  limit?: number
  offset?: number
  sort?: 'name' | 'downloads' | 'qualityScore' | 'createdAt'
  order?: 'asc' | 'desc'
}

export interface RegistryRecipeResult {
  name: string
  version: string
  description: string
  author: string
  origin: string
  category: string
  visibility: RecipeVisibility
  qualityTier: 'verified' | 'unverified'
  downloads: number
  ociReference: string
  registry: string
}

export interface RegistrySearchResponse {
  results: RegistryRecipeResult[]
  total: number
  registriesQueried: string[]
}

// ─── Client ──────────────────────────────────────────────────────────────────

export class RegistryClient {
  private registries: RegistryEndpoint[]

  constructor(registries: RegistryEndpoint[]) {
    this.registries = registries
  }

  /**
   * Search across all configured registries and merge results.
   *
   * Public registries are queried without credentials.
   * Private registries require resolved credentials.
   * Results are merged, deduplicated by name+version, and sorted.
   */
  async search(params: RegistrySearchParams): Promise<RegistrySearchResponse> {
    const allResults: RegistryRecipeResult[] = []
    const queriedRegistries: string[] = []

    for (const registry of this.registries) {
      try {
        const results = await this.searchSingleRegistry(registry, params)
        allResults.push(...results)
        queriedRegistries.push(registry.name)
      } catch (error) {
        console.error(`[RegistryClient] Failed to query "${registry.name}":`, error)
      }
    }

    // Deduplicate by name + version (first occurrence wins — default registry first)
    const seen = new Set<string>()
    const deduped = allResults.filter(r => {
      const key = `${r.name}@${r.version}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    // Sort
    const sorted = this.sortResults(deduped, params.sort, params.order)

    // Paginate
    const offset = params.offset ?? 0
    const limit = params.limit ?? 50
    const paginated = sorted.slice(offset, offset + limit)

    return {
      results: paginated,
      total: sorted.length,
      registriesQueried: queriedRegistries,
    }
  }

  /**
   * Pull a specific recipe by name and optional version from the first
   * registry that has it.
   */
  async pull(name: string, version?: string): Promise<RegistryRecipeResult | null> {
    for (const registry of this.registries) {
      try {
        const result = await this.pullFromRegistry(registry, name, version)
        if (result) return result
      } catch (error) {
        console.error(`[RegistryClient] Failed to pull "${name}" from "${registry.name}":`, error)
      }
    }
    return null
  }

  /** Get the default registry endpoint (first marked as default, or first in list). */
  getDefaultRegistry(): RegistryEndpoint | undefined {
    return this.registries.find(r => r.default) ?? this.registries[0]
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  private async searchSingleRegistry(
    registry: RegistryEndpoint,
    params: RegistrySearchParams
  ): Promise<RegistryRecipeResult[]> {
    const url = new URL('/api/v1/recipes', registry.url)
    if (params.query) url.searchParams.set('q', params.query)
    if (params.category) url.searchParams.set('category', params.category)
    if (params.sort) url.searchParams.set('sort', params.sort)
    if (params.order) url.searchParams.set('order', params.order)

    // Visibility filtering: private registries always include private recipes
    // for authenticated users; public registries only return public recipes.
    const visibility = params.visibility ?? (registry.type === 'private' ? 'all' : 'public')
    url.searchParams.set('visibility', visibility)

    // Set high limit to get all results before client-side merge
    url.searchParams.set('limit', '200')

    const headers: Record<string, string> = { Accept: 'application/json' }
    if (registry.credentials) {
      const token = Buffer.from(
        `${registry.credentials.username}:${registry.credentials.password}`
      ).toString('base64')
      headers['Authorization'] = `Basic ${token}`
    }

    const response = await fetch(url.toString(), { headers })
    if (!response.ok) {
      throw new Error(`Registry "${registry.name}" returned ${response.status}`)
    }

    const body = (await response.json()) as {
      results?: Array<{
        name: string
        version: string
        description: string
        author: string
        origin: string
        category: string
        visibility?: string
        qualityTier?: string
        downloads?: number
        ociReference?: string
      }>
    }

    return (body.results ?? []).map(r => ({
      name: r.name,
      version: r.version,
      description: r.description ?? '',
      author: r.author ?? 'unknown',
      origin: r.origin ?? 'unknown',
      category: r.category ?? 'uncategorized',
      visibility: (r.visibility as RecipeVisibility) ?? 'public',
      qualityTier: (r.qualityTier as 'verified' | 'unverified') ?? 'unverified',
      downloads: r.downloads ?? 0,
      ociReference: r.ociReference ?? '',
      registry: registry.name,
    }))
  }

  private async pullFromRegistry(
    registry: RegistryEndpoint,
    name: string,
    version?: string
  ): Promise<RegistryRecipeResult | null> {
    const path = version
      ? `/api/v1/recipes/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`
      : `/api/v1/recipes/${encodeURIComponent(name)}`
    const url = new URL(path, registry.url)

    const headers: Record<string, string> = { Accept: 'application/json' }
    if (registry.credentials) {
      const token = Buffer.from(
        `${registry.credentials.username}:${registry.credentials.password}`
      ).toString('base64')
      headers['Authorization'] = `Basic ${token}`
    }

    const response = await fetch(url.toString(), { headers })
    if (response.status === 404) return null
    if (!response.ok) {
      throw new Error(`Registry "${registry.name}" returned ${response.status}`)
    }

    const r = (await response.json()) as {
      name: string
      version: string
      description?: string
      author?: string
      origin?: string
      category?: string
      visibility?: string
      qualityTier?: string
      downloads?: number
      ociReference?: string
    }

    return {
      name: r.name,
      version: r.version,
      description: r.description ?? '',
      author: r.author ?? 'unknown',
      origin: r.origin ?? 'unknown',
      category: r.category ?? 'uncategorized',
      visibility: (r.visibility as RecipeVisibility) ?? 'public',
      qualityTier: (r.qualityTier as 'verified' | 'unverified') ?? 'unverified',
      downloads: r.downloads ?? 0,
      ociReference: r.ociReference ?? '',
      registry: registry.name,
    }
  }

  private sortResults(
    results: RegistryRecipeResult[],
    sort?: string,
    order?: string
  ): RegistryRecipeResult[] {
    if (!sort) return results
    const asc = order !== 'desc'
    return [...results].sort((a, b) => {
      let cmp = 0
      switch (sort) {
        case 'name':
          cmp = a.name.localeCompare(b.name)
          break
        case 'downloads':
          cmp = a.downloads - b.downloads
          break
        default:
          cmp = a.name.localeCompare(b.name)
      }
      return asc ? cmp : -cmp
    })
  }
}
