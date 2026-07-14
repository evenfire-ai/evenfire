/**
 * MIME type map for artifact download endpoints.
 *
 * Shared between host artifact download and recipe artifact download routes.
 * Falls back to application/octet-stream for unknown extensions.
 */
export const CONTENT_TYPES: Record<string, string> = {
  md: "text/markdown",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  html: "text/html",
  txt: "text/plain",
};
