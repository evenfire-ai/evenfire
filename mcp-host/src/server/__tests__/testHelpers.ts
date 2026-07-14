import type { RouteHandlers } from '../routes'

export type RouteHandlersTestShape = RouteHandlers

/**
 * Build a fully-typed RouteHandlers fixture for route-handler tests.
 * All fields default to null; pass `overrides` to set the ones the test cares about.
 */
export function makeHandlers(
  overrides: Partial<RouteHandlersTestShape> = {}
): RouteHandlersTestShape {
  return {
    messageHandler: null,
    statusHandler: null,
    approvalHandler: null,
    providerWorkflowApprovalDecisionHandler: null,
    providerWorkflowApprovalResolveHandler: null,
    providerWorkflowResultRequestHandler: null,
    providerMessageAuthorizationHandler: null,
    workflowApprovalNotificationClaimHandler: null,
    workflowApprovalNotificationTerminalHandler: null,
    workflowApprovalMediumEnrollmentHandler: null,
    telegramWorkflowApprovalVerificationHandler: null,
    activitySnapshotHandler: null,
    activityStreamHandler: null,
    taskResultHandler: null,
    cronResultsHandler: null,
    cronResultAckHandler: null,
    sessionsListHandler: null,
    sessionMessagesHandler: null,
    contextBreakdownHandler: null,
    ...overrides,
  }
}
