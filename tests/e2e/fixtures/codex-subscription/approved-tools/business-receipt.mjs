// Business receipt contract shared by the approved-tools fixtures. The MCP
// fixture server creates the receipt, the workflow fixture persists it as its
// result artifact, and the fixture models
// (codex-llm-proxy/test/approvedToolsUpstream.ts and
// grok-llm-proxy/test/approvedToolsUpstream.ts) read it back from the Host.
// One definition keeps them from drifting apart.

export const RECEIPT_TOOL = 'workitem_read_receipt'

const FIELDS = ['businessId', 'callId', 'runId', 'tool']
const RUN_ID = /^[a-zA-Z0-9_-]{1,128}$/
const TOOL = /^[a-zA-Z0-9_]{1,128}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MAX_STRING_ID_LENGTH = 128

/**
 * A JSON-RPC request id this fixture accepts: a non-empty string of at most
 * 128 characters, or a safe integer. The MCP SDK client numbers its requests
 * with integers; other clients send strings. `null` is rejected.
 */
export function isJsonRpcRequestId(value) {
  return (
    (typeof value === 'string' && value.length > 0 && value.length <= MAX_STRING_ID_LENGTH) ||
    Number.isSafeInteger(value)
  )
}

/**
 * Names the first contract violation of `value`, or returns null.
 *
 * - `mcp`: the receipt exactly as the MCP fixture server records and returns
 *   it. Only the four fields; `callId` is the JSON-RPC request id of the
 *   `tools/call` that created it, so an integer or a string.
 * - `host-workflow-result`: the receipt the workflow fixture reads and
 *   persists as the artifact the Host's `workflow_result` returns. The
 *   workflow fixture issues its own requests with UUID ids, so `callId` is a
 *   UUID string. Extra remote fields are tolerated here because the workflow
 *   fixture projects the four fields before persisting.
 */
export function businessReceiptProblem(value, context) {
  if (context !== 'mcp' && context !== 'host-workflow-result')
    throw new Error('unknown_receipt_context')
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'receipt_not_object'
  if (context === 'mcp' && Object.keys(value).sort().join() !== FIELDS.join())
    return 'receipt_fields_mismatch'
  if (typeof value.runId !== 'string' || !RUN_ID.test(value.runId)) return 'invalid_run_id'
  if (typeof value.tool !== 'string' || !TOOL.test(value.tool)) return 'invalid_tool'
  const callId =
    context === 'mcp'
      ? isJsonRpcRequestId(value.callId)
      : typeof value.callId === 'string' && UUID.test(value.callId)
  if (!callId) return 'invalid_call_id'
  if (typeof value.businessId !== 'string' || !UUID.test(value.businessId))
    return 'invalid_business_id'
  return null
}

/** Builds an `mcp` receipt, failing on any contract violation. */
export function createBusinessReceipt({ runId, tool, callId, businessId }) {
  const receipt = { runId, tool, callId, businessId }
  const problem = businessReceiptProblem(receipt, 'mcp')
  if (problem) throw new Error(problem)
  return receipt
}
