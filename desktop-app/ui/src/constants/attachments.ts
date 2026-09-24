// Must match INCOMING_IMAGE_MAX_COUNT in mcp-host/src/agent/incomingImageAttachments.ts.
export const COMPOSER_MAX_IMAGE_ATTACHMENTS = 20

/**
 * General (#654 / PR #669) per-image ceiling for every image-capable model
 * that is not Codex. Images travel inline in the ordinary 10 MB JSON body.
 */
export const COMPOSER_MAX_IMAGE_BYTES = 3 * 1024 * 1024
/**
 * Combined base64 size of the images in one non-Codex message. rpc-proxy and
 * mcp-host parse ordinary JSON with a 10 MB body limit; 2 MB is left for the
 * text and the request envelope.
 */
export const COMPOSER_MAX_TOTAL_IMAGE_BASE64_BYTES = 8 * 1024 * 1024

/**
 * Codex-only (#650) per-image ceiling. The 16 MiB aggregate lives on the
 * Codex chat hop and the shared contract, not in this picker.
 */
export const CODEX_COMPOSER_MAX_IMAGE_BYTES = 16 * 1024 * 1024
/** Official Codex client long-side bound. The Codex hop 400s frames above this. */
export const CODEX_COMPOSER_MAX_IMAGE_DIMENSION = 2048

/**
 * Grok-only (#784) per-image ceiling. xAI allows 20 MiB per image, but a
 * composer image crosses the shared ingress (rpc-proxy and mcp-host), which
 * caps each image and the message total at 16 MiB decoded. This is that cap,
 * not the xAI limit; only tool screenshots can use the contract's 20 MiB.
 */
export const GROK_COMPOSER_MAX_IMAGE_BYTES = 16 * 1024 * 1024
/** The same 16 MiB ingress total, as the base64 bytes the composer counts. */
export const GROK_COMPOSER_MAX_TOTAL_IMAGE_BASE64_BYTES =
  4 * Math.ceil(GROK_COMPOSER_MAX_IMAGE_BYTES / 3)

export const COMPOSER_ACCEPT_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png'] as const

export const CODEX_SUBSCRIPTION_PROVIDER = 'codex-subscription'
export const GROK_SUBSCRIPTION_PROVIDER = 'grok-subscription'

export type ComposerImageBudget = {
  maxImageBytes: number
  /** `null` → no composer aggregate; the Codex hop owns that ceiling. */
  maxTotalBase64Bytes: number | null
  /**
   * Bytes the total-limit copy names. It is the base64 total for the general
   * branch (#669 counts and names base64 MB) and the decoded ingress total for
   * Grok, whose base64 total is exactly the encoding of 16 MiB.
   */
  totalLimitLabelBytes: number | null
  /** `null` → no composer pixel bound (Grok and general models). */
  maxDimension: number | null
  sizeUnit: 'MB' | 'MiB'
}

/**
 * Product limits for the picker. Codex keeps #650, Grok gets the shared
 * ingress cap with no pixel bound (#784), everyone else keeps #669.
 */
export function composerImageBudget(provider: string | null | undefined): ComposerImageBudget {
  if (provider === CODEX_SUBSCRIPTION_PROVIDER) {
    return {
      maxImageBytes: CODEX_COMPOSER_MAX_IMAGE_BYTES,
      maxTotalBase64Bytes: null,
      totalLimitLabelBytes: null,
      maxDimension: CODEX_COMPOSER_MAX_IMAGE_DIMENSION,
      sizeUnit: 'MiB',
    }
  }
  if (provider === GROK_SUBSCRIPTION_PROVIDER) {
    return {
      maxImageBytes: GROK_COMPOSER_MAX_IMAGE_BYTES,
      maxTotalBase64Bytes: GROK_COMPOSER_MAX_TOTAL_IMAGE_BASE64_BYTES,
      totalLimitLabelBytes: GROK_COMPOSER_MAX_IMAGE_BYTES,
      maxDimension: null,
      sizeUnit: 'MiB',
    }
  }
  return {
    maxImageBytes: COMPOSER_MAX_IMAGE_BYTES,
    maxTotalBase64Bytes: COMPOSER_MAX_TOTAL_IMAGE_BASE64_BYTES,
    totalLimitLabelBytes: COMPOSER_MAX_TOTAL_IMAGE_BASE64_BYTES,
    maxDimension: null,
    sizeUnit: 'MB',
  }
}
