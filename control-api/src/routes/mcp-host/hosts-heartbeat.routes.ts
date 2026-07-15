import { Router } from 'express'
import { config } from '../../config.js'
import { K8sGateway } from '../../k8s.js'
import { mcpHostHttpMetrics } from '../../middleware/mcpHostHttpMetrics.js'
import { requireMcpHostJwt } from '../../middleware/mcpHostJwtAuth.js'
import {
  type HostHeartbeatState,
  type HostHeartbeatUpsert,
  upsertHostHeartbeat,
} from '../../services/hostHeartbeatService.js'

/**
 * Stateless heartbeat ingest on the /mcp-host facade.
 *
 * mcp-host pods POST their D8 activity snapshot here through the
 * nginx-workflow-approval-gateway, authenticated with the SAME RS256 runtime
 * access JWT the workflow-approvals endpoints accept. Identity comes from
 * the token CLAIMS — the effective hostRef is `hostRefs[0]` (the Host CRD
 * name on HCC-issued 1st-party tokens) and the payload's hostRef must agree;
 * neither the path nor the body ever establishes identity.
 *
 * The response's `{ drain }` verdict is READ from the Host CR: HCC's
 * lifecycle tracker (fed by the heartbeat poller on
 * /api/v1/auth/mcp-host/heartbeats) decides the drain and persists it as
 * `status.lifecycle.state='draining'`; control-api only reports that state.
 */

/** Heartbeat bodies are tiny; anything above this is rejected before auth. */
const HEARTBEAT_MAX_BODY_BYTES = 8 * 1024

const HEARTBEAT_STATES: ReadonlySet<string> = new Set(['active', 'draining', 'drained'])

type HeartbeatParseResult =
  | { ok: true; payload: HostHeartbeatUpsert }
  | { ok: false; error: string }

/**
 * Strict shape validation for the heartbeat body. Runs BEFORE any auth
 * crypto so malformed requests are rejected at 400 without paying for an
 * RS256 signature verification. Unknown extra fields are tolerated (forward
 * compatibility); every REQUIRED field is type-checked exactly.
 */
export function parseHeartbeatBody(raw: unknown): HeartbeatParseResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'body must be a JSON object' }
  }
  const body = raw as Record<string, unknown>
  if (body.schemaVersion !== 1) {
    return { ok: false, error: 'schemaVersion must be 1' }
  }
  if (typeof body.hostRef !== 'string' || !body.hostRef.trim()) {
    return { ok: false, error: 'hostRef must be a non-empty string' }
  }
  if (typeof body.podUid !== 'string' || !body.podUid.trim()) {
    return { ok: false, error: 'podUid must be a non-empty string' }
  }
  if (typeof body.activeWork !== 'boolean') {
    return { ok: false, error: 'activeWork must be a boolean' }
  }
  const conditions = body.conditions
  if (typeof conditions !== 'object' || conditions === null || Array.isArray(conditions)) {
    return { ok: false, error: 'conditions must be an object' }
  }
  const cond = conditions as Record<string, unknown>
  for (const key of ['activeTask', 'awaitingApproval', 'pendingResults'] as const) {
    if (typeof cond[key] !== 'boolean') {
      return { ok: false, error: `conditions.${key} must be a boolean` }
    }
  }
  // Cron×stateless (additive, schemaVersion stays 1): older emitters omit the
  // field — absent normalizes to false. Present-but-wrong-type is rejected.
  if ('activeCronSchedules' in cond && typeof cond.activeCronSchedules !== 'boolean') {
    return { ok: false, error: 'conditions.activeCronSchedules must be a boolean when present' }
  }
  if (
    typeof body.lastActivityTs !== 'number' ||
    !Number.isFinite(body.lastActivityTs) ||
    body.lastActivityTs < 0
  ) {
    return { ok: false, error: 'lastActivityTs must be a non-negative finite number (epoch ms)' }
  }
  if (typeof body.state !== 'string' || !HEARTBEAT_STATES.has(body.state)) {
    return { ok: false, error: "state must be one of 'active' | 'draining' | 'drained'" }
  }
  return {
    ok: true,
    payload: {
      hostRef: body.hostRef,
      podUid: body.podUid,
      activeWork: body.activeWork,
      conditions: {
        activeTask: cond.activeTask as boolean,
        awaitingApproval: cond.awaitingApproval as boolean,
        pendingResults: cond.pendingResults as boolean,
        activeCronSchedules: cond.activeCronSchedules === true,
      },
      lastActivityTs: body.lastActivityTs,
      state: body.state as HostHeartbeatState,
    },
  }
}

type HostLifecycleView = {
  status?: { lifecycle?: { state?: string } }
}

export function createMcpHostHostsHeartbeatRoutes(gateway: K8sGateway): Router {
  const router = Router()

  router.post(
    '/mcp-host/hosts/heartbeat',
    mcpHostHttpMetrics('mcp_host_hosts_heartbeat'),
    // Cheap pre-checks reject 400 BEFORE the RS256 verification (same
    // ordering precedent as the rest of the runtime plane): body size cap +
    // strict shape validation.
    (req, res, next) => {
      const declaredLength = Number(req.header('content-length') ?? 0)
      if (Number.isFinite(declaredLength) && declaredLength > HEARTBEAT_MAX_BODY_BYTES) {
        res.status(400).json({ error: 'body_too_large' })
        return
      }
      const parsed = parseHeartbeatBody(req.body)
      if (!parsed.ok) {
        res.status(400).json({ error: 'invalid_heartbeat_payload', message: parsed.error })
        return
      }
      res.locals.heartbeatPayload = parsed.payload
      next()
    },
    requireMcpHostJwt,
    (req, res, next) => {
      void (async () => {
        try {
          const payload = res.locals.heartbeatPayload as HostHeartbeatUpsert
          const auth = req.mcpHostJwt!
          // Claims win — no path/body identity. hostRefs[0] is the Host CRD
          // name for HCC-issued 1st-party tokens; WRC recipe tokens carry the
          // recipe binding there and can never match a Host name.
          const effectiveHostRef = auth.hostRefs[0]
          // A real Host CRD name is DNS-1123 and NEVER contains '/'. A recipe
          // binding is shaped `namespace/name` and carries the slash. Reject
          // the recipe-binding shape on either the claim or the payload BEFORE
          // any upsert: otherwise a recipe-plane token whose hostRefs[0] equals
          // its own `namespace/name` payload would satisfy the equality check
          // and inject a recipe-shaped row into the host heartbeat feed.
          const recipeShaped =
            (effectiveHostRef?.includes('/') ?? false) || payload.hostRef.includes('/')
          if (!effectiveHostRef || payload.hostRef !== effectiveHostRef || recipeShaped) {
            req.log?.info(
              {
                event: 'auth_denied',
                reason: 'host_binding_mismatch',
                route: 'mcp_host_hosts_heartbeat',
                jti: auth.jti,
                sub: auth.sub,
              },
              'host binding mismatch on /mcp-host/hosts/heartbeat'
            )
            return res.status(403).json({ error: 'host_binding_mismatch' })
          }

          // Persist FIRST: the snapshot is valuable to HCC's poller even when
          // the Host CR read below fails.
          await upsertHostHeartbeat(payload)

          let host: HostLifecycleView
          try {
            host = (await gateway.getResource(
              'hosts',
              effectiveHostRef,
              config.hostsNamespace
            )) as HostLifecycleView
          } catch (err) {
            // Fail loud (503) — the emitter tolerates and retries on its next
            // beat. A missing Host CR is included on purpose: a pod
            // heartbeating for an absent Host is an anomaly to surface, not a
            // 404 to be absorbed as rollout skew.
            req.log?.error(
              {
                event: 'heartbeat_host_read_failed',
                route: 'mcp_host_hosts_heartbeat',
                hostRef: effectiveHostRef,
                err,
              },
              'Host CR read failed while answering a heartbeat'
            )
            return res.status(503).json({ error: 'host_state_unavailable' })
          }

          return res.status(200).json({ drain: host.status?.lifecycle?.state === 'draining' })
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  return router
}
