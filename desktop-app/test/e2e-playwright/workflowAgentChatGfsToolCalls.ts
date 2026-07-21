export type WorkflowToolCall = {
  args?: Record<string, unknown>
  result?: { content?: string; error?: string; success?: boolean }
  serverName?: string
  toolName?: string
}

export function singleSuccessfulToolCall(calls: WorkflowToolCall[]): {
  rejected: WorkflowToolCall[]
  successful: WorkflowToolCall
} {
  const successful = calls.filter(call => call.result?.success === true)
  const rejected = calls.filter(call => call.result?.success === false)

  if (successful.length !== 1) {
    throw new Error(`expected exactly one successful tool call, received ${successful.length}`)
  }
  if (successful.length + rejected.length !== calls.length) {
    throw new Error('every recorded tool call must have an explicit success result')
  }

  return { rejected, successful: successful[0]! }
}
