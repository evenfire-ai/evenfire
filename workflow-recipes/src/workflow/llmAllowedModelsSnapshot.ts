import {
  CODEX_CONNECTION_REF_ANNOTATION,
  assignedCodexConnectionKey,
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
  annotations: Record<string, string> | undefined
): string {
  return assignedCodexConnectionKey(annotations?.[CODEX_CONNECTION_REF_ANNOTATION])
}
