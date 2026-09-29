import fs from 'node:fs'
import { getRuntimeCallerContext } from './edgeRuntimeAuth.js'

type RouteHandlers = {
  directServiceAdmission?: () => { allowed: boolean } | undefined
}

function json(_res: any, _status: number, _body: unknown): void {}

function admitDirectServiceRequest(req: any, res: any, handlers: RouteHandlers): boolean {
  const caller = getRuntimeCallerContext(req)?.caller
  if (caller === 'rpc-proxy') return true
  if (caller !== 'channel-reader' && caller !== 'workflow-approval-request-reader') return true
  const result = handlers.directServiceAdmission?.()
  if (!result || result.allowed) return true
  json(res, 429, { error: 'limited' })
  return false
}

export function handleMessageRoute(req: any, res: any, handlers: RouteHandlers): void {
  if (!admitDirectServiceRequest(req, res, handlers)) return
  fs.writeFileSync('/tmp/spec76-safe-message', 'protected')
  res.sendStatus(204)
}

export function handleProviderMessageAuthorizationRoute(
  req: any,
  res: any,
  handlers: RouteHandlers
): void {
  if (!admitDirectServiceRequest(req, res, handlers)) return
  fs.writeFileSync('/tmp/spec76-safe-provider-message', 'protected')
  res.sendStatus(204)
}

export function handleProviderWorkflowApprovalDecisionRoute(
  req: any,
  res: any,
  handlers: RouteHandlers
): void {
  if (!admitDirectServiceRequest(req, res, handlers)) return
  fs.writeFileSync('/tmp/spec76-safe-approval-decision', 'protected')
  res.sendStatus(204)
}

export function handleWorkflowApprovalMediumEnrollmentRoute(
  req: any,
  res: any,
  handlers: RouteHandlers
): void {
  if (!admitDirectServiceRequest(req, res, handlers)) return
  fs.writeFileSync('/tmp/spec76-safe-medium-enrollment', 'protected')
  res.sendStatus(204)
}

export function handleProviderWorkflowApprovalResolveRoute(
  req: any,
  res: any,
  handlers: RouteHandlers
): void {
  if (!admitDirectServiceRequest(req, res, handlers)) return
  fs.writeFileSync('/tmp/spec76-safe-approval-resolve', 'protected')
  res.sendStatus(204)
}

export function handleProviderWorkflowResultRequestRoute(
  req: any,
  res: any,
  handlers: RouteHandlers
): void {
  if (!admitDirectServiceRequest(req, res, handlers)) return
  fs.writeFileSync('/tmp/spec76-safe-workflow-result', 'protected')
  res.sendStatus(204)
}

export function handleWorkflowApprovalNotificationClaimRoute(
  req: any,
  res: any,
  handlers: RouteHandlers
): void {
  if (!admitDirectServiceRequest(req, res, handlers)) return
  fs.writeFileSync('/tmp/spec76-safe-notification-claim', 'protected')
  res.sendStatus(204)
}

export function handleWorkflowApprovalNotificationTerminalRoute(
  req: any,
  res: any,
  _id: string,
  _action: string,
  handlers: RouteHandlers
): void {
  if (!admitDirectServiceRequest(req, res, handlers)) return
  fs.writeFileSync('/tmp/spec76-safe-notification-terminal', 'protected')
  res.sendStatus(204)
}

export function handleTelegramWorkflowApprovalVerificationRoute(
  req: any,
  res: any,
  handlers: RouteHandlers
): void {
  if (!admitDirectServiceRequest(req, res, handlers)) return
  fs.writeFileSync('/tmp/spec76-safe-telegram-verification', 'protected')
  res.sendStatus(204)
}

export function handleCronResultsRoute(req: any, res: any, handlers: RouteHandlers): void {
  if (!admitDirectServiceRequest(req, res, handlers)) return
  fs.writeFileSync('/tmp/spec76-safe-cron-results', 'protected')
  res.sendStatus(204)
}

export function handleCronResultAckRoute(
  req: any,
  res: any,
  _taskId: string,
  handlers: RouteHandlers
): void {
  if (!admitDirectServiceRequest(req, res, handlers)) return
  fs.writeFileSync('/tmp/spec76-safe-cron-result-ack', 'protected')
  res.sendStatus(204)
}
