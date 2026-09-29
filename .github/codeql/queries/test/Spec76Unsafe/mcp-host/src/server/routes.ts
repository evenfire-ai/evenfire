import fs from 'node:fs'
import { getRuntimeCallerContext as getTrustedRuntimeCallerContext } from './edgeRuntimeAuth'

// Same-name local helper that trusts a caller-controlled request header.
function getRuntimeCallerContext(req: any): { caller?: string } | undefined {
  return { caller: req.headers['x-clerum-edge-caller'] }
}

function json(_res: any, _status: number, _body: unknown): void {}

type RouteHandlers = { directServiceAdmission?: () => { allowed: boolean } | undefined }

function admitDirectServiceRequest(req: any, res: any, handlers: RouteHandlers): boolean {
  const caller = getTrustedRuntimeCallerContext(req)?.caller
  if (caller === 'rpc-proxy') return true
  if (caller !== 'channel-reader' && caller !== 'workflow-approval-request-reader') return true
  const result = handlers.directServiceAdmission?.()
  if (!result || result.allowed) return true
  json(res, 429, { error: 'limited' })
  return false
}

export async function handleProviderMessageAuthorizationRoute(
  req: any,
  res: any,
  handlers: RouteHandlers
): Promise<void> {
  // The edge guard accepts rpc-proxy from a caller-controlled header without
  // checking the Spec 71 service credential. This path bypasses the bucket.
  if (getRuntimeCallerContext(req)?.caller === 'rpc-proxy') {
    fs.writeFileSync('/tmp/spec76-unsafe-forged-rpc-proxy', 'protected')
    return
  }
  if (!admitDirectServiceRequest(req, res, handlers)) return
  fs.writeFileSync('/tmp/spec76-unsafe-class-a', 'protected')
  res.sendStatus(204)
}

export async function handleProviderWorkflowApprovalResolveRoute(
  req: any,
  res: any,
  handlers: RouteHandlers
): Promise<void> {
  admitDirectServiceRequest(req, res, handlers) // ignored denial result
  fs.writeFileSync('/tmp/spec76-unsafe-class-a-ignored', 'protected')
  res.sendStatus(204)
}

export async function handleLateAdmissionRoute(
  req: any,
  res: any,
  handlers: RouteHandlers
): Promise<void> {
  fs.writeFileSync('/tmp/spec76-unsafe-late-admission', 'protected')
  if (!admitDirectServiceRequest(req, res, handlers)) return
  res.sendStatus(204)
}
