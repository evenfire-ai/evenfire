import express, { NextFunction, Request, Response } from 'express'
import cors from 'cors'
import { STATUS_CODES } from 'node:http'
import { config } from './config.js'
import { ControlApiError, ControlApiPathError } from './controlApiClient.js'
import { invitationPasswordErrorHandler } from './http/passwordAdmissionError.js'
import { sendPublicApiError } from './http/publicApiError.js'
import { requireTrustedBrowserMutation } from './middleware/browserMutationGuard.js'
import { withExternalRequestContext } from './requestContext.js'
import { createAuthRouter } from './routes/auth.js'
import { createContextSharedFilesystemsRouter } from './routes/contextSharedFilesystems.js'
import { createDesktopRouter } from './routes/desktop.js'
import { createDirectoryRouter } from './routes/directory.js'
import { createEntityChangesRouter } from './routes/entityChanges.js'
import { createGfsRouter } from './routes/gfs.js'
import { createHealthRouter } from './routes/health.js'
import { createInvitationsRouter } from './routes/invitations.js'
import { createMeRouter } from './routes/me.js'
import { createMembersRouter } from './routes/members.js'
import { createNotificationsRouter } from './routes/notifications.js'
import { createOauthCallbackRouter } from './routes/oauthCallback.js'
import { createOauthGrantsRouter } from './routes/oauthGrants.js'
import { createRpcRouter } from './routes/rpc.js'
import { createRpcDelegationsRouter } from './routes/rpcDelegations.js'
import { createTeamRouter } from './routes/team.js'
import { createUserApprovalDecisionsRouter } from './routes/userApprovalDecisions.js'
import { createWorkflowApprovalMediumsRouter } from './routes/workflowApprovalMediums.js'
import { createExternalWorkflowsRouter } from './routes/workflows.js'

// Upload v2 part bodies are streamed octets and must not pass through the
// global JSON parser (which would buffer/reject the binary payload).
// Match the route shape, not only a valid UUID. Control API owns the UUID
// validation and must receive malformed IDs as upload requests; otherwise a
// binary body can be consumed by the global JSON parser and produce a parser
// error before the canonical 4xx path is reached.
const GFS_UPLOAD_PART_PATH = /^\/api\/v1\/me\/gfs\/uploads\/[^/]+\/parts\/[0-9]+$/i

// Retry guidance the global handler relays from a ControlApiError. The client
// has already filtered the upstream headers; the allowlist is repeated at this
// last hop (as routes/gfs.ts does) so a hand-built ControlApiError cannot
// publish arbitrary headers. `x-request-id` is never relayed here.
const RETRY_AFTER_STATUSES = new Set([408, 425, 429, 502, 503, 504])
const RATE_LIMIT_NUMERIC_HEADERS = [
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
] as const
// The IETF RateLimit fields are structured (`limit=30, remaining=0, reset=17`,
// `30;w=60`), so they are relayed as control-api wrote them, like routes/gfs.ts.
const RATE_LIMIT_STRUCTURED_HEADERS = ['ratelimit', 'ratelimit-policy'] as const
const UNSIGNED_INTEGER_HEADER = /^\d{1,10}$/
const MAX_RETRY_AFTER_SECONDS = 86_400

function unsignedIntegerHeader(raw: string | undefined): number | undefined {
  if (!raw || !UNSIGNED_INTEGER_HEADER.test(raw)) return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : undefined
}

function relayControlApiRetryHeaders(err: ControlApiError, res: Response): void {
  const headers = err.headers
  if (RETRY_AFTER_STATUSES.has(err.status)) {
    const retryAfter = unsignedIntegerHeader(headers['retry-after'])
    if (retryAfter !== undefined && retryAfter >= 1 && retryAfter <= MAX_RETRY_AFTER_SECONDS) {
      res.setHeader('retry-after', String(retryAfter))
    }
  }
  if (err.status === 429) {
    for (const name of RATE_LIMIT_NUMERIC_HEADERS) {
      const value = unsignedIntegerHeader(headers[name])
      if (value !== undefined) res.setHeader(name, String(value))
    }
    for (const name of RATE_LIMIT_STRUCTURED_HEADERS) {
      const value = headers[name]
      if (value) res.setHeader(name, value)
    }
  }
  if (err.status === 503 && headers['cache-control']?.trim().toLowerCase() === 'no-store') {
    res.setHeader('cache-control', 'no-store')
  }
}

export function createApp() {
  const app = express()
  // The deployment admits traffic only from the cloudflared ingress namespace
  // (see deploy/base/profiles/networkpolicies.yaml). That single trusted hop
  // overwrites the client address before this process, so req.ip is the stable
  // limiter identity. Direct service exposure would invalidate this contract
  // and must be rejected by deployment policy rather than by accepting a
  // caller-controlled X-Forwarded-For chain here.
  app.set('trust proxy', 1)
  // Capture the proxy-attested client once at the external boundary. The
  // control-api receives it through the authenticated service channel so its
  // non-GFS edge buckets do not collapse every Desktop client onto the funnel
  // pod address.
  app.use(withExternalRequestContext)
  app.use(
    cors({
      origin: config.corsOrigin === '*' ? true : config.corsOrigin,
      credentials: true,
    })
  )
  const jsonBodyParser = express.json({ limit: config.jsonBodyLimit })
  app.use((req, res, next) => {
    if (req.method === 'PUT' && GFS_UPLOAD_PART_PATH.test(req.path)) {
      next()
      return
    }
    jsonBodyParser(req, res, next)
  })
  app.use(requireTrustedBrowserMutation)

  app.use(createHealthRouter())

  const api = express.Router()
  api.use(createAuthRouter())
  api.use(createDesktopRouter())
  api.use(createMeRouter())
  api.use(createMembersRouter())
  api.use(createContextSharedFilesystemsRouter())
  api.use(createGfsRouter())
  api.use(createTeamRouter())
  const invitationsRouter = createInvitationsRouter()
  invitationsRouter.use(invitationPasswordErrorHandler)
  api.use(invitationsRouter)
  api.use(createDirectoryRouter())
  api.use(createRpcRouter())
  api.use(createRpcDelegationsRouter())
  api.use(createNotificationsRouter())
  api.use(createEntityChangesRouter())
  api.use(createUserApprovalDecisionsRouter())
  api.use(createOauthGrantsRouter())
  // PUBLIC (no auth) — provider redirect target; passthrough to control-api.
  api.use(createOauthCallbackRouter())
  api.use(createWorkflowApprovalMediumsRouter())
  api.use(createExternalWorkflowsRouter())
  app.use('/api/v1', api)

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not Found' })
  })

  app.use(externalRestPublicErrorHandler)

  return app
}

export function externalRestPublicErrorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  // 1. A caller-influenced control-api path is this edge's own client error. It
  // must be answered before the ControlApiError rule because
  // ControlApiPathError extends ControlApiError.
  if (err instanceof ControlApiPathError) {
    sendPublicApiError(req, res, 400, 'invalid_request', 'The request is not valid.')
    return
  }

  // 2. Forward control-api's own status and body. Never `String(err.message)`:
  // for a ControlApiError that is the internal request wrapper, which exposes
  // control-api paths and ids (#190).
  if (err instanceof ControlApiError) {
    relayControlApiRetryHeaders(err, res)
    if (err.body !== null && typeof err.body === 'object') {
      res.status(err.status).json(err.body)
      return
    }
    res.status(err.status).json({ error: STATUS_CODES[err.status] })
    return
  }

  // 3. Any other client error keeps dev's message (body-parser SyntaxError 400,
  // `entity.too.large` 413).
  const status =
    err instanceof Error && typeof (err as Error & { status?: unknown }).status === 'number'
      ? (err as Error & { status: number }).status
      : undefined
  if (status !== undefined && status >= 400 && status < 500) {
    res.status(status).json({ error: err instanceof Error ? err.message : 'Bad Request' })
    return
  }

  // 4. Everything else keeps the sanitized 500 envelope.
  sendPublicApiError(req, res, 500, 'internal_error', 'The request could not be completed.')
}
