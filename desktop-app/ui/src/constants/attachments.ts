// Must match INCOMING_IMAGE_MAX_COUNT in mcp-host/src/agent/incomingImageAttachments.ts.
export const COMPOSER_MAX_IMAGE_ATTACHMENTS = 20
export const COMPOSER_MAX_IMAGE_BYTES = 3 * 1024 * 1024
/**
 * Combined base64 size of the images in one message. rpc-proxy and mcp-host
 * parse the message JSON with a 6 MB body limit, and the images travel inline
 * in that body; 1 MB is left for the text and the request envelope.
 */
export const COMPOSER_MAX_TOTAL_IMAGE_BASE64_BYTES = 5 * 1024 * 1024
export const COMPOSER_ACCEPT_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png'] as const
