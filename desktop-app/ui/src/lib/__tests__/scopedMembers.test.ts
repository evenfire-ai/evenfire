import { describe, expect, it } from 'vitest'
import type { SessionMe, TeamMember } from '../../../../src/types'
import { deriveScopedMembers } from '../scopedMembers'
import type { ScopedMemberContextDetails, ScopedMemberTeamRow } from '../scopedMembers.types'

// The `me` and team-member shapes come from other layers (session + team
// directory), so the fixtures are typed against their real producer types
// (`SessionMe`, `TeamMember`) — TS enforces the shape the layers actually emit.
// `contextDetails` is NOT another layer's serialized output: it is a trivial
// in-component projection of AccessCatalog fields (userContextIds.includes(ref)
// etc.), so it is constructed by hand, minimally.
const ME: SessionMe = {
  id: 'user-1',
  email: 'demo@example.com',
  name: 'Demo User',
  picture: null,
  teamId: 'team-1',
  teamName: 'Core Team',
  role: 'member',
}

const ALICE: TeamMember = {
  id: 'member-1',
  email: 'alice@example.com',
  name: 'Alice',
  role: 'member',
  status: 'active',
}

const teamRow = (members: TeamMember[]): ScopedMemberTeamRow => ({ members })

describe('deriveScopedMembers', () => {
  it('(a) includes self when availableToUser (name label, email secondary)', () => {
    const details: ScopedMemberContextDetails = {
      availableToUser: true,
      availableToTeam: false,
      userId: 'user-1',
    }
    const result = deriveScopedMembers(details, [], ME)
    expect(result).toEqual([
      { id: 'user-1', label: 'Demo User', secondary: 'demo@example.com', role: 'user' },
    ])
  })

  it('(a2) omits self when availableToUser is false', () => {
    const details: ScopedMemberContextDetails = {
      availableToUser: false,
      availableToTeam: false,
      userId: 'user-1',
    }
    expect(deriveScopedMembers(details, [], ME)).toEqual([])
  })

  it('(b) includes team members when availableToTeam', () => {
    const details: ScopedMemberContextDetails = {
      availableToUser: false,
      availableToTeam: true,
      userId: 'user-1',
    }
    const result = deriveScopedMembers(details, [teamRow([ALICE])], ME)
    expect(result).toEqual([
      { id: 'member-1', label: 'Alice', secondary: 'alice@example.com', role: 'member' },
    ])
  })

  it('(b2) omits team members when availableToTeam is false', () => {
    const details: ScopedMemberContextDetails = {
      availableToUser: false,
      availableToTeam: false,
      userId: 'user-1',
    }
    expect(deriveScopedMembers(details, [teamRow([ALICE])], ME)).toEqual([])
  })

  it('(c) dedupes by id (self also present as a team member => one row)', () => {
    const selfAsMember: TeamMember = {
      id: 'user-1',
      email: 'demo@example.com',
      name: 'Demo User',
      role: 'admin',
      status: 'active',
    }
    const details: ScopedMemberContextDetails = {
      availableToUser: true,
      availableToTeam: true,
      userId: 'user-1',
    }
    const result = deriveScopedMembers(details, [teamRow([selfAsMember, ALICE])], ME)
    expect(result.map(row => row.id)).toEqual(['user-1', 'member-1'])
    // First writer wins: the self row (role 'user') survives the dedupe.
    expect(result[0]).toEqual({
      id: 'user-1',
      label: 'Demo User',
      secondary: 'demo@example.com',
      role: 'user',
    })
  })

  it('(d) contextDetails === null yields [] and does not throw (A3 invariant)', () => {
    expect(() => deriveScopedMembers(null, [teamRow([ALICE])], ME)).not.toThrow()
    expect(deriveScopedMembers(null, [teamRow([ALICE])], ME)).toEqual([])
    expect(deriveScopedMembers(null, [], null)).toEqual([])
  })

  it('falls back to email then userId for the self label when name/email missing', () => {
    const noName: SessionMe = { ...ME, name: null }
    expect(
      deriveScopedMembers(
        { availableToUser: true, availableToTeam: false, userId: 'user-1' },
        [],
        noName
      )
    ).toEqual([{ id: 'user-1', label: 'demo@example.com', role: 'user' }])

    const noMe = deriveScopedMembers(
      { availableToUser: true, availableToTeam: false, userId: 'user-1' },
      [],
      null
    )
    expect(noMe).toEqual([{ id: 'user-1', label: 'user-1', role: 'user' }])
  })
})
