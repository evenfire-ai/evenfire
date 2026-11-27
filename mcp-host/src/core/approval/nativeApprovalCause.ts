import type { Tool } from '../interfaces'

export type NativeApprovalCause = 'none' | 'ordinary' | 'admin_forced'

/**
 * The gate cause for a native tool call, without suspending.
 *
 * - A `true` CRD override on the tool, or on any name its `approvalAlso(params)`
 *   returns, forces a card (`admin_forced`). An override on one tool never
 *   loosens another: only `true` is inherited.
 * - Otherwise the tool's own override wins over its code default, as before.
 *   A non-boolean override keeps the old rule: truthy asks, falsy runs.
 */
export function nativeApprovalCause(
  tool: Tool | null,
  toolName: string,
  params: Record<string, unknown>,
  tools: Readonly<Record<string, boolean>> | undefined
): NativeApprovalCause {
  // Truthiness, as the gate checked before: the approval config is parsed
  // without a shape check, so `tools` may be null at run time.
  const has = (name: string): boolean => Boolean(tools) && Object.hasOwn(tools!, name)
  const own = has(toolName) ? tools![toolName] : undefined
  if (own === true) return 'admin_forced'
  const also = tool?.approvalAlso?.(params) ?? []
  if (also.some(name => has(name) && tools![name] === true)) return 'admin_forced'
  const needsApproval = own ?? tool?.requiresApproval() ?? false
  return needsApproval ? 'ordinary' : 'none'
}
