export const COMPOSER_MAX_IMAGE_ATTACHMENTS = 3
/**
 * Composer image budget. These mirror the server-side chat body budget shared by
 * rpc-proxy and mcp-host (10MiB per image, 3 images / 15MiB of image bytes in a
 * 24MiB JSON body), so an image the composer accepts is also one the runtime
 * will carry. Change them together with that budget.
 */
export const COMPOSER_MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const COMPOSER_MAX_TOTAL_IMAGE_BYTES = 15 * 1024 * 1024
export const COMPOSER_ACCEPT_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png'] as const
export const ZAI_IMAGE_ATTACHMENT_UNSUPPORTED_MESSAGE =
  'Image attachments are not supported for agents running on Z AI yet. Switch this agent to a provider with image input support before attaching images.'
