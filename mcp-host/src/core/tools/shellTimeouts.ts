/** Grace period between SIGTERM and SIGKILL for a timed-out shell process group. */
export const SHELL_SIGKILL_GRACE_MS = 5000

/**
 * Interval at which a shell whose leader exited without a cause checks whether
 * its process group is gone. When two consecutive checks find the group gone and
 * stdout/stderr are still held open by a process outside it, output capture stops
 * and the call settles. One check is not enough: the last in-group writer's pipe
 * EOF can still be in flight when its group disappears.
 */
export const SHELL_STDIO_DRAIN_MS = 1000

/**
 * Cleanup budget the shell declares after its deadline: the SIGKILL grace plus
 * one drain interval for close/output delivery. When `close` has not arrived by
 * then, the shell stops output capture and settles even if a process outside
 * its group still holds the pipes. executeWithTimeout does not arm a cleanup
 * timer for the shell, because the shell joins abort settlement and owns its
 * own process-group termination; the budget is only reserved by
 * executeWithTimeout's check that timeout + cleanup stays within the largest
 * delay a Node.js timer accepts, so a configured timeout must leave room for
 * it (#1021).
 */
export const SHELL_TIMEOUT_CLEANUP_MS = SHELL_SIGKILL_GRACE_MS + SHELL_STDIO_DRAIN_MS
