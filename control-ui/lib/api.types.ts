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
