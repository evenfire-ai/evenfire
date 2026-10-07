/** Grace period between SIGTERM and SIGKILL for a timed-out shell process group. */
export const SHELL_SIGKILL_GRACE_MS = 5000

/**
 * Bounded termination and result collection after a shell deadline: the
 * SIGKILL grace plus 1s for close/output delivery. executeWithTimeout adds it to
 * the execution deadline, so a configured timeout must leave room for it below
 * the largest delay a Node.js timer accepts (#1021).
 */
export const SHELL_TIMEOUT_CLEANUP_MS = SHELL_SIGKILL_GRACE_MS + 1000
