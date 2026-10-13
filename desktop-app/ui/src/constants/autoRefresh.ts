/**
 * Bounded staleness for surfaces that show server catalogs which can change
 * mid-session (#991). Opening the surface, or regaining window focus, refreshes
 * once the cache is older than `AUTO_REFRESH_STALE_AFTER_MS`; while it stays
 * visible a refresh starts every `AUTO_REFRESH_POLL_INTERVAL_MS`, measured from
 * the START of the previous run.
 */
export const AUTO_REFRESH_STALE_AFTER_MS = 15_000
export const AUTO_REFRESH_POLL_INTERVAL_MS = 60_000
