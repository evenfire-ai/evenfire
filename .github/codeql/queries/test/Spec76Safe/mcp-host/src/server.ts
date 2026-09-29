import express from 'express'
import { DirectServiceAdmission } from './server/directServiceAdmission.js'
import { runtimeEdgeGuard } from './server/edgeRuntimeAuth.js'
import {
  handleCronResultAckRoute,
  handleCronResultsRoute,
  handleMessageRoute,
  handleProviderMessageAuthorizationRoute,
  handleProviderWorkflowApprovalDecisionRoute,
  handleProviderWorkflowApprovalResolveRoute,
  handleProviderWorkflowResultRequestRoute,
  handleTelegramWorkflowApprovalVerificationRoute,
  handleWorkflowApprovalMediumEnrollmentRoute,
  handleWorkflowApprovalNotificationClaimRoute,
  handleWorkflowApprovalNotificationTerminalRoute,
} from './server/routes.js'

const app = express()
class RuntimeServer {
  private readonly directServiceAdmission = new DirectServiceAdmission()

  private routeDeps() {
    return { directServiceAdmission: () => this.directServiceAdmission.admit() }
  }

  register(): void {
    app.post(
      '/v1/runtime/messages',
      runtimeEdgeGuard(['rpc-proxy', 'channel-reader', 'workflow-approval-request-reader']),
      (req: any, res: any) => handleMessageRoute(req, res, this.routeDeps())
    )
    app.post(
      '/v1/runtime/provider-messages/authorize',
      runtimeEdgeGuard(['channel-reader', 'workflow-approval-request-reader']),
      (req: any, res: any) =>
        handleProviderMessageAuthorizationRoute(req, res, this.routeDeps())
    )
    app.post(
      '/v1/runtime/workflow-approvals/decide',
      runtimeEdgeGuard(['channel-reader', 'workflow-approval-request-reader']),
      (req: any, res: any) =>
        handleProviderWorkflowApprovalDecisionRoute(req, res, this.routeDeps())
    )
    app.post(
      '/v1/runtime/workflow-approval-mediums/link-sessions/confirm',
      runtimeEdgeGuard(['channel-reader', 'workflow-approval-request-reader']),
      (req: any, res: any) =>
        handleWorkflowApprovalMediumEnrollmentRoute(req, res, this.routeDeps())
    )
    app.post(
      '/v1/runtime/workflow-approvals/resolve',
      runtimeEdgeGuard(['channel-reader']),
      (req: any, res: any) =>
        handleProviderWorkflowApprovalResolveRoute(req, res, this.routeDeps())
    )
    app.post(
      '/v1/runtime/workflow-results/latest',
      runtimeEdgeGuard(['channel-reader']),
      (req: any, res: any) =>
        handleProviderWorkflowResultRequestRoute(req, res, this.routeDeps())
    )
    app.post(
      '/v1/runtime/workflow-approval-notifications/claim',
      runtimeEdgeGuard(['channel-reader']),
      (req: any, res: any) =>
        handleWorkflowApprovalNotificationClaimRoute(req, res, this.routeDeps())
    )
    app.post(
      '/v1/runtime/workflow-approval-notifications/deliveries/:id/:action',
      runtimeEdgeGuard(['channel-reader']),
      (req: any, res: any) =>
        handleWorkflowApprovalNotificationTerminalRoute(
          req, res, String(req.params.id || ''), String(req.params.action || ''), this.routeDeps()
        )
    )
    app.post(
      '/v1/runtime/workflow-approval-mediums/telegram/challenges/confirm-provider-event',
      runtimeEdgeGuard(['channel-reader']),
      (req: any, res: any) =>
        handleTelegramWorkflowApprovalVerificationRoute(req, res, this.routeDeps())
    )
    app.get('/v1/runtime/cron/results', runtimeEdgeGuard(['channel-reader']), (req: any, res: any) =>
      handleCronResultsRoute(req, res, this.routeDeps())
    )
    app.delete(
      '/v1/runtime/cron/results/:taskId',
      runtimeEdgeGuard(['channel-reader']),
      (req: any, res: any) =>
        handleCronResultAckRoute(req, res, String(req.params.taskId || ''), this.routeDeps())
    )
  }
}

export default RuntimeServer
