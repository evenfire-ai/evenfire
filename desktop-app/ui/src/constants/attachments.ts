// Must match INCOMING_IMAGE_MAX_COUNT in mcp-host/src/agent/incomingImageAttachments.ts.
export const COMPOSER_MAX_IMAGE_ATTACHMENTS = 20
export const COMPOSER_MAX_IMAGE_BYTES = 3 * 1024 * 1024
/**
 * Combined base64 size of the images in one message. rpc-proxy and mcp-host
 * parse the message JSON with a 10 MB body limit, and the images travel inline
 * in that body; 2 MB is left for the text and the request envelope. 10 MB is
 * also the smallest documented provider request limit (Cerebras, 10 MiB), and
 * mcp-host forwards the images inline to the model.
 */
export const COMPOSER_MAX_TOTAL_IMAGE_BASE64_BYTES = 8 * 1024 * 1024
export const COMPOSER_ACCEPT_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png'] as const
