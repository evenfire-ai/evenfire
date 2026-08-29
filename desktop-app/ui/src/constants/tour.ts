/** Persisted once per desktop installation, never per environment or per user. */
export const TOUR_SEEN_STORAGE_KEY = 'clerum.ui.tourSeen'

/**
 * Dev switch for reviewing the tour, which is otherwise shown once and then
 * never again on this machine. Defaults to false; only the exact string "true"
 * enables it.
 *
 * A renderer-side Vite flag rather than a main-process variable, following
 * `agentFeatures.ts`: the tour adds no IPC and changes nothing in
 * `desktop-app/src`, and reading an env var through a new bridge would give up
 * that guarantee just to make a dev affordance work.
 *
 * When on, the seen flag is neither read nor written, so previewing the tour
 * leaves no trace and does not consume a real user's one showing.
 */
export const TOUR_PREVIEW = /^true$/i.test(
  String(import.meta.env.VITE_EVENFIRE_TOUR_PREVIEW || '').trim()
)

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
 * Welcome + at most this many middle steps + Handoff.
 *
 * Four of the middle candidates are unconditional, so every tour is exactly six
 * steps long; the census decides which cards fill the middle, not how many.
 */
export const TOUR_MAX_MIDDLE_STEPS = 4
