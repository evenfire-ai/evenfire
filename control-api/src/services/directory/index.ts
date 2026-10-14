/** Control-plane directory: users, teams, membership, invites, context/agent access. */
export type { AdminDeleteTeamResult, AdminDeleteUserResult } from './types.js'

export { googleLoginData, passwordLoginData, verifyUserPassword } from './login.js'

export {
  adminDeleteUser,
  createAdminUser,
  DesktopUserRetirementError,
  getAdminUserContext,
  listUsers,
  retireDesktopUser,
  updateAdminUserContext,
} from './users.js'
export type {
  DesktopUserRetirementActor,
  DesktopUserRetirementErrorCode,
  DesktopUserRetirementOutcome,
  RetireDesktopUserResult,
} from './users.js'

export {
  adminDeleteTeam,
  createTeam,
  createTeamForUser,
  getCurrentTeam,
  getTeamById,
  listAllTeams,
  listTeams,
  renameTeam,
} from './teams.js'

export {
  acceptInvitation,
  acceptInvitationById,
  acceptInvitationForEmail,
  getInvitationByToken,
  addMemberToTeam,
  createPasswordSetupInvitationForUser,
  createInvitation,
  createInvitationForTeams,
  createSilentInvitationForTeams,
  createManagedInvitationForUser,
  deleteManagedMemberForUser,
  deleteManagedUserForUser,
  findMemberRole,
  getPendingMemberInvitationForEmail,
  listPendingInvitationsForTeam,
  listAllPendingInvitationsAdmin,
  listManageableTeamsForUser,
  listManagedMembersForUser,
  listManagedPendingInvitationsForUser,
  resendInvitation,
  resendManagedInvitationForUser,
  requestProfilePasswordReset,
  revokeManagedInvitationForUser,
  revokePendingInvitation,
  findMembership,
  getMe,
  listMembers,
  listPendingInvitations,
  searchDirectory,
  softDeleteMember,
  startDraftInvitationCleanup,
  stopDraftInvitationCleanup,
  updateManagedMemberRoleForUser,
  updateMemberRole,
  updateProfile,
} from './membership.js'
export {
  setInvitationPasswordForUser,
  setInvitationPasswordForEmail,
  updateUserPassword,
} from './memberPassword.js'
export { withPasswordWorkLease as withMemberPasswordWorkLease } from '../auth/passwordWorkOwnership.js'
export type { MemberPasswordWorkLease } from '../auth/passwordWorkOwnership.js'

export {
  getTeamContexts,
  getUserContexts,
  listTeamContextsByTeam,
  listTeamsByContext,
  listUsersByContext,
  setTeamContexts,
  setUserContexts,
} from './contextAccess.js'

export {
  AgentGrantPreconditionError,
  getTeamAgents,
  getUserAgents,
  listTeamAgentsByTeam,
  listTeamsByAgent,
  listUsersByAgent,
  setAgentTeams,
  setAgentUsers,
  setTeamAgents,
  setUserAgents,
} from './agentAccess.js'

export {
  listTeamWorkflowGrants,
  listWorkflowGrants,
  setTeamWorkflowGrants,
  setWorkflowGrants,
} from './workflowGrants.js'
export type { WorkflowGrantTeam, WorkflowGrantUser } from './workflowGrants.js'

export * from './adminProvisioning.js'
