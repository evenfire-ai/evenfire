import type { Tool } from '../interfaces'

export type NativeApprovalCause = 'none' | 'ordinary' | 'admin_forced'

/**
 * A grant of the key tool's name doesn't cover the listed tools; a grant of a
 * listed tool covers the key tool. A task or "always" `shell_exec` grant runs
 * `git_read`, which reads less than an approved shell; the reverse never holds.
 */
export const GRANT_COVERED_BY: Readonly<Record<string, readonly string[]>> = {
  git_read: ['shell_exec'],
}

/** The tool's own name, then every name whose grant covers it. */
export function grantNames(toolName: string): readonly string[] {
  return [toolName, ...(GRANT_COVERED_BY[toolName] ?? [])]
}

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
  const has = (name: string): boolean => tools !== undefined && Object.hasOwn(tools, name)
  const own = has(toolName) ? tools![toolName] : undefined
  if (own === true) return 'admin_forced'
  const also = tool?.approvalAlso?.(params) ?? []
  if (also.some(name => has(name) && tools![name] === true)) return 'admin_forced'
  const needsApproval = own ?? tool?.requiresApproval() ?? false
  return needsApproval ? 'ordinary' : 'none'
}
