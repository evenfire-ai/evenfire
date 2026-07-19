import express from 'express'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import {
  type GovernedTraceOperationalErrorReason,
  governedTraceAdmissionRequestsTotal,
  governedTraceInFlightRequests,
  governedTraceRequestBodyBytes,
  recordGovernedTraceOperationalError,
} from '../observability/metrics.js'
import {
  AGENT_RUN_EVENT_TYPES,
  type GovernedEventFamily,
  INFRASTRUCTURE_TELEMETRY_TYPES,
} from '../services/tracing/contracts.js'
import {
  TRACING_DEFAULT_MAX_IN_FLIGHT,
  TRACING_JSON_BODY_LIMIT_BYTES,
  TRACING_MAX_BATCH_SIZE,
  getTracingMaxInFlight,
} from '../services/tracing/operationalLimits.js'
import { verifyInternalControlJwt } from '../utils/auth/internalControlToken.js'
import { verifyMcpHostAccessJwt } from '../utils/auth/mcpHostJwtToken.js'
import { extractBearerToken } from '../utils/extractBearerToken.js'

export {
  TRACING_DEFAULT_MAX_IN_FLIGHT,
  TRACING_JSON_BODY_LIMIT_BYTES,
  TRACING_MAX_BATCH_SIZE,
  getTracingMaxInFlight,
}

export const AGENT_RUN_EVENT_TYPES_V1 = AGENT_RUN_EVENT_TYPES
export const WORKFLOW_AGENT_RUN_EVENT_TYPES_V1 = ['run_start', 'run_end'] as const
export const ADMINISTRATIVE_EVENT_KINDS_V1 = ['linked_outcome', 'service_action'] as const
export const INFRASTRUCTURE_TELEMETRY_EVENT_TYPES_V1 = INFRASTRUCTURE_TELEMETRY_TYPES
export const WRC_INFRASTRUCTURE_TELEMETRY_EVENT_TYPES_V1 = [
  'lifecycle_transition',
  'reconcile_outcome',
  'controller_error',
] as const

type InternalControlPrincipalFields = {
  serviceSub: 'hcc-provisioner' | 'wrc-provisioner'
  credentialId: string
}

export type AgentRunEventSubmitterPrincipalV1 =
  | ({
      kind: 'wrc_internal_control'
      sourceService: 'workflow-recipes'
      allowedEventTypes: typeof WORKFLOW_AGENT_RUN_EVENT_TYPES_V1
    } & InternalControlPrincipalFields)
  | {
      kind: 'mcp_host_runtime'
      sourceService: 'mcp-host'
      serviceSub: string
      credentialId: string
      hostRefs: readonly string[]
      recipeNamespace: string
      recipeName: string
      allowedEventTypes: typeof AGENT_RUN_EVENT_TYPES_V1
    }

export type AdministrativeEventSubmitterPrincipalV1 =
  | ({
      kind: 'hcc_internal_control'
      sourceService: 'host-context-controller'
      allowedKinds: readonly ['linked_outcome']
    } & InternalControlPrincipalFields)
  | ({
      kind: 'wrc_internal_control'
      sourceService: 'workflow-recipes'
      allowedKinds: typeof ADMINISTRATIVE_EVENT_KINDS_V1
    } & InternalControlPrincipalFields)

export type InfrastructureTelemetrySubmitterPrincipalV1 =
  | ({
      kind: 'hcc_internal_control'
      sourceService: 'host-context-controller'
      resourceAuthority: 'hcc_managed'
      allowedTelemetryTypes: typeof INFRASTRUCTURE_TELEMETRY_EVENT_TYPES_V1
    } & InternalControlPrincipalFields)
  | ({
      kind: 'wrc_internal_control'
      sourceService: 'workflow-recipes'
      resourceAuthority: 'wrc_managed'
      allowedTelemetryTypes: typeof WRC_INFRASTRUCTURE_TELEMETRY_EVENT_TYPES_V1
    } & InternalControlPrincipalFields)

export type TracingEventRecord = Readonly<Record<string, unknown>>

declare global {
  namespace Express {
    interface Request {
      tracingEvents?: readonly TracingEventRecord[]
      tracingEventFamily?: GovernedEventFamily
      tracingRequestBodyBytes?: number
      tracingAdmissionRecorded?: boolean
      agentRunEventSubmitter?: AgentRunEventSubmitterPrincipalV1
      administrativeEventSubmitter?: AdministrativeEventSubmitterPrincipalV1
      infrastructureTelemetrySubmitter?: InfrastructureTelemetrySubmitterPrincipalV1
    }
  }
}

const TRACING_FAMILY_PATHS: ReadonlyArray<readonly [string, GovernedEventFamily]> = [
  ['/internal/tracing/agent-run-events', 'agent_run'],
  ['/internal/tracing/approval-prompt-history', 'agent_run'],
  ['/internal/tracing/administrative-events', 'administrative'],
  ['/internal/tracing/infrastructure-telemetry-events', 'infrastructure_telemetry'],
]

function tracingEventFamily(req: Request): GovernedEventFamily | null {
  if (req.tracingEventFamily) return req.tracingEventFamily
  const path = req.path.replace(/\/$/, '')
  return TRACING_FAMILY_PATHS.find(([suffix]) => path.endsWith(suffix))?.[1] ?? null
}

export function identifyTracingEventFamily(family: GovernedEventFamily): RequestHandler {
  return (req, _res, next) => {
    req.tracingEventFamily = family
    next()
  }
}

function recordTracingAdmission(
  req: Request,
  result: 'accepted' | 'rejected',
  reason: 'none' | GovernedTraceOperationalErrorReason
): void {
  if (req.tracingAdmissionRecorded) return
  const family = tracingEventFamily(req)
  if (!family) return

  req.tracingAdmissionRecorded = true
  governedTraceAdmissionRequestsTotal.inc({ family, result, reason })
  if (result === 'rejected' && reason !== 'none') {
    recordGovernedTraceOperationalError(family, reason)
  }
}

function recordTracingRejection(req: Request, reason: GovernedTraceOperationalErrorReason): void {
  recordTracingAdmission(req, 'rejected', reason)
}

function denySubmission(res: Response): void {
  res.status(403).json({ error: 'tracing_submission_forbidden' })
}

function bearerToken(req: Request): string | null {
  const token = extractBearerToken(req)
  return token && token.length <= 4096 ? token : null
}

function exactInternalControlPrincipal(token: string) {
  const claims = verifyInternalControlJwt(token)
  if (
    !claims ||
    claims.aud !== 'control-api' ||
    !(
      (claims.iss === 'hcc' && claims.sub === 'hcc-provisioner') ||
      (claims.iss === 'wrc' && claims.sub === 'wrc-provisioner')
    )
  ) {
    return null
  }
  return claims
}

function validateEventCatalog(
  req: Request,
  res: Response,
  field: 'eventType' | 'kind' | 'telemetryType',
  catalog: readonly string[],
  allowed: readonly string[],
  invalidError: string
): boolean {
  if (!req.tracingEvents) return true

  for (const [index, event] of req.tracingEvents.entries()) {
    const value = event[field]
    if (typeof value !== 'string' || !catalog.includes(value)) {
      recordTracingRejection(req, 'event_rejected')
      res.status(400).json({ error: invalidError, index })
      return false
    }
    if (!allowed.includes(value)) {
      recordTracingRejection(req, 'event_rejected')
      res.status(403).json({ error: 'tracing_event_forbidden', index })
      return false
    }
  }
  return true
}

function allowAgentRunEvents(req: Request, res: Response): boolean {
  const principal = req.agentRunEventSubmitter!
  return validateEventCatalog(
    req,
    res,
    'eventType',
    AGENT_RUN_EVENT_TYPES_V1,
    principal.allowedEventTypes,
    'invalid_event_type'
  )
}

function allowAdministrativeEvents(req: Request, res: Response): boolean {
  const principal = req.administrativeEventSubmitter!
  return validateEventCatalog(
    req,
    res,
    'kind',
    ADMINISTRATIVE_EVENT_KINDS_V1,
    principal.allowedKinds,
    'invalid_event_kind'
  )
}

function allowInfrastructureTelemetryEvents(req: Request, res: Response): boolean {
  const principal = req.infrastructureTelemetrySubmitter!
  return validateEventCatalog(
    req,
    res,
    'telemetryType',
    INFRASTRUCTURE_TELEMETRY_EVENT_TYPES_V1,
    principal.allowedTelemetryTypes,
    'invalid_telemetry_type'
  )
}

export function requireAgentRunEventSubmitter(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const token = bearerToken(req)
  if (!token) {
    denySubmission(res)
    return
  }

  const internalClaims = exactInternalControlPrincipal(token)
  if (internalClaims?.iss === 'wrc') {
    req.agentRunEventSubmitter = {
      kind: 'wrc_internal_control',
      sourceService: 'workflow-recipes',
      serviceSub: 'wrc-provisioner',
      credentialId: internalClaims.jti,
      allowedEventTypes: WORKFLOW_AGENT_RUN_EVENT_TYPES_V1,
    }
    if (allowAgentRunEvents(req, res)) next()
    return
  }

  const runtimeClaims = verifyMcpHostAccessJwt(token)
  if (runtimeClaims) {
    req.agentRunEventSubmitter = {
      kind: 'mcp_host_runtime',
      sourceService: 'mcp-host',
      serviceSub: runtimeClaims.sub,
      credentialId: runtimeClaims.jti,
      hostRefs: runtimeClaims.hostRefs,
      recipeNamespace: runtimeClaims.recipeNamespace,
      recipeName: runtimeClaims.recipeName,
      allowedEventTypes: AGENT_RUN_EVENT_TYPES_V1,
    }
    if (allowAgentRunEvents(req, res)) next()
    return
  }

  denySubmission(res)
}

export function requireAdministrativeEventSubmitter(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const token = bearerToken(req)
  const claims = token ? exactInternalControlPrincipal(token) : null
  if (!claims) {
    denySubmission(res)
    return
  }

  req.administrativeEventSubmitter =
    claims.iss === 'hcc'
      ? {
          kind: 'hcc_internal_control',
          sourceService: 'host-context-controller',
          serviceSub: 'hcc-provisioner',
          credentialId: claims.jti,
          allowedKinds: ['linked_outcome'],
        }
      : {
          kind: 'wrc_internal_control',
          sourceService: 'workflow-recipes',
          serviceSub: 'wrc-provisioner',
          credentialId: claims.jti,
          allowedKinds: ADMINISTRATIVE_EVENT_KINDS_V1,
        }
  if (allowAdministrativeEvents(req, res)) next()
}

export function requireInfrastructureTelemetrySubmitter(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const token = bearerToken(req)
  const claims = token ? exactInternalControlPrincipal(token) : null
  if (!claims) {
    denySubmission(res)
    return
  }

  req.infrastructureTelemetrySubmitter =
    claims.iss === 'hcc'
      ? {
          kind: 'hcc_internal_control',
          sourceService: 'host-context-controller',
          serviceSub: 'hcc-provisioner',
          credentialId: claims.jti,
          resourceAuthority: 'hcc_managed',
          allowedTelemetryTypes: INFRASTRUCTURE_TELEMETRY_EVENT_TYPES_V1,
        }
      : {
          kind: 'wrc_internal_control',
          sourceService: 'workflow-recipes',
          serviceSub: 'wrc-provisioner',
          credentialId: claims.jti,
          resourceAuthority: 'wrc_managed',
          allowedTelemetryTypes: WRC_INFRASTRUCTURE_TELEMETRY_EVENT_TYPES_V1,
        }
  if (allowInfrastructureTelemetryEvents(req, res)) next()
}

export const authorizeAgentRunEventBatch: RequestHandler = (req, res, next) => {
  if (!req.agentRunEventSubmitter) {
    denySubmission(res)
    return
  }
  if (allowAgentRunEvents(req, res)) {
    recordTracingAdmission(req, 'accepted', 'none')
    next()
  }
}

export const authorizeAdministrativeEventBatch: RequestHandler = (req, res, next) => {
  if (!req.administrativeEventSubmitter) {
    denySubmission(res)
    return
  }
  if (allowAdministrativeEvents(req, res)) {
    recordTracingAdmission(req, 'accepted', 'none')
    next()
  }
}

export const authorizeInfrastructureTelemetryEventBatch: RequestHandler = (req, res, next) => {
  if (!req.infrastructureTelemetrySubmitter) {
    denySubmission(res)
    return
  }
  if (allowInfrastructureTelemetryEvents(req, res)) {
    recordTracingAdmission(req, 'accepted', 'none')
    next()
  }
}

const tracingJsonParser = express.json({
  limit: TRACING_JSON_BODY_LIMIT_BYTES,
  strict: true,
  verify: (request, _response, buffer) => {
    ;(request as Request).tracingRequestBodyBytes = buffer.length
  },
})

export const parseTracingJsonBody: RequestHandler = (req, res, next) => {
  if (!req.is('application/json')) {
    recordTracingRejection(req, 'unsupported_content_type')
    res.status(415).json({ error: 'content_type_must_be_application_json' })
    return
  }
  tracingJsonParser(req, res, (error?: unknown) => {
    if (!error) {
      const family = tracingEventFamily(req)
      if (family && req.tracingRequestBodyBytes !== undefined) {
        governedTraceRequestBodyBytes.observe({ family }, req.tracingRequestBodyBytes)
      }
      next()
      return
    }

    const parseError = error as { status?: number; type?: string }
    if (parseError.status === 413 || parseError.type === 'entity.too.large') {
      recordTracingRejection(req, 'body_too_large')
      res.status(413).json({
        error: 'payload_too_large',
        maxBytes: TRACING_JSON_BODY_LIMIT_BYTES,
      })
      return
    }

    recordTracingRejection(req, 'invalid_json')
    res.status(400).json({ error: 'invalid_json' })
  })
}

export function createTracingInFlightLimiter(
  maxInFlight = TRACING_DEFAULT_MAX_IN_FLIGHT
): RequestHandler {
  if (!Number.isInteger(maxInFlight) || maxInFlight < 1 || maxInFlight > 1_000) {
    throw new Error('tracing max in-flight must be an integer between 1 and 1000')
  }
  let inFlight = 0
  governedTraceInFlightRequests.set(0)
  return (req, res, next) => {
    if (inFlight >= maxInFlight) {
      recordTracingRejection(req, 'capacity_exhausted')
      res.setHeader('Retry-After', '1')
      res.status(503).json({ error: 'tracing_capacity_exhausted' })
      return
    }
    inFlight += 1
    governedTraceInFlightRequests.set(inFlight)
    let released = false
    const release = () => {
      if (released) return
      released = true
      inFlight = Math.max(0, inFlight - 1)
      governedTraceInFlightRequests.set(inFlight)
    }
    res.once('finish', release)
    res.once('close', release)
    next()
  }
}

export function readTracingEventBatch(
  req: Request,
  res: Response
): readonly TracingEventRecord[] | null {
  const body = req.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    recordTracingRejection(req, 'event_rejected')
    res.status(400).json({ error: 'invalid_body' })
    return null
  }

  const events = (body as { events?: unknown }).events
  if (!Array.isArray(events) || events.length === 0) {
    recordTracingRejection(req, 'event_rejected')
    res.status(400).json({ error: 'events_required' })
    return null
  }
  if (events.length > TRACING_MAX_BATCH_SIZE) {
    recordTracingRejection(req, 'batch_too_large')
    res.status(413).json({
      error: 'batch_too_large',
      max: TRACING_MAX_BATCH_SIZE,
      got: events.length,
    })
    return null
  }

  const invalidIndex = events.findIndex(
    event => !event || typeof event !== 'object' || Array.isArray(event)
  )
  if (invalidIndex !== -1) {
    recordTracingRejection(req, 'event_rejected')
    res.status(400).json({ error: 'invalid_event', index: invalidIndex })
    return null
  }

  return events as TracingEventRecord[]
}

export const requireTracingEventBatch: RequestHandler = (req, res, next) => {
  const events = readTracingEventBatch(req, res)
  if (!events) return

  req.tracingEvents = events
  next()
}
