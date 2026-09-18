// Must match INCOMING_IMAGE_MAX_COUNT in mcp-host/src/agent/incomingImageAttachments.ts.
export const COMPOSER_MAX_IMAGE_ATTACHMENTS = 20
/**
 * Composer per-image ceiling. The 16 MiB aggregate lives on the rpc-proxy /
 * mcp-host hop and the shared contract, not in this picker. A poorly
 * compressed 2048 PNG may exceed 10 MiB and must still attach here.
 */
export const COMPOSER_MAX_IMAGE_BYTES = 16 * 1024 * 1024
/** Official Codex client long-side bound. The hop 400s frames above this. */
export const COMPOSER_MAX_IMAGE_DIMENSION = 2048
export const COMPOSER_ACCEPT_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png'] as const
