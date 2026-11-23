// Grammar of a Host tool-approval button value: `tool:<code>:<token>`.
// channel-reader mints these buttons (one of the codes a, l, d, c, s, and a
// 16-character base64url action token); this reader only recognizes them.
const TOOL_APPROVAL_ACTION_RE = /^tool:[aldcs]:[A-Za-z0-9_-]{16}$/

/** True when `value` is a tool-approval button value, on any medium. */
export function isToolApprovalActionValue(value: string): boolean {
  return TOOL_APPROVAL_ACTION_RE.test(value)
}
