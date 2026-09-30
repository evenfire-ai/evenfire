/**
 * Images and files share one per-message count. Must match
 * INCOMING_ATTACHMENT_MAX_COUNT in mcp-host/src/agent/incomingAttachments.ts.
 */
export const COMPOSER_MAX_ATTACHMENTS = 20

/**
 * Per-file ceiling for a document sent as `kind:'file'`. Must match the
 * `CLERUM_ATTACHMENT_FILE_MAX_BYTES` default of mcp-host (`attachmentFileMaxBytes`)
 * and `MAX_FILE_DECODED_BYTES` in `rpc-proxy/src/middleware/chatJsonBody.ts` and
 * in `mcp-host/src/server.ts`.
 */
export const COMPOSER_MAX_FILE_BYTES = 11 * 1024 * 1024
/**
 * Combined base64 size of the files in one message. Files have their own quota
 * in rpc-proxy and mcp-host, like images. Must match
 * `MAX_FILE_BASE64_BYTES_TOTAL` in `rpc-proxy/src/middleware/chatJsonBody.ts`
 * and in `mcp-host/src/server.ts`.
 */
export const COMPOSER_MAX_TOTAL_FILE_BASE64_BYTES = 16 * 1024 * 1024
/**
 * Share of one chat request body that is credited to neither the image quota
 * nor the file quota: the text, the JSON envelope and every field of a
 * `kind:'file'` entry except its base64. Must match `MAX_NON_IMAGE_BODY_BYTES`
 * in `rpc-proxy/src/middleware/chatJsonBody.ts` and in `mcp-host/src/server.ts`.
 */
export const COMPOSER_MAX_NON_IMAGE_BODY_BYTES = 6 * 1024 * 1024
/**
 * Whole chat request body. Must match `MAX_CHAT_BODY_BYTES` in
 * `rpc-proxy/src/middleware/chatJsonBody.ts` and in `mcp-host/src/server.ts`.
 */
export const COMPOSER_MAX_REQUEST_BODY_BYTES = 24 * 1024 * 1024
/** JSON envelope around the text and the attachments: model, revision, keys. */
export const COMPOSER_REQUEST_ENVELOPE_BYTES = 4096
/**
 * Fields rpc-proxy adds to the Host request before mcp-host measures it
 * (`rpc-proxy/src/routes/rpc.ts`): `sender`, `messageId`, `metadata` and the
 * trace context, about 720 bytes at their largest.
 */
export const COMPOSER_FORWARDED_FIELDS_BYTES = 2048
/**
 * JSON around one `kind:'file'` entry besides its base64 and its filename:
 * the id, the two media types, the sha256 hex and the fixed keys.
 */
export const COMPOSER_FILE_ENTRY_METADATA_BYTES = 640

/**
 * General (#654 / PR #669) per-image ceiling for every image-capable model
 * that is not Codex.
 */
export const COMPOSER_MAX_IMAGE_BYTES = 3 * 1024 * 1024
/**
 * Combined base64 size of the images in one non-Codex message. Images have
 * their own quota in rpc-proxy and mcp-host (up to the 24 MiB request body);
 * this is the composer's product ceiling for them.
 */
export const COMPOSER_MAX_TOTAL_IMAGE_BASE64_BYTES = 8 * 1024 * 1024

/**
 * Codex-only (#650) per-image ceiling. The 16 MiB aggregate lives on the
 * Codex chat hop and the shared contract, not in this picker.
 */
export const CODEX_COMPOSER_MAX_IMAGE_BYTES = 16 * 1024 * 1024
/** Official Codex client long-side bound. The Codex hop 400s frames above this. */
export const CODEX_COMPOSER_MAX_IMAGE_DIMENSION = 2048

export const COMPOSER_ACCEPT_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png'] as const

export const CODEX_SUBSCRIPTION_PROVIDER = 'codex-subscription'

export type ComposerImageBudget = {
  maxImageBytes: number
  /** `null` → no composer aggregate; the Codex hop owns that ceiling. */
  maxTotalBase64Bytes: number | null
  /** `null` → no composer pixel bound (general models). */
  maxDimension: number | null
  sizeUnit: 'MB' | 'MiB'
}

/** Product limits for the picker. Codex keeps #650; everyone else keeps #669. */
export function composerImageBudget(provider: string | null | undefined): ComposerImageBudget {
  if (provider === CODEX_SUBSCRIPTION_PROVIDER) {
    return {
      maxImageBytes: CODEX_COMPOSER_MAX_IMAGE_BYTES,
      maxTotalBase64Bytes: null,
      maxDimension: CODEX_COMPOSER_MAX_IMAGE_DIMENSION,
      sizeUnit: 'MiB',
    }
  }
  return {
    maxImageBytes: COMPOSER_MAX_IMAGE_BYTES,
    maxTotalBase64Bytes: COMPOSER_MAX_TOTAL_IMAGE_BASE64_BYTES,
    maxDimension: null,
    sizeUnit: 'MB',
  }
}
