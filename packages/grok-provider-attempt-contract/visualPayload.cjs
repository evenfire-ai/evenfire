'use strict'

/**
 * Image budget for grok-completion-request.v2.
 *
 * The numbers come from the xAI documentation for api.x.ai/v1 (read
 * 2026-09-23): at most 20 MiB per image, jpg/jpeg and png only, no
 * image-count limit. The per-request budget of 20 images and 20 MiB decoded
 * in total is a local product decision. The subscription endpoint
 * cli-chat-proxy.grok.com/v1/responses is UNMEASURED for images: these limits
 * are not an upstream capability fact for it.
 *
 * There is no dimension or pixel limit. Dimensions are read only to validate
 * the container.
 */

const GROK_VISUAL_LIMITS = Object.freeze({
  maxImages: 20,
  maxImageBytes: 20971520,
  maxTotalImageBytes: 20971520,
})

// Encoded length of the whole decoded image budget as canonical base64. The
// contract sizes the V2 envelope from it.
const MAX_ENCODED_TOTAL_IMAGE_BYTES = 4 * Math.ceil(GROK_VISUAL_LIMITS.maxTotalImageBytes / 3)

module.exports = {
  GROK_VISUAL_LIMITS,
  MAX_ENCODED_TOTAL_IMAGE_BYTES,
}
