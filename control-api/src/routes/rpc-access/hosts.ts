import { Router } from 'express'
import { config } from '../../config.js'
import { K8sGateway } from '../../k8s.js'
import { rateLimitMiddleware } from '../../middleware/rateLimitMiddleware.js'
import {
  requireRpcTokenHostMatch,
  requireValidRpcAccessTokenAny,
} from '../../middleware/rpcAccessAuth.js'
import { bumpWakeGeneration } from '../../services/hostWakeService.js'
import { K8sNotFoundError } from '../../services/resourceService.js'

/** Annotation projected onto the Host CR to signal a wake to HCC. */
export const WAKE_REQUESTED_ANNOTATION = 'clerum.io/wake-requested'

type HostLifecycleView = {
  spec?: { lifecycle?: { stateless?: boolean } }
  status?: { lifecycle?: { state?: string } }
}

/**
 * Keep log lines injection-free: hostRef comes from the URL path. The K8s
 * object name charset is [a-z0-9.-]; anything else is stripped and the value
 * capped at the DNS-1123 subdomain length.
 */
function sanitizeHostRefForLog(hostRef: string): string {
  return hostRef.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 253)
}

export function createRpcAccessHostsRouter(gateway: K8sGateway): Router {
  const router = Router()

  // POST /rpc/hosts/:hostRef/wake — request a wake of a suspended stateless
  // Host (Stage 4.1). Middleware order is load-bearing:
  //   1. rpc token auth + host match — authorization strictly BEFORE any
  //      mutation (no generation bump, no annotation patch for forbidden
  //      callers).
  //   2. per-host rate limit (PG token bucket, 429 + Retry-After).
  //   3. handler — reads the Host CR, bumps the Postgres-backed monotonic
  //      wake generation and projects it as a write-only annotation.
  //
  // Response contract (consumed by rpc-proxy, Stage 5):
  //   404 {status:'unknown'}                          Host CR absent
  //   409 {status:'not-stateless'}                    spec.lifecycle.stateless !== true
  //   200 {status:'active'}                           running (state active/absent) — retry upstream now
  //   200 {status:'active', wakeGeneration}           draining — generation bumped so HCC cancels the drain
  //   202 {status:'wake-requested', wakeGeneration}   suspended (or any other non-running state)
  router.post(
    '/rpc/hosts/:hostRef/wake',
    // Spec (Control Plane Authorization §6.3): every endpoint maps to
    // exactly ONE required scope. Waking a suspended host is its own
    // capability (cost/availability impact), minted into default user
    // rpc tokens alongside host:message:invoke.
    requireValidRpcAccessTokenAny(['host:wake:write']),
    requireRpcTokenHostMatch(),
    rateLimitMiddleware({
      bucketType: 'host_wake',
      maxPerMinute: config.hostWakeRlPerMin,
      // The host-match middleware above guarantees a non-empty, token-bound
      // hostRef by the time the limiter runs, so the key is always derivable.
      getBucketKey: req => {
        const hostRef = String(req.params?.hostRef || '').trim()
        return hostRef ? `host-wake:${hostRef}` : null
      },
    }),
    async (req, res, next) => {
      const hostRef = String(req.params.hostRef || '').trim()
      const logHostRef = sanitizeHostRefForLog(hostRef)
      try {
        let host: HostLifecycleView
        try {
          host = (await gateway.getResource(
            'hosts',
            hostRef,
            config.hostsNamespace
          )) as HostLifecycleView
        } catch (err) {
          if (err instanceof K8sNotFoundError) {
            res.status(404).json({ status: 'unknown' })
            return
          }
          throw err
        }

        if (host.spec?.lifecycle?.stateless !== true) {
          res.status(409).json({ status: 'not-stateless' })
          return
        }

        const state = host.status?.lifecycle?.state
        if (state === undefined || state === null || state === 'active') {
          // Already running — the caller retries upstream immediately. No
          // generation bump: there is nothing for HCC to wake or cancel.
          res.status(200).json({ status: 'active' })
          return
        }

        // draining, suspended, or any other non-running state: record the
        // wake intent. The generation is bumped in Postgres (atomic,
        // monotonic) and projected write-only onto the Host annotation —
        // never computed from the annotation's current value.
        const bump = await bumpWakeGeneration(hostRef, config.hostWakeCoalesceWindowMs)
        if (bump.shouldProject) {
          // Project the Postgres-authoritative generation onto the Host
          // annotation with MONOTONIC (non-regressing) semantics. A blind
          // merge patch here has no ordering guarantee: with coalesce-window
          // = 0 or control-api replicas > 1, a slower lower-generation patch
          // could land after a higher one and regress the projection, which
          // can briefly suppress a later legitimate wake in HCC. The monotonic
          // projector reads the current value, refuses to write a lower one,
          // and uses a resourceVersion precondition (409-retry) to serialize
          // concurrent equal-tier writers.
          try {
            await gateway.patchAnnotationMonotonic(
              'hosts',
              hostRef,
              WAKE_REQUESTED_ANNOTATION,
              bump.generation,
              config.hostsNamespace
            )
          } catch (err) {
            // The Host CR was deleted between the read above and the
            // projection patch. Same contract row as the read path: absent
            // Host CR -> 404 {status:'unknown'}. The Postgres generation
            // bump is harmless (monotonic counter, nothing left to observe
            // it).
            if (err instanceof K8sNotFoundError) {
              res.status(404).json({ status: 'unknown' })
              return
            }
            throw err
          }
        }

        if (req.log) {
          req.log.info(
            {
              event: 'host_wake_requested',
              hostRef: logHostRef,
              state,
              wakeGeneration: bump.generation,
              projected: bump.shouldProject,
            },
            'host wake requested'
          )
        }

        if (state === 'draining') {
          // Still serving traffic — report active so the caller retries
          // upstream now, but the bumped generation tells HCC to cancel the
          // drain instead of completing the suspension.
          res.status(200).json({ status: 'active', wakeGeneration: bump.generation })
          return
        }

        res.status(202).json({ status: 'wake-requested', wakeGeneration: bump.generation })
      } catch (error) {
        next(error)
      }
    }
  )

  return router
}
