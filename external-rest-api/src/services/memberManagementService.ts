import { controlApiRequest } from '../controlApiClient.js'
import { TeamRole } from '../types.js'

export type ManageableTeam = {
  id: string
  name: string
  role: TeamRole
  canAssignLeader: boolean
}

export type ManagedMemberTeam = {
  id: string
  name: string
  role: TeamRole
  managerRole: TeamRole
  canEdit: boolean
  canDelete: boolean
}

export type ManagedMember = {
  id: string
  email: string
  name: string | null
  picture: string | null
  displayName: string | null
  teams: ManagedMemberTeam[]
}

export type ManagedPendingInvitation = {
  id: string
  email: string
  role: TeamRole
  status: string
  expiresAt: string
  teams: Array<{ id: string; name: string; role: TeamRole }>
  canCancel: boolean
  canResend: boolean
}

export type MemberInvitationAssignment = {
  teamId: string
  role: TeamRole
}

export async function listManageableTeams(sessionToken: string) {
  return controlApiRequest<{ items: ManageableTeam[] }>(
    'GET',
    '/external/members/manageable-teams',
    {
      userSessionToken: sessionToken,
    }
  )
}

export async function listManagedMembers(sessionToken: string) {
  return controlApiRequest<{ items: ManagedMember[] }>('GET', '/external/members', {
    userSessionToken: sessionToken,
  })
}

export async function getManagedMember(userId: string, sessionToken: string) {
  return controlApiRequest<ManagedMember>('GET', `/external/members/${userId}`, {
    userSessionToken: sessionToken,
  })
}

export async function listManagedInvitations(sessionToken: string) {
  return controlApiRequest<{ items: ManagedPendingInvitation[] }>(
    'GET',
    '/external/members/invitations',
    {
      userSessionToken: sessionToken,
    }
  )
}

export async function inviteManagedMember(
  email: string,
  name: string,
  teams: MemberInvitationAssignment[],
  sessionToken: string
) {
  return controlApiRequest<unknown>('POST', '/external/members/invitations', {
    body: {
      email,
      name,
      teams,
    },
    userSessionToken: sessionToken,
  })
}

export async function updateManagedMemberRole(
  userId: string,
  teamId: string,
  role: TeamRole,
  sessionToken: string
) {
  return controlApiRequest<unknown>('PATCH', `/external/members/${userId}/teams/${teamId}/role`, {
    body: { role },
    userSessionToken: sessionToken,
  })
}

export async function deleteManagedMember(userId: string, teamId: string, sessionToken: string) {
  return controlApiRequest<unknown>('DELETE', `/external/members/${userId}/teams/${teamId}`, {
    userSessionToken: sessionToken,
  })
}

export async function deleteManagedUser(userId: string, sessionToken: string) {
  return controlApiRequest<unknown>('DELETE', `/external/members/${userId}`, {
    userSessionToken: sessionToken,
  })
}

export async function resendManagedInvitation(invitationId: string, sessionToken: string) {
  return controlApiRequest<unknown>(
    'POST',
    `/external/members/invitations/${invitationId}/resend`,
    {
      userSessionToken: sessionToken,
    }
  )
}

export async function cancelManagedInvitation(invitationId: string, sessionToken: string) {
  return controlApiRequest<unknown>('DELETE', `/external/members/invitations/${invitationId}`, {
    userSessionToken: sessionToken,
  })
}
