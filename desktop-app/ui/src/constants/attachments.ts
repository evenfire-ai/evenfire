export const COMPOSER_MAX_IMAGE_ATTACHMENTS = 3
/**
 * Composer hard image budget. Mirrors rpc-proxy / mcp-host hop credit: 16MiB
 * per image and 16MiB total in a 24MiB JSON body so a poorly compressed 2048
 * PNG may exceed 10MiB. The usual product target is 5 / 9 / 14 MiB.
 */
export const COMPOSER_MAX_IMAGE_BYTES = 16 * 1024 * 1024
export const COMPOSER_MAX_TOTAL_IMAGE_BYTES = 16 * 1024 * 1024
export const COMPOSER_ACCEPT_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png'] as const
export const ZAI_IMAGE_ATTACHMENT_UNSUPPORTED_MESSAGE =
  'Image attachments are not supported for agents running on Z AI yet. Switch this agent to a provider with image input support before attaching images.'
