import express from 'express'
import { rateLimit } from 'express-rate-limit'
import fs from 'node:fs'
import { requireRpcAuth, requireScope } from '../../../rpc-proxy/src/middleware/auth'
import { DirectServiceAdmission } from './server/directServiceAdmission'
import { runtimeEdgeGuard } from './server/edgeRuntimeAuth'
import {
  handleProviderMessageAuthorizationRoute,
  handleProviderWorkflowApprovalResolveRoute,
  handleLateAdmissionRoute,
} from './server/routes'

const app = express()
class RuntimeServer {
  private readonly directServiceAdmission = new DirectServiceAdmission()
  private routeDeps() {
    return { directServiceAdmission: () => this.directServiceAdmission.admit() }
  }

  register(): void {
    app.post(
      '/v1/runtime/provider-messages/authorize',
      runtimeEdgeGuard(['rpc-proxy', 'channel-reader', 'workflow-approval-request-reader']),
      (req: any, res: any) =>
        handleProviderMessageAuthorizationRoute(req, res, this.routeDeps())
    )
    app.post(
      '/v1/runtime/workflow-approvals/resolve',
      runtimeEdgeGuard(['rpc-proxy', 'channel-reader', 'workflow-approval-request-reader']),
      (req: any, res: any) =>
        handleProviderWorkflowApprovalResolveRoute(req, res, this.routeDeps())
    )
    app.post(
      '/v1/runtime/provider-messages/authorize',
      runtimeEdgeGuard(['channel-reader']),
      (req: any, res: any) => handleLateAdmissionRoute(req, res, this.routeDeps())
    )

    const unrelatedUserLimiter = rateLimit({ windowMs: 60_000, limit: 600 })
    app.get(
      '/v1/runtime/cron/results',
      runtimeEdgeGuard(['channel-reader']),
      requireRpcAuth,
      requireScope('host:task:read'),
      unrelatedUserLimiter,
      (_req: any, res: any) => {
        fs.writeFileSync('/tmp/spec76-unsafe-unrelated-limiter', 'protected')
        res.sendStatus(200)
      }
    )

    app.post(
      '/v1/runtime/unlisted-sensitive',
      runtimeEdgeGuard(['channel-reader']),
      (req: any, res: any) =>
        handleProviderMessageAuthorizationRoute(req, res, this.routeDeps())
    )
  }
}

export default RuntimeServer
