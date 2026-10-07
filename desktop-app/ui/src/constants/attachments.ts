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
 * their own quota in rpc-proxy and mcp-host (16 MiB decoded, up to the 24 MiB
 * request body); this is the composer's product ceiling for them and is
 * stricter than that quota.
 */
export const COMPOSER_MAX_TOTAL_IMAGE_BASE64_BYTES = 8 * 1024 * 1024

/**
 * Codex-only (#650) per-image ceiling. Must match `MAX_IMAGE_DECODED_BYTES` in
 * `rpc-proxy/src/middleware/chatJsonBody.ts` and in `mcp-host/src/server.ts`.
 */
export const CODEX_COMPOSER_MAX_IMAGE_BYTES = 16 * 1024 * 1024
/**
 * Codex-only (#650) combined size of the images in one message, counted as
 * their decoded bytes. rpc-proxy and mcp-host sum the decoded bytes of every
 * image and refuse the request above this, so the composer refuses the image
 * first. Must match `MAX_IMAGE_DECODED_BYTES_TOTAL` in
 * `rpc-proxy/src/middleware/chatJsonBody.ts` and in `mcp-host/src/server.ts`.
 */
export const CODEX_COMPOSER_MAX_TOTAL_IMAGE_DECODED_BYTES = 16 * 1024 * 1024
/** Official Codex client long-side bound. The Codex hop 400s frames above this. */
export const CODEX_COMPOSER_MAX_IMAGE_DIMENSION = 2048

/**
 * Grok-only (#784) per-image ceiling. xAI allows 20 MiB per image, but a
 * composer image crosses the shared ingress (rpc-proxy and mcp-host), which
 * caps each image and the message total at 16 MiB decoded. This is that cap,
 * not the xAI limit; only tool screenshots can use the contract's 20 MiB.
 */
export const GROK_COMPOSER_MAX_IMAGE_BYTES = 16 * 1024 * 1024
export const COMPOSER_ACCEPT_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png'] as const

export const CODEX_SUBSCRIPTION_PROVIDER = 'codex-subscription'
export const GROK_SUBSCRIPTION_PROVIDER = 'grok-subscription'

/**
 * The composer aggregate one message must fit in. The general branch sums and
 * names base64 MB (#669). Codex and Grok sum the decoded bytes of each image,
 * which is what the shared 16 MiB ingress total counts (#650, #784).
 */
export type ComposerImageTotalBudget = {
  /** What the composer sums: base64 characters or decoded image bytes. */
  counts: 'base64' | 'decoded'
  /** Limit on that sum, in the unit named by `counts`. */
  maxBytes: number
  /** Bytes the total-limit copy names. */
  labelBytes: number
}

/** Bytes one attachment adds to the sum the budget's `counts` names. */
export function composerImageCountedBytes(
  total: ComposerImageTotalBudget,
  attachment: { dataBase64: string; sizeBytes: number }
): number {
  return total.counts === 'base64' ? attachment.dataBase64.length : attachment.sizeBytes
}

export type ComposerImageBudget = {
  maxImageBytes: number
  /** `null` → no composer aggregate. */
  total: ComposerImageTotalBudget | null
  /** `null` → no composer pixel bound (Grok and general models). */
  maxDimension: number | null
  sizeUnit: 'MB' | 'MiB'
}

/**
 * Product limits for the picker. Codex keeps #650 and the decoded ingress
 * total, Grok gets the shared ingress cap with no pixel bound (#784), everyone
 * else keeps #669.
 */
export function composerImageBudget(provider: string | null | undefined): ComposerImageBudget {
  if (provider === CODEX_SUBSCRIPTION_PROVIDER) {
    return {
      maxImageBytes: CODEX_COMPOSER_MAX_IMAGE_BYTES,
      total: {
        counts: 'decoded',
        maxBytes: CODEX_COMPOSER_MAX_TOTAL_IMAGE_DECODED_BYTES,
        labelBytes: CODEX_COMPOSER_MAX_TOTAL_IMAGE_DECODED_BYTES,
      },
      maxDimension: CODEX_COMPOSER_MAX_IMAGE_DIMENSION,
      sizeUnit: 'MiB',
    }
  }
  if (provider === GROK_SUBSCRIPTION_PROVIDER) {
    return {
      maxImageBytes: GROK_COMPOSER_MAX_IMAGE_BYTES,
      total: {
        counts: 'decoded',
        maxBytes: GROK_COMPOSER_MAX_IMAGE_BYTES,
        labelBytes: GROK_COMPOSER_MAX_IMAGE_BYTES,
      },
      maxDimension: null,
      sizeUnit: 'MiB',
    }
  }
  return {
    maxImageBytes: COMPOSER_MAX_IMAGE_BYTES,
    total: {
      counts: 'base64',
      maxBytes: COMPOSER_MAX_TOTAL_IMAGE_BASE64_BYTES,
      labelBytes: COMPOSER_MAX_TOTAL_IMAGE_BASE64_BYTES,
    },
    maxDimension: null,
    sizeUnit: 'MB',
  }
}
