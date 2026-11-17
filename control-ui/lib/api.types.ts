export type ApiThrottleMetadata = {
  retryAfterSeconds?: number
  retryAtMs?: number
}

export type ApiRequestError = Error & {
  status?: number
  code?: string
  body?: Record<string, unknown>
} & ApiThrottleMetadata

export type MetadataReadKind =
  | 'subscription-capabilities'
  | 'subscription-connections'
  | 'subscription-model-catalog'

export type ApiRequestOptions = {
  silentUnauthorized?: boolean
  signal?: AbortSignal
  metadataRead?: MetadataReadKind
  refresh?: boolean
}

/**
 * One provider's catalog auto-enable policy, as served by control-api
 * `GET /admin/llm-providers/catalog-policy` and returned by the PUT. Mirrors
 * `ProviderCatalogPolicy` in control-api/src/services/llmProviderCatalogSettings.ts;
 * the control-ui tests read the wire file control-api generates from its real
 * `toPolicy`, so a producer change shows up there.
 */
export type LlmProviderCatalogPolicy = {
  provider: string
  /** Effective value: the operator override when present, else the code default. */
  auto_enable: boolean
  default: boolean
  /**
   * True while an operator override is stored, even one equal to the default.
   * This alone decides "Custom" versus "Default".
   */
  overridden: boolean
  /**
   * Who last set or reset the policy. Kept after a reset as an audit trace, so
   * a non-null value does not mean the provider is overridden.
   */
  updated_at: string | null
  updated_by: string | null
}

/**
 * What one catalog sync did with providers' NEW models, summed over the
 * `providerCounts` of `POST /admin/llm-models/discovery/sync`
 * (`CatalogSyncProviderCount` in control-api/src/services/llmCatalogSync.ts).
 */
export type LlmDiscoverySyncOutcome = {
  /** Rows inserted enabled (already part of the result's `added`). */
  autoEnabled: number
  /** New models not inserted: auto-enable on, but the run could not decide. */
  heldUndecidable: number
  /** New models not inserted: the run reached its auto-enable cap. */
  deferredByCap: number
  /**
   * Rows the sync had turned off for having no consumers, turned back on because
   * the catalog lists them again. Existing rows, so never part of `added`.
   */
  reEnabled: number
  /** Such rows left off because the run reached its auto-enable cap. */
  reEnableDeferredByCap: number
}
