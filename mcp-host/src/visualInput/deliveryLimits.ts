import {
  LIMITS as CODEX_LIMITS,
  VISUAL_LIMITS as CODEX_VISUAL_LIMITS,
} from '@clerum/llm-provider-attempt-contract'

export interface VisualDeliveryLimits {
  maxImageBytes: number
  maxTotalImageBytes: number
  maxImages: number
  maxVisualRequestBytes: number
  maxNonImageRequestBytes?: number
  maxDimension?: number
  maxPixels?: number
}

/**
 * Effective visual limits are supplied by the physical provider contract. They
 * are deliberately not source-transfer limits and must not be copied into GFS
 * metadata admission.
 */
export function resolveVisualDeliveryLimits(providerType: string): VisualDeliveryLimits | null {
  if (providerType === 'codex-subscription')
    return {
      maxImageBytes: CODEX_VISUAL_LIMITS.maxImageBytes,
      maxTotalImageBytes: CODEX_VISUAL_LIMITS.maxTotalImageBytes,
      maxImages: CODEX_VISUAL_LIMITS.maxImages,
      maxVisualRequestBytes: CODEX_LIMITS.maxVisualRequestBodyBytes,
      maxNonImageRequestBytes: CODEX_LIMITS.maxRequestBodyBytes,
      maxDimension: CODEX_VISUAL_LIMITS.maxImageDimension,
      maxPixels: CODEX_VISUAL_LIMITS.maxImagePixels,
    }

  return null
}
