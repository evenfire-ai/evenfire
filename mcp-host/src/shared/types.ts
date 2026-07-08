/**
 * Shared type definitions.
 *
 * These types are used across multiple services (channel-reader, mcp-host).
 * In a future refactoring, these should be moved to a shared npm package.
 */

/**
 * Attachment metadata for images and workflow artifact files.
 */
export interface Attachment {
  /** Unique identifier for this attachment */
  id: string

  /** Attachment kind */
  kind: 'image' | 'file'

  /** MIME type */
  mimeType: string

  /** Encoding - always "base64" for now */
  encoding: 'base64'

  /** Base64-encoded data */
  dataBase64: string

  /** Optional filename for download/reference */
  filename?: string

  /** Optional caption/alt text */
  caption?: string

  /** Image width in pixels (if available) */
  width?: number

  /** Image height in pixels (if available) */
  height?: number

  /** Source MCP tool that generated this attachment */
  sourceTool?: string
}

/**
 * Validation result for attachment arrays.
 */
export interface AttachmentValidationResult {
  /** Validated attachments within limits */
  valid: Attachment[]

  /** Count of dropped attachments */
  dropped: number

  /** Total decoded bytes of valid attachments */
  totalBytes: number
}

/**
 * Configuration for attachment limits.
 */
export interface AttachmentLimits {
  /** Maximum number of attachments per response */
  maxCount: number

  /** Maximum decoded bytes per attachment */
  maxBytes: number

  /** Allowed MIME types */
  allowedMimeTypes: readonly string[]

  /** Allowed encodings */
  allowedEncodings: readonly string[]
}

/**
 * Default attachment limits.
 */
export const DEFAULT_ATTACHMENT_LIMITS: AttachmentLimits = {
  maxCount: 3,
  maxBytes: 52_428_800, // 50MB
  allowedMimeTypes: [
    'image/jpeg',
    'application/json',
    'text/plain',
    'text/markdown',
    'text/csv',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ] as const,
  allowedEncodings: ['base64'] as const,
} as const
