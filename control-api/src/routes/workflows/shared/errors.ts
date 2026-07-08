import { ApprovalConsumeError } from '../../../services/userApprovalRequestService.js'

export function approvalConsumeHttpStatus(err: ApprovalConsumeError): number {
  switch (err.code) {
    case 'approval_request_not_found':
      return 404
    case 'approval_recipe_mismatch':
    case 'approval_trigger_binding_mismatch':
    case 'approval_target_user_mismatch':
    case 'approval_requester_mismatch':
    case 'approval_target_missing':
    case 'approval_trigger_grant_missing':
    case 'approval_target_not_allowed':
    case 'approval_team_decider_not_active':
      return 403
    case 'approval_expired':
    case 'approval_status_not_consumable':
      return 409
  }
}

export function approvalConsumeResponse(err: ApprovalConsumeError): Record<string, unknown> {
  return {
    error: err.code,
    ...(err.approvalStatus ? { approvalStatus: err.approvalStatus } : {}),
  }
}
