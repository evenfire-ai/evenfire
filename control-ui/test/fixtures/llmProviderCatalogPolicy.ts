import { PROVIDER_CATALOG_AUTO_ENABLE_DEFAULT } from '@clerum/llm-providers'
import type { StaticCatalogProviderId } from '@clerum/llm-providers'
import type { LlmProviderCatalogPolicy } from '../../lib/api.types'

/**
 * control-api's catalog-policy producer (`toPolicy` in
 * control-api/src/services/llmProviderCatalogSettings.ts) cannot run inside
 * control-ui's test process, so this mirrors it field for field. The code
 * default is NOT hand-written: it comes from the same
 * `PROVIDER_CATALOG_AUTO_ENABLE_DEFAULT` the server reads.
 */
export function buildCatalogPolicy(
  provider: StaticCatalogProviderId,
  override?: { auto_enable: boolean; updated_at: string; updated_by: string | null }
): LlmProviderCatalogPolicy {
  const codeDefault = PROVIDER_CATALOG_AUTO_ENABLE_DEFAULT[provider]
  return {
    provider,
    auto_enable: override ? override.auto_enable : codeDefault,
    default: codeDefault,
    overridden: override !== undefined,
    updated_at: override ? override.updated_at : null,
    updated_by: override ? override.updated_by : null,
  }
}

/** Bodies the control-api route sends verbatim (llmProviderCatalogPolicy.ts). */
export const CATALOG_SYNC_IN_PROGRESS_BODY = {
  error: 'catalog_sync_in_progress',
  message: 'a catalog sync is running and holds the policy lock; nothing was saved — retry shortly',
}

export const CATALOG_POLICY_NOT_FOUND_BODY = {
  error: 'not_found',
  message: 'provider has no catalog auto-enable policy',
}
