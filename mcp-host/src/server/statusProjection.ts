import type { StatusResponse } from './types'

/**
 * Pending approvals as the Host status response lists them: one entry per
 * pending approval, carrying only when it started. The status route serves
 * every user of the Host, so it names no request, user, tool or parameters;
 * the approval owner reads those from the owner-scoped approval APIs.
 */
export function pendingApprovalsForStatus(
  agent: { getPendingApprovals(): ReadonlyArray<{ since: string }> } | null
): NonNullable<StatusResponse['pendingApprovals']> {
  return (agent?.getPendingApprovals() ?? []).map(({ since }) => ({ since }))
}
