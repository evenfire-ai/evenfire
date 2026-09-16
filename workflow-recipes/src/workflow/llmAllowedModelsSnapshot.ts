import {
  CODEX_PROVIDER,
  CODEX_UNASSIGNED_CONNECTION_KEY,
  readSubscriptionConnectionRef,
} from '@clerum/codex-catalog-projection'

export {
  ALLOWED_MODELS_CONFIGMAP_NAME,
  CATALOG_REVISION_ANNOTATION,
  CODEX_CONNECTION_REF_ANNOTATION,
  CODEX_CONNECTIONS_ANNOTATION,
  CODEX_CONNECTION_STATUS_ANNOTATION,
  CODEX_ENABLED_ANNOTATION,
  CODEX_UNASSIGNED_CONNECTION_KEY,
  CONNECTION_REVISION_ANNOTATION,
  CONTENT_HASH_ANNOTATION,
  SUBSCRIPTION_CONNECTION_REF_ANNOTATION,
  parseAllowedModelsSnapshot,
  snapshotForAssignedCodexGrant,
  snapshotFromConfigMapError,
} from '@clerum/codex-catalog-projection'

export const ALLOWLIST_CONFIGMAP_NAMESPACE = process.env.CLERUM_MODEL_CONFIG_NAMESPACE ?? 'mcp-host'

/**
 * Recipe annotation reader. Empty/missing is `unassigned`, never the reserved
 * grant: only an explicit annotation may spend a ChatGPT subscription.
 */
export function readRecipeCodexConnectionRef(
  annotations: Record<string, string> | undefined,
  provider: string = CODEX_PROVIDER
): string {
  const result = readSubscriptionConnectionRef({ provider, annotations })
  if (!result.ok) return CODEX_UNASSIGNED_CONNECTION_KEY
  return result.connectionKey
}
