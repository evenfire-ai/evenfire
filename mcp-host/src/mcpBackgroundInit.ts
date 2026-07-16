/**
 * §3.14 (stateless agents) — Ready never waits for MCP.
 *
 * Production boot used to `await initializeMcpServers()` BEFORE the RPC
 * server opened, so the readiness route (`GET /v1/runtime/health`, probed by
 * the HCC-created Deployment) could not answer until every MCP server was
 * discovered and connected. This helper inverts that: the caller starts the
 * HTTP server first, then kicks off MCP discovery/connections here WITHOUT
 * awaiting them.
 *
 * Failure posture (fail-loud, self-healing): a failed initial attempt is
 * logged as an ERROR — never swallowed silently — and `afterInitialAttempt`
 * still runs, so the context-mapper reconciliation poll starts and repairs
 * the MCP catalog. The platform already tolerates the post-restart
 * 'connecting' sweep, so serving traffic before MCP lands is by design.
 */
export function startMcpInitializationInBackground(options: {
  /** Performs MCP discovery + connections (production: initializeMcpServers). */
  initialize: () => Promise<void>
  /**
   * Runs once the initial attempt SETTLES (success or logged failure) —
   * production wires startContextMapperPolling here so the reconciling poll
   * never races the initial discovery pass.
   */
  afterInitialAttempt: () => void
}): void {
  void options
    .initialize()
    .catch((err: unknown) => {
      console.error(
        '[Main] ERROR: initial MCP discovery/connect failed — pod stays Ready; ' +
          'context-mapper polling will reconcile the MCP catalog:',
        err
      )
    })
    .then(() => {
      options.afterInitialAttempt()
    })
}
