import type { TeamMember } from '../../../src/types'

/**
 * The context-detail fields the Members projection needs. A trivial in-component
 * projection of AccessCatalog (`userContextIds.includes(ref)` →
 * `availableToUser`, etc.), so it is built inline by the caller — not another
 * layer's serialized output. `null` when the agent has no mapped context.
 */
export type ScopedMemberContextDetails = {
  availableToUser: boolean
  availableToTeam: boolean
  userId: string
} | null

/** A team whose directory entry maps the context; only its members are read. */
export type ScopedMemberTeamRow = {
  members: TeamMember[]
}

/** The `me` fields the self row needs (a subset of `SessionMe`). */
export type ScopedMemberMe = {
  name?: string | null
  email?: string | null
} | null

export type ScopedMember = {
  id: string
  label: string
  secondary?: string
  role: string
}
