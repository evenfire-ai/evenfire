import {
  LIMITS as CODEX_LIMITS,
  VISUAL_LIMITS as CODEX_VISUAL_LIMITS,
} from '@clerum/llm-provider-attempt-contract'
import { type ImageTransportOperation, transportSupportsImageInput } from '../llm/imageInput'

export interface VisualDeliveryLimits {
  /** Decoded container bytes; omitted when the contract does not publish a bound. */
  maxImageBytes?: number
  maxTotalImageBytes?: number
  maxImageEncodedBytes?: number
  maxImages: number
  maxVisualRequestBytes: number
  maxNonImageRequestBytes?: number
  maxDimension?: number
  maxPixels?: number
  maxDimensionAboveImageCount?: { count: number; maxDimension: number }
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

/** A profile belongs to this official SDK endpoint and implemented operation. */
export function resolveOfficialVisualDeliveryLimits(
  provider: 'openai' | 'claude',
  baseURL: unknown,
  operation: ImageTransportOperation
): VisualDeliveryLimits | null {
  if (!transportSupportsImageInput(provider, operation) || typeof baseURL !== 'string') return null
  let url: URL
  try {
    url = new URL(baseURL)
  } catch {
    return null
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.port && url.port !== '443')
  )
    return null
  if (provider === 'openai') {
    if (
      url.origin !== 'https://api.openai.com' ||
      (url.pathname !== '/v1' && url.pathname !== '/v1/')
    )
      return null
    // https://developers.openai.com/api/docs/guides/images-vision
    // 512 MB is the serialized payload bound, not a published raw-image bound.
    return { maxImages: 1500, maxVisualRequestBytes: 512_000_000 }
  }
  if (url.origin !== 'https://api.anthropic.com' || url.pathname !== '/') return null
  // https://platform.claude.com/docs/en/build-with-claude/vision
  // https://platform.claude.com/docs/en/api/errors
  // 100 is the Host's conservative bound without trusted model-window metadata,
  // not a universal API maximum. Do not infer the 600-image allowance from a name/default.
  return {
    maxImageBytes: 7_500_000,
    maxImageEncodedBytes: 10_000_000,
    maxImages: 100,
    maxVisualRequestBytes: 32_000_000,
    maxDimension: 8000,
    maxDimensionAboveImageCount: { count: 20, maxDimension: 2000 },
  }
}

export function visualDimensionLimit(
  limits: VisualDeliveryLimits,
  imageCount: number
): number | undefined {
  const threshold = limits.maxDimensionAboveImageCount
  return threshold && imageCount > threshold.count ? threshold.maxDimension : limits.maxDimension
}
