/**
 * RegistryClient — interface-only contract.
 *
 * Defines the operations a coordinator or CLI can perform against
 * the Clerum Recipe Registry. Concrete implementation (HTTP client
 * using fetch against the registry API) is provided by callers.
 */
import type {
  PushRecipeRequest,
  PushRecipeResponse,
  RegistryRecipe,
  SearchParams,
  SearchResult,
} from './types'

export interface RegistryClient {
  /** Push a recipe to the registry. Requires API key. */
  push(request: PushRecipeRequest, apiKey: string): Promise<PushRecipeResponse>

  /** Pull a recipe by name (latest version). */
  pull(name: string): Promise<RegistryRecipe | null>

  /** Pull a specific version of a recipe. */
  pullVersion(name: string, version: string): Promise<RegistryRecipe | null>

  /** Search recipes with filters. */
  search(params: SearchParams): Promise<SearchResult>

  /** Upload SOUL.md artifacts for a recipe. Requires API key. */
  uploadArtifacts(
    name: string,
    artifacts: { soulMd?: string; stepSoulMds?: Record<string, string> },
    apiKey: string
  ): Promise<void>

  /** List artifacts for a recipe. */
  listArtifacts(name: string): Promise<{ soulMd?: string; stepSoulMds?: Record<string, string> }>

  /** Health check against the registry. */
  health(): Promise<{ status: 'ok' | 'unavailable' }>
}
