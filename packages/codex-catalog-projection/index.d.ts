/**
 * @clerum/codex-catalog-projection — shared grant snapshot and Codex
 * execution projection for HCC, WRC, and mcp-host.
 *
 * Pure module: structural ConfigMap view only. No Kubernetes client, no
 * network, no `normalizeCodexConnectionKey` (that alias is a control-api
 * OAuth/DB reserved key, not a Host/recipe reader).
 */

export declare const ALLOWED_MODELS_CONFIGMAP_NAME: 'clerum-llm-allowed-models'
export declare const CONTENT_HASH_ANNOTATION: 'clerum.io/content-hash'
export declare const CATALOG_REVISION_ANNOTATION: 'clerum.io/catalog-revision'
export declare const CONNECTION_REVISION_ANNOTATION: 'clerum.io/connection-revision'
export declare const CODEX_CONNECTION_STATUS_ANNOTATION: 'clerum.io/codex-connection-status'
export declare const CODEX_ENABLED_ANNOTATION: 'clerum.io/codex-enabled'
export declare const CODEX_CONNECTIONS_ANNOTATION: 'clerum.io/codex-connections'
export declare const CODEX_CONNECTION_REF_ANNOTATION: 'clerum.io/codex-connection-ref'
export declare const SUBSCRIPTION_CONNECTION_REF_ANNOTATION: 'clerum.io/subscription-connection-ref'
export declare const CODEX_UNASSIGNED_CONNECTION_KEY: 'unassigned'
export declare const CODEX_PROVIDER: 'codex-subscription'
export declare const CODEX_EXECUTE_SCOPE: 'llm:codex:execute'
export declare const GROK_PROVIDER: 'grok-subscription'
export declare const GROK_EXECUTE_SCOPE: 'llm:grok:execute'
export declare const GROK_ENABLED_ANNOTATION: 'clerum.io/grok-enabled'
export declare const GROK_CONNECTIONS_ANNOTATION: 'clerum.io/grok-connections'
export declare const GROK_CONNECTION_STATUS_ANNOTATION: 'clerum.io/grok-connection-status'

export type CodexConfigMapView = {
  metadata?: { annotations?: Record<string, string> | null } | null
  data?: Record<string, string> | null
}

export type CodexTargetSource = 'primary' | 'allowed' | 'fallback'

export type CodexTarget = {
  source: CodexTargetSource
  provider: string
  model: string
}

export type CodexEligibility = 'eligible' | 'ineligible' | 'uncertain'

export type CodexSnapshotError = 'missing' | 'forbidden' | 'timeout' | 'malformed'

export type CodexConnectionStatus =
  | 'connected'
  | 'disconnected'
  | 'reauth-required'
  | 'unavailable'
  | 'revoked'
  | null

export type CodexCatalogSnapshot = {
  flagEnabled: boolean
  connectionStatus?: CodexConnectionStatus
  catalogContentHash?: string | null
  catalogRevision?: number | null
  connectionRevision?: number | null
  enabledModels?: Iterable<string>
  staleModels?: Iterable<string>
  snapshotError?: CodexSnapshotError
}

export type CodexHostSpec = {
  model?: { provider?: string; name?: string; connectionRef?: string }
  allowedModels?: Array<{ provider?: string; model?: string }>
  llmPolicy?: { fallbacks?: Array<{ provider?: string; model?: string }> }
}

export type CodexExecutionProjection = {
  targets: CodexTarget[]
  eligibleTargets: CodexTarget[]
  derivedScopes: string[]
  requiresCodexProxyEgress: boolean
  driftHashInput: string
  catalogContentHash: string | null
  catalogRevision: number | null
  connectionRevision: number | null
  eligibility: CodexEligibility
  reason: string
}

export type CodexPolicyBinding = {
  catalogRevision: number
  credentialRevision: number
  connectionKey?: string
  models?: string[]
}

export type CodexEligiblePolicyBinding = {
  connectionKey: string
  catalogRevision: number
  credentialRevision: number
  model: string
}

export type CodexEligiblePolicyBindingProjection = {
  binding: CodexEligiblePolicyBinding | null
  eligibility: CodexEligibility
  /**
   * `eligible` | `unassigned` | `model_missing` | `revision_missing`, or the
   * `reason` of the underlying `projectCodexExecution` (`flag_off`,
   * `connection_<status>`, `no_eligible_broker_target`, `snapshot_<error>`).
   */
  reason: string
}

/** Empty or missing → `unassigned`. Never aliases `deployment-default`. */
export declare function assignedCodexConnectionKey(value?: string | null): string
export declare function isCodexUnassignedConnectionKey(value?: string | null): boolean
export declare function snapshotFromConfigMapError(error: CodexSnapshotError): CodexCatalogSnapshot
export declare function parseAllowedModelsSnapshot(
  cm: CodexConfigMapView | undefined | null,
  connectionKey?: string
): CodexCatalogSnapshot
export declare function snapshotForAssignedCodexGrant(
  connectionKey: string,
  lastConfigMap: CodexConfigMapView | undefined | null,
  fallback: CodexCatalogSnapshot
): CodexCatalogSnapshot
export type SubscriptionConnectionRefResult =
  | { ok: true; connectionKey: string }
  | { ok: false; code: 'host_binding_mismatch'; message: string }

export declare function readSubscriptionConnectionRef(input: {
  provider: string
  annotations?: Record<string, string> | null
}): SubscriptionConnectionRefResult

export declare function collectCodexTargets(spec: CodexHostSpec): CodexTarget[]
export declare function projectCodexExecution(
  spec: CodexHostSpec,
  snapshot: CodexCatalogSnapshot
): CodexExecutionProjection
export declare function parseGrokAllowedModelsSnapshot(
  cm: CodexConfigMapView | undefined | null,
  connectionKey?: string
): CodexCatalogSnapshot
export declare function projectGrokExecution(
  spec: CodexHostSpec,
  snapshot: CodexCatalogSnapshot
): CodexExecutionProjection & { requiresGrokProxyEgress: boolean }
/**
 * Grok Host-chat revision view. Reads only `clerum.io/grok-connections`.
 * Never falls back to Codex annotations or the flat catalog.
 */
export declare function toGrokPolicyBinding(
  cm: CodexConfigMapView | undefined | null,
  connectionKey?: string
): CodexPolicyBinding | null
export declare function toEligibleGrokPolicyBinding(
  cm: CodexConfigMapView | undefined | null,
  connectionKey: string | undefined,
  model: string
): CodexEligiblePolicyBindingProjection
/**
 * Structural revision view for the Host chat reader (`configStore`). It does
 * NOT decide eligibility: a transiently `unavailable`/`reauth-required`
 * connection still yields a binding here on purpose, so a live mcp-host
 * binding is not wiped by a degraded snapshot. To mint an *execution* binding
 * use `toEligiblePolicyBinding`.
 */
export declare function toPolicyBinding(
  cm: CodexConfigMapView | undefined | null,
  connectionKey?: string
): CodexPolicyBinding | null
/**
 * Execution-gate binding: `binding !== null` exactly when
 * `projectCodexExecution` derives `llm:codex:execute` for the same model and
 * grant. `reason` explains a null binding without a second projection.
 */
export declare function toEligiblePolicyBinding(
  cm: CodexConfigMapView | undefined | null,
  connectionKey: string | undefined,
  model: string
): CodexEligiblePolicyBindingProjection
