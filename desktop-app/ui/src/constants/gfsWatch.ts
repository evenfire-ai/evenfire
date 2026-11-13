/**
 * The watch list settles for this long before it is sent to main: only its
 * final state matters, and a key that enters late is covered by the `resync`
 * main emits for keys the stream had not covered yet.
 */
export const GFS_WATCH_DEBOUNCE_MS = 150

/**
 * Main keeps at most this many keys per stream (the GET line has to stay
 * under the ingress header buffer). The renderer trims to the same cap so the
 * keys it drops are the lowest-priority ones, not whichever main cuts.
 */
export const GFS_WATCH_MAX_KEYS = 64
