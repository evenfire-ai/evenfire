import type { RPCServer } from '../server'
import type {
  ProviderMessageAuthorizationHandler,
  ProviderWorkflowApprovalDecisionHandler,
  ProviderWorkflowApprovalResolveHandler,
  TelegramWorkflowApprovalVerificationHandler,
  WorkflowApprovalMediumEnrollmentHandler,
  WorkflowApprovalNotificationClaimHandler,
  WorkflowApprovalNotificationTerminalHandler,
} from '../server/types'

export type WorkflowApprovalRuntimeRouteServer = Pick<
  RPCServer,
  | 'onProviderMessageAuthorization'
  | 'onProviderWorkflowApprovalDecision'
  | 'onProviderWorkflowApprovalResolve'
  | 'onWorkflowApprovalNotificationClaim'
  | 'onWorkflowApprovalNotificationTerminal'
  | 'onWorkflowApprovalMediumEnrollment'
  | 'onTelegramWorkflowApprovalVerification'
>

export type WorkflowApprovalRuntimeRouteHandlers = {
  providerMessageAuthorization: ProviderMessageAuthorizationHandler
  providerWorkflowApprovalDecision: ProviderWorkflowApprovalDecisionHandler
  providerWorkflowApprovalResolve: ProviderWorkflowApprovalResolveHandler
  workflowApprovalNotificationClaim: WorkflowApprovalNotificationClaimHandler
  workflowApprovalNotificationTerminal: WorkflowApprovalNotificationTerminalHandler
  workflowApprovalMediumEnrollment: WorkflowApprovalMediumEnrollmentHandler
  telegramWorkflowApprovalVerification: TelegramWorkflowApprovalVerificationHandler
}

export function wireWorkflowApprovalRuntimeRoutes(
  server: WorkflowApprovalRuntimeRouteServer,
  handlers: WorkflowApprovalRuntimeRouteHandlers
): void {
  server.onProviderMessageAuthorization(handlers.providerMessageAuthorization)
  server.onProviderWorkflowApprovalDecision(handlers.providerWorkflowApprovalDecision)
  server.onProviderWorkflowApprovalResolve(handlers.providerWorkflowApprovalResolve)
  server.onWorkflowApprovalNotificationClaim(handlers.workflowApprovalNotificationClaim)
  server.onWorkflowApprovalNotificationTerminal(handlers.workflowApprovalNotificationTerminal)
  server.onWorkflowApprovalMediumEnrollment(handlers.workflowApprovalMediumEnrollment)
  server.onTelegramWorkflowApprovalVerification(handlers.telegramWorkflowApprovalVerification)
}
