import type {
  ScopedMember,
  ScopedMemberContextDetails,
  ScopedMemberMe,
  ScopedMemberTeamRow,
} from './scopedMembers.types'

/**
 * Pure projection of the members visible for an agent's mapped context (spec
 * §5.C Members tab). Moved verbatim from `ContextDetailsPage.scopedMembers`:
 *
 *  - self is included when `availableToUser` (label falls back email → userId);
 *  - every member of the mapped teams is included when `availableToTeam`;
 *  - the result is deduplicated by id, first writer wins (so the self row, which
 *    is pushed first, survives when the same person is also a team member).
 *
 * A3 invariant: `contextDetails === null` (the agent has no mapped context)
 * yields `[]` and never throws.
 */
export function deriveScopedMembers(
  contextDetails: ScopedMemberContextDetails,
  teamRows: ScopedMemberTeamRow[],
  me: ScopedMemberMe
): ScopedMember[] {
  if (!contextDetails) return []

  const rows: ScopedMember[] = []

  if (contextDetails.availableToUser) {
    rows.push({
      id: contextDetails.userId,
      label: me?.name || me?.email || contextDetails.userId,
      ...(me?.name && me?.email ? { secondary: me.email } : {}),
      role: 'user',
    })
  }

  if (contextDetails.availableToTeam) {
    for (const teamRow of teamRows) {
      for (const member of teamRow.members) {
        rows.push({
          id: member.id,
          label: member.name || member.email,
          ...(member.name ? { secondary: member.email } : {}),
          role: member.role,
        })
      }
    }
  }

  const deduped = new Map<string, ScopedMember>()
  for (const item of rows) {
    if (!deduped.has(item.id)) deduped.set(item.id, item)
  }
  return [...deduped.values()]
}
