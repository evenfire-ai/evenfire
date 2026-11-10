export class WorkflowSDKInitError extends Error {
  constructor(envVar: string) {
    super(
      `Required environment variable ${envVar} is not set. ` +
        `Ensure WRC injects all required env vars at Pod creation time.`
    )
    this.name = 'WorkflowSDKInitError'
  }
}

export class CycleDetectedError extends Error {
  readonly cyclePath: string[]

  constructor(cyclePath: string[]) {
    super(`Dependency cycle detected in step graph: ${cyclePath.join(' → ')}`)
    this.name = 'CycleDetectedError'
    this.cyclePath = cyclePath
  }
}

export class McpHostNotConfiguredError extends Error {
  constructor() {
    super(
      'McpHostClient is not configured. Set CLERUM_MCPHOST_URL and MCP_HOST_TOKEN_FILE ' +
        'environment variables to enable agent step execution.'
    )
    this.name = 'McpHostNotConfiguredError'
  }
}

/** A protected workflow boundary is waiting for an explicit authority resume. */
export class WorkflowAuthorizationPausedError extends Error {
  constructor() {
    super('workflow_authorization_paused')
    this.name = 'WorkflowAuthorizationPausedError'
  }
}

/**
 * WRC answered the last attempt of a status report with 503
 * `workflow_run_state_unavailable`: it could not reach its workflow run store
 * to checkpoint a running boundary, so it answered neither allowed nor paused.
 */
export class WorkflowRunStateUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowRunStateUnavailableError'
  }
}
