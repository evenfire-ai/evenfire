export const METADATA_READ_TTL_MS = 30_000
export const METADATA_READ_CACHE_MAX_ENTRIES = 128
export const METADATA_READ_MAX_RECOVERY_ATTEMPTS = 1
// A server denial without valid timing still gets one bounded delayed read.
export const METADATA_READ_UNTIMED_COOLDOWN_MS = 1_000
export const CONTROL_UI_SESSION_INVALIDATION_EVENT = 'control-ui-session-invalidation'
