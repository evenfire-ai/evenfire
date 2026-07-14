export const HTML_PREVIEW_INLINE_MAX_BYTES = 256 * 1024
export const HTML_PREVIEW_ARTIFACT_MAX_BYTES = 768 * 1024
export const HTML_PREVIEW_TIMEOUT_MS = 4000
export const HTML_PREVIEW_SOURCE_MAX_CHARS = 12000

const activePreviewFlag = String(import.meta.env.VITE_ENABLE_ACTIVE_HTML_PREVIEW || '').trim()
export const HTML_PREVIEW_ALLOW_ACTIVE_MODE = /^true$/i.test(activePreviewFlag)

export const HTML_PREVIEW_SAFE_SANDBOX = ''
export const HTML_PREVIEW_ACTIVE_SANDBOX = 'allow-scripts allow-forms'
