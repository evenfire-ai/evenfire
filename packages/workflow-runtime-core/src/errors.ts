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
