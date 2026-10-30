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
 * `GET /admin/llm-providers/catalog-policy` and returned by the PUT. Field
 * names mirror `ProviderCatalogPolicy` in
 * control-api/src/services/llmProviderCatalogSettings.ts (not shared across
 * services, so kept in step by hand).
 */
export type LlmProviderCatalogPolicy = {
  provider: string
  /** Effective value: the operator override when present, else the code default. */
  auto_enable: boolean
  default: boolean
  overridden: boolean
  updated_at: string | null
  updated_by: string | null
}
