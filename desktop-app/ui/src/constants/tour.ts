/** Persisted once per desktop installation, never per environment or per user. */
export const TOUR_SEEN_STORAGE_KEY = 'clerum.ui.tourSeen'

/**
 * How long the tour waits for the access catalog before opening anyway.
 *
 * A floor, not a cap: the tour opens as soon as the catalog settles, and only
 * falls back to this if it does not. Opening early would collapse the deck to
 * the three-step tour designed for a user with no agents, and show it to
 * everyone.
 */
export const TOUR_CATALOG_GRACE_MS = 2_000

/**
 * Welcome + at most this many middle steps + Handoff, so a tour runs between
 * three steps (nothing qualifies but Desktop) and six.
 */
export const TOUR_MAX_MIDDLE_STEPS = 4
