/** Grace period between SIGTERM and SIGKILL for a timed-out shell process group. */
export const SHELL_SIGKILL_GRACE_MS = 5000

/**
 * Cleanup budget the shell declares after its deadline: the SIGKILL grace plus
 * 1s for close/output delivery. executeWithTimeout does not arm a cleanup timer
 * for the shell, because the shell joins abort settlement and owns its own
 * process-group termination; the budget is only reserved by executeWithTimeout's
 * check that timeout + cleanup stays within the largest delay a Node.js timer
 * accepts, so a configured timeout must leave room for it (#1021).
 */
export const SHELL_TIMEOUT_CLEANUP_MS = SHELL_SIGKILL_GRACE_MS + 1000
