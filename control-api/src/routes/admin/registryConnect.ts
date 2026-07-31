import { Router } from 'express'
import type { Request, Response } from 'express'
import { generateKeyPairSync } from 'node:crypto'
import { config } from '../../config.js'
import { type UiAuthedRequest, requireAuthForControlUI } from '../../middleware/controlUIAuth.js'
import { rateLimitMiddleware } from '../../middleware/rateLimitMiddleware.js'
import { rootLogger } from '../../observability/logger.js'
import { findAdminById } from '../../services/adminAuthService.js'
import {
  deleteConnection,
  getRegistryConnection,
  isRegistryAuthActive,
  markConnected,
  upsertPendingConnection,
} from '../../services/registryConnectionDb.js'
import { signPop } from '../../services/registryPopSigner.js'

/**
 * The self-hosted connect flow (spec §6.1/§6.3). control-ui JWT auth; the
 * deployment keypair is generated + held here, PoP-signed, and the registry's
 * public/PoP-gated register/status/claim endpoints are called (no machine admin
 * token — the deployment has none yet). Persists into registry_connection.
 * Managed mode has no connect flow (409 not_self_hosted).
 *
 * GET reports state ∈ disconnected|pending|connecting|approved|rejected|connected.
 * `connecting` means the registry auto-approved the registration and the
 * inline claim did not land yet; it is finished by POST
 * /admin/registry/connect/recover, never by pasting a token — under
 * auto-approval no operator ever issues one. `approved` keeps the original
 * operator-approved meaning: a human pastes the one-time claim token via POST
 * /admin/registry/connect/claim.
 *
 * Error mapping (C-M6): register 400 org_blocklisted and claim 409
 * already_claimed/client_unavailable are surfaced with distinct codes rather
 * than the opaque 502 registry_integration_error, and GET polls the registry
 * status endpoint so operator approval is visible before the user claims —
 * matching the register → poll status → claim flow.
 */
/** Bound every registry hop (registryClient.ts convention). */
const REGISTRY_FETCH_TIMEOUT_MS = 10_000

export function createRegistryConnectRouter(): Router {
  const router = Router()
  const base = (): string => `${config.registryUrl}/api/v1/deployments`

  type ClaimOutcome =
    | { kind: 'connected'; org: string }
    | { kind: 'expired' }
    | { kind: 'rejected' }
    | { kind: 'already_claimed' }
    | { kind: 'client_unavailable' }
    | { kind: 'superseded' }
    | { kind: 'unreachable'; err: unknown }
    | { kind: 'error'; status: number }

  // Single claim implementation shared by the manual paste route and the
  // auto-claim path. EXCEPTION-TOTAL: markConnected encrypts and writes to
  // Postgres AFTER the registry has already burned the one-time secret, so a
  // throw here must be a value the caller can act on, never an unhandled 500.
  async function redeemClaim(input: {
    deploymentId: string
    keyId: string
    privateKeyPem: string
    adminId: string
    claimToken: string
  }): Promise<ClaimOutcome> {
    try {
      const pop = signPop({
        privateKeyPem: input.privateKeyPem,
        sub: input.adminId,
        kid: input.keyId,
      })
      const claimRes = await fetch(`${base()}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', DPoP: pop },
        body: JSON.stringify({ claim_token: input.claimToken }),
        signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS),
      })
      if (claimRes.status === 410) return { kind: 'expired' }
      // The registry returns 401 for both invalid_pop and invalid_claim_token;
      // both mean the same to the operator — the claim was rejected.
      if (claimRes.status === 401) return { kind: 'rejected' }
      if (claimRes.status === 409) {
        const err = await readErrorCode(claimRes)
        return err === 'client_unavailable'
          ? { kind: 'client_unavailable' }
          : { kind: 'already_claimed' }
      }
      if (!claimRes.ok) {
        rootLogger.error(
          { event: 'registry_connect_claim_failed', status: claimRes.status },
          'claim failed'
        )
        return { kind: 'error', status: claimRes.status }
      }
      const claimed = (await claimRes.json()) as {
        client_id?: unknown
        client_secret?: unknown
        org?: unknown
      }
      // A hostile or mis-proxied registry must produce a clean outcome, not a
      // Buffer.from(null) crash inside the encryption path.
      if (
        typeof claimed.client_id !== 'string' ||
        claimed.client_id.length === 0 ||
        typeof claimed.client_secret !== 'string' ||
        claimed.client_secret.length === 0 ||
        typeof claimed.org !== 'string' ||
        claimed.org.length === 0
      ) {
        rootLogger.error(
          { event: 'registry_connect_claim_malformed', status: claimRes.status },
          'claim response missing required fields'
        )
        return { kind: 'error', status: claimRes.status }
      }
      const wrote = await markConnected({
        deploymentId: input.deploymentId,
        clientId: claimed.client_id,
        clientSecret: claimed.client_secret,
        orgName: claimed.org,
      })
      if (!wrote) {
        rootLogger.error(
          { event: 'registry_connect_claim_superseded', status: claimRes.status },
          'claim succeeded but the connection row moved; credentials are lost'
        )
        return { kind: 'superseded' }
      }
      return { kind: 'connected', org: claimed.org }
    } catch (err) {
      return { kind: 'unreachable', err }
    }
  }

  async function requireSelfHostedAdmin(
    req: Request,
    res: Response,
    options: { requireRegistryUrl?: boolean } = {}
  ): Promise<{ adminId: string } | null> {
    if (config.registryConnectionMode !== 'self-hosted') {
      res.status(409).json({ error: 'not_self_hosted' })
      return null
    }
    // Network-dependent connect routes need a configured registry URL. DELETE
    // is deliberately exempt: it only removes local credentials, and must
    // remain the recovery path after an operator removes a broken/stale URL.
    if (options.requireRegistryUrl !== false && config.registryUrl === '') {
      res.status(409).json({ error: 'registry_url_not_configured' })
      return null
    }
    const sub = (req as UiAuthedRequest).adminAuth?.sub
    const admin = sub ? await findAdminById(sub) : null
    if (!admin || admin.status !== 'active') {
      res.status(401).json({ error: 'unauthorized' })
      return null
    }
    return { adminId: admin.id }
  }

  // Poll the registry for the deployment's current lifecycle status. Best-effort:
  // a poll failure degrades to the locally-known pending state so GET never 500s
  // on a transient registry hiccup. Returns the parsed status/suspended/claimed
  // triple, or null on any failure.
  async function pollRegistryStatus(row: {
    deploymentId: string
    keyId: string
    privateKeyPem: string
    adminId: string
  }): Promise<{ status: string | null; suspended: boolean; claimed: boolean } | null> {
    try {
      const pop = signPop({ privateKeyPem: row.privateKeyPem, sub: row.adminId, kid: row.keyId })
      const statusRes = await fetch(`${base()}/${row.deploymentId}/status`, {
        method: 'GET',
        headers: { DPoP: pop },
        signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS),
      })
      if (!statusRes.ok) {
        rootLogger.warn(
          { event: 'registry_connect_status_poll_failed', status: statusRes.status },
          'status poll returned non-OK; degrading to local pending'
        )
        return null
      }
      const parsed = (await statusRes.json()) as {
        status?: unknown
        suspended?: unknown
        claimed?: unknown
      }
      return {
        status: typeof parsed.status === 'string' ? parsed.status : null,
        suspended: parsed.suspended === true,
        claimed: parsed.claimed === true,
      }
    } catch (err) {
      rootLogger.warn(
        { event: 'registry_connect_status_poll_error', err: (err as Error).message },
        'status poll threw; degrading to local pending'
      )
      return null
    }
  }

  // GET status — current state; polls the registry so operator approval is
  // visible pre-claim (state ∈ disconnected|pending|connecting|approved|rejected|connected).
  // `connecting` is finished via POST /admin/registry/connect/recover, not by
  // pasting a token.
  router.get(
    '/admin/registry/connect',
    requireAuthForControlUI,
    // Per-admin token bucket — this route is mounted by RegistryCatalog on
    // every Marketplace visit (control-ui/components/RegistryCatalog.tsx),
    // not just the connect panel, and is reachable by top-level cross-site
    // navigation (the session cookie is SameSite=Lax and this router has no
    // CSRF/origin check). Each call makes an outbound registry /status
    // fetch, so this bounds that outbound traffic under a CSRF-driven loop
    // while staying generous enough for normal navigation (Marketplace
    // mount, connect panel mount, refresh button).
    rateLimitMiddleware({
      bucketType: 'registry_connect_status',
      maxPerMinute: 30,
      getBucketKey: req => {
        const sub = (req as UiAuthedRequest).adminAuth?.sub
        return sub ? `registry_connect_status:${sub}` : null
      },
    }),
    async (req, res, next) => {
      try {
        const ctx = await requireSelfHostedAdmin(req, res)
        if (!ctx) return
        const row = await getRegistryConnection()
        // Hoisted: every branch below reports authEnabled, and this call is
        // cache-friendly here — getRegistryConnection() just populated (or hit)
        // the process-local cache that isRegistryAuthActive()'s self-hosted
        // path reads via resolveMachineCreds(), so this cannot trigger a fresh
        // Postgres round-trip on its own. It CAN still reject (a bare
        // pool.query with no try/catch of its own), so this is guarded the same
        // way the sibling admin registry routes guard it
        // (routes/admin/registry.ts's prepareKeysRequest/resolveSelfServiceOrg)
        // rather than letting it fall through to the generic catch below and
        // surface as a bare 500 — GET already documents a never-500-on-a-hiccup
        // guarantee for the status poll, and this preserves that for the newly
        // derived read too.
        let authEnabled: boolean
        try {
          authEnabled = await isRegistryAuthActive()
        } catch {
          res.status(502).json({ error: 'registry_integration_error' })
          return
        }
        if (!row) {
          res.status(200).json({ state: 'disconnected', authEnabled })
          return
        }
        if (row.status === 'connected') {
          res.status(200).json({
            state: 'connected',
            deploymentId: row.deploymentId,
            org: row.orgName,
            authEnabled,
          })
          return
        }
        // A locally-'approved' row is a registry auto-approval whose claim has
        // not landed. GET stays READ-ONLY: it reports state so the panel can
        // offer the recover button. It must never rotate — GET is also called by
        // RegistryCatalog on every Marketplace mount and is reachable by
        // cross-site navigation (SameSite=Lax), so a mutation here would rotate
        // claim tokens on catalog browsing and on CSRF.
        if (row.status === 'approved') {
          const poll = await pollRegistryStatus({
            deploymentId: row.deploymentId,
            keyId: row.keyId,
            privateKeyPem: row.privateKeyPem,
            adminId: ctx.adminId,
          })
          const recoveryError = poll?.claimed
            ? 'already_claimed'
            : poll?.suspended
              ? 'deployment_suspended'
              : undefined
          res.status(200).json({
            state: 'connecting',
            deploymentId: row.deploymentId,
            requestedOrgName: row.requestedOrgName,
            authEnabled,
            ...(recoveryError ? { recoveryError } : {}),
          })
          return
        }
        // Not yet connected — poll the registry so an operator approval (or
        // rejection) is reflected before the user attempts to claim.
        const poll = await pollRegistryStatus({
          deploymentId: row.deploymentId,
          keyId: row.keyId,
          privateKeyPem: row.privateKeyPem,
          adminId: ctx.adminId,
        })
        const registryStatus = poll?.status ?? null
        const state =
          registryStatus === 'approved'
            ? 'approved'
            : registryStatus === 'rejected'
              ? 'rejected'
              : 'pending'
        res.status(200).json({
          state,
          deploymentId: row.deploymentId,
          requestedOrgName: row.requestedOrgName,
          authEnabled,
        })
      } catch (err) {
        next(err)
      }
    }
  )

  // POST request — generate keypair, register with the registry, persist pending.
  router.post(
    '/admin/registry/connect/request',
    requireAuthForControlUI,
    // Per-admin token bucket — registration is a rare, deliberate,
    // once-in-a-deployment-lifetime action, and each call consumes one of
    // the shared registry's ~5/day per-IP registration attempts (and can
    // create a deployment row there). 3/min still allows a legitimate retry
    // after a transient failure (e.g. a typo'd org name) while capping how
    // much of that daily budget a looped admin can burn through in a single
    // minute.
    rateLimitMiddleware({
      bucketType: 'registry_connect_request',
      maxPerMinute: 3,
      getBucketKey: req => {
        const sub = (req as UiAuthedRequest).adminAuth?.sub
        return sub ? `registry_connect_request:${sub}` : null
      },
    }),
    async (req, res, next) => {
      try {
        const ctx = await requireSelfHostedAdmin(req, res)
        if (!ctx) return
        const existing = await getRegistryConnection()
        if (existing && existing.status === 'connected') {
          res.status(409).json({ error: 'already_connected' })
          return
        }
        // An 'approved' row is a registry-side auto-approval whose claim has not
        // landed. Re-registering would DELETE it (dropping the keypair), leaving
        // the approved deployment unrecoverable — rotate is PoP-gated — while it
        // permanently holds its org name. Recovery is the only way forward.
        if (existing && existing.status === 'approved') {
          res.status(409).json({ error: 'recovery_in_progress' })
          return
        }
        const body = (req.body ?? {}) as {
          requested_org_name?: unknown
          contact_email?: unknown
        }
        const requestedOrgName = body.requested_org_name
        const contactEmail = body.contact_email
        if (typeof requestedOrgName !== 'string' || typeof contactEmail !== 'string') {
          res.status(400).json({ error: 'invalid_request' })
          return
        }
        const { privateKey, publicKey } = generateKeyPairSync('rsa', {
          modulusLength: 2048,
          publicKeyEncoding: { type: 'spki', format: 'pem' },
          privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        })
        // Register PoP: signed by the NEW key, NO kid (the registry verifies it
        // against the body public_key_pem); its sub becomes designated_admin_sub.
        const pop = signPop({ privateKeyPem: privateKey, sub: ctx.adminId })
        const regRes = await fetch(`${base()}/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requested_org_name: requestedOrgName,
            public_key_pem: publicKey,
            contact_email: contactEmail,
            // Capability declaration: the registry auto-approves ONLY for clients
            // that can consume a 201 + claim_token. Without it, flipping the
            // registry's open-registration flag would strand every control-api
            // running code older than this change.
            deployment_info: { auto_claim: true, client: 'control-api' },
            pop,
          }),
          signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS),
        })
        // Every mapping is an ALLOWLIST with a stated default. readErrorCode
        // returns null on a non-JSON body (routine for an ingress-generated 429),
        // and an unbounded pass-through would reflect a registry-controlled
        // string into our response and the panel's code comparisons.
        if (regRes.status === 400) {
          const err = await readErrorCode(regRes)
          const known = [
            'org_blocklisted',
            'invalid_contact_email',
            'invalid_deployment_info',
            'deployment_info_too_large',
          ]
          res.status(400).json({ error: known.includes(err ?? '') ? err : 'invalid_request' })
          return
        }
        if (regRes.status === 409) {
          const err = await readErrorCode(regRes)
          if (err === 'org_name_taken' || err === 'jti_replayed') {
            res.status(409).json({ error: err })
            return
          }
          res.status(502).json({ error: 'registry_integration_error' })
          return
        }
        if (regRes.status === 429) {
          const err = await readErrorCode(regRes)
          const retryAfter = regRes.headers.get('retry-after')
          if (retryAfter) res.set('Retry-After', retryAfter)
          res.status(429).json({
            error: err === 'registration_capacity' ? 'registration_capacity' : 'rate_limited',
          })
          return
        }
        if (!regRes.ok) {
          rootLogger.error(
            { event: 'registry_connect_register_failed', status: regRes.status },
            'register failed'
          )
          res.status(502).json({ error: 'registry_integration_error' })
          return
        }
        // Checked BEFORE parsing the body: a 2xx status this route doesn't
        // expect (a proxy splash page, an empty 204) may carry a non-JSON
        // body, and parsing first would throw out of this handler and surface
        // as a bare 500 instead of the intended 502.
        if (regRes.status !== 201 && regRes.status !== 202) {
          rootLogger.error(
            { event: 'registry_connect_register_unexpected', status: regRes.status },
            'unexpected 2xx from register'
          )
          res.status(502).json({ error: 'registry_integration_error' })
          return
        }
        const reg = (await regRes.json()) as {
          deployment_id: string
          key_id: string
          claim_token?: unknown
        }
        // 201 IS the registry's approval, independent of whether this
        // particular response body carries a usable token. Deriving the
        // persisted status from the claim_token's presence/type instead of
        // the HTTP status would write 'pending' for an already-approved
        // deployment whenever the token is missing or malformed (partial
        // rollout, response-rewriting proxy). Task 5's recovery endpoint
        // refuses a 'pending' row, so that deployment could never recover and
        // would squat its org name forever.
        const isApproved = regRes.status === 201
        const hasClaimToken = typeof reg.claim_token === 'string'
        // Persist BEFORE claiming. The keypair is the only artifact that can
        // recover this deployment (rotate is PoP-gated); claiming first and dying
        // before the write would burn the one-time token AND lose the key.
        await upsertPendingConnection({
          deploymentId: reg.deployment_id,
          keyId: reg.key_id,
          publicKeyPem: publicKey,
          privateKeyPem: privateKey,
          requestedOrgName,
          contactEmail,
          registryUrl: config.registryUrl,
          status: isApproved ? 'approved' : 'pending',
        })
        if (!isApproved) {
          res
            .status(202)
            .json({ state: 'pending', deploymentId: reg.deployment_id, requestedOrgName })
          return
        }
        if (!hasClaimToken) {
          rootLogger.error(
            { event: 'registry_connect_auto_claim_missing_token', status: 0 },
            '201 response carried no usable claim_token; recovery is available'
          )
          res
            .status(202)
            .json({ state: 'connecting', deploymentId: reg.deployment_id, requestedOrgName })
          return
        }
        const outcome = await redeemClaim({
          deploymentId: reg.deployment_id,
          keyId: reg.key_id,
          privateKeyPem: privateKey,
          adminId: ctx.adminId,
          claimToken: reg.claim_token as string,
        })
        if (outcome.kind === 'connected') {
          // redeemClaim validated a non-empty credential pair and
          // markConnected committed it. Do not perform a second fallible DB
          // read after this irreversible one-time claim has succeeded: a
          // transient read failure must not turn a completed connection into a
          // misleading 502 response.
          res.status(200).json({
            state: 'connected',
            org: outcome.org,
            deploymentId: reg.deployment_id,
            authEnabled: true,
          })
          return
        }
        rootLogger.error(
          { event: 'registry_connect_auto_claim_failed', status: 0, outcome: outcome.kind },
          'auto-claim failed; recovery is available'
        )
        res
          .status(202)
          .json({ state: 'connecting', deploymentId: reg.deployment_id, requestedOrgName })
      } catch (err) {
        next(err)
      }
    }
  )

  // POST claim — redeem the claim token (PoP in the DPoP header), persist creds.
  router.post('/admin/registry/connect/claim', requireAuthForControlUI, async (req, res, next) => {
    try {
      const ctx = await requireSelfHostedAdmin(req, res)
      if (!ctx) return
      const row = await getRegistryConnection()
      if (!row || row.status === 'connected') {
        res.status(409).json({ error: 'not_pending' })
        return
      }
      const claimToken = (req.body as { claim_token?: unknown })?.claim_token
      if (typeof claimToken !== 'string') {
        res.status(400).json({ error: 'invalid_request' })
        return
      }
      const outcome = await redeemClaim({
        deploymentId: row.deploymentId,
        keyId: row.keyId,
        privateKeyPem: row.privateKeyPem,
        adminId: ctx.adminId,
        claimToken,
      })
      switch (outcome.kind) {
        case 'connected':
          res.status(200).json({ state: 'connected', org: outcome.org })
          return
        case 'expired':
          res.status(410).json({ error: 'claim_expired' })
          return
        case 'rejected':
          res.status(401).json({ error: 'claim_rejected' })
          return
        case 'already_claimed':
          res.status(409).json({ error: 'already_claimed' })
          return
        case 'client_unavailable':
          res.status(409).json({ error: 'client_unavailable' })
          return
        case 'superseded':
          res.status(409).json({ error: 'connection_superseded' })
          return
        // Preserves today's behaviour exactly: a registry-unreachable failure
        // threw out of this handler and became a 500. Collapsing it to 502 here
        // would be a silent contract change for the manual route.
        case 'unreachable':
          throw outcome.err
        case 'error':
          res.status(502).json({ error: 'registry_integration_error' })
          return
      }
    } catch (err) {
      next(err)
    }
  })

  // POST recover — finish an auto-approved connection whose inline claim failed.
  // Explicit POST rather than a side effect of GET: GET has a second caller
  // (RegistryCatalog) and is CSRF-reachable, and /:id/claim-token is unthrottled
  // at the registry.
  router.post(
    '/admin/registry/connect/recover',
    requireAuthForControlUI,
    // Per-admin token bucket — every call here rotates the deployment's
    // one-time claim token at the shared registry (/:id/claim-token), which
    // has no rate limiter of its own and emits a
    // deployment.claim_token_reissued audit event on each rotate. 10/min is
    // generous for a human-pressed recovery button while bounding registry
    // rotate/audit spam from a looped admin.
    rateLimitMiddleware({
      bucketType: 'registry_connect_recover',
      maxPerMinute: 10,
      getBucketKey: req => {
        const sub = (req as UiAuthedRequest).adminAuth?.sub
        return sub ? `registry_connect_recover:${sub}` : null
      },
    }),
    async (req, res, next) => {
      try {
        const ctx = await requireSelfHostedAdmin(req, res)
        if (!ctx) return
        const row = await getRegistryConnection()
        if (!row || row.status !== 'approved') {
          res.status(409).json({ error: 'not_recoverable' })
          return
        }
        // Cheapest check first: a read tells us whether a rotate can possibly
        // help, so a terminal state costs no mutation and no audit event.
        const poll = await pollRegistryStatus({
          deploymentId: row.deploymentId,
          keyId: row.keyId,
          privateKeyPem: row.privateKeyPem,
          adminId: ctx.adminId,
        })
        if (poll?.claimed) {
          res.status(409).json({ error: 'already_claimed' })
          return
        }
        if (poll?.suspended) {
          res.status(409).json({ error: 'deployment_suspended' })
          return
        }
        // Unreachable by construction: the registry's rejectDeployment is
        // gated `WHERE status = 'pending'`, so a locally-'approved' row can
        // never observe 'rejected' here — kept for defense in depth, which is
        // also why the panel has no dedicated UI branch for this code.
        if (poll?.status === 'rejected') {
          res.status(409).json({ error: 'rejected' })
          return
        }
        rootLogger.info(
          { event: 'registry_connect_recover_attempted', status: 0 },
          'attempting auto-claim recovery'
        )
        let claimToken: string
        try {
          const pop = signPop({
            privateKeyPem: row.privateKeyPem,
            sub: ctx.adminId,
            kid: row.keyId,
          })
          const rotRes = await fetch(`${base()}/${row.deploymentId}/claim-token`, {
            method: 'POST',
            headers: { DPoP: pop },
            signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS),
          })
          if (rotRes.status === 409) {
            res.status(409).json({ error: 'already_claimed' })
            return
          }
          if (!rotRes.ok) {
            rootLogger.error(
              { event: 'registry_connect_recover_rotate_failed', status: rotRes.status },
              'claim-token rotate failed'
            )
            res.status(202).json({ state: 'connecting', deploymentId: row.deploymentId })
            return
          }
          const rotated = (await rotRes.json()) as { claim_token?: unknown }
          if (typeof rotated.claim_token !== 'string') {
            res.status(202).json({ state: 'connecting', deploymentId: row.deploymentId })
            return
          }
          claimToken = rotated.claim_token
        } catch {
          // Never 500 on a registry hiccup — same guarantee the status poll makes.
          res.status(202).json({ state: 'connecting', deploymentId: row.deploymentId })
          return
        }
        const outcome = await redeemClaim({
          deploymentId: row.deploymentId,
          keyId: row.keyId,
          privateKeyPem: row.privateKeyPem,
          adminId: ctx.adminId,
          claimToken,
        })
        switch (outcome.kind) {
          case 'connected': {
            // Same committed-outcome rule as POST /request: recovery already
            // consumed the one-time token and stored a validated credential
            // pair, so its response must not depend on a redundant DB read.
            res.status(200).json({
              state: 'connected',
              org: outcome.org,
              authEnabled: true,
            })
            return
          }
          // Terminal: the client is disabled (operator suspension). Retrying
          // rotates forever against a deployment that was deliberately killed.
          case 'client_unavailable':
            rootLogger.error(
              { event: 'registry_connect_recover_terminal', status: 0 },
              'recovery terminal: client unavailable'
            )
            res.status(409).json({ error: 'client_unavailable' })
            return
          case 'already_claimed':
            res.status(409).json({ error: 'already_claimed' })
            return
          case 'superseded':
            res.status(409).json({ error: 'connection_superseded' })
            return
          case 'expired':
            res.status(409).json({ error: 'claim_expired' })
            return
          default:
            res.status(202).json({ state: 'connecting', deploymentId: row.deploymentId })
            return
        }
      } catch (err) {
        next(err)
      }
    }
  )

  // DELETE — disconnect (drop the row).
  router.delete('/admin/registry/connect', requireAuthForControlUI, async (req, res, next) => {
    try {
      const ctx = await requireSelfHostedAdmin(req, res, { requireRegistryUrl: false })
      if (!ctx) return
      await deleteConnection()
      res.status(204).end()
    } catch (err) {
      next(err)
    }
  })

  return router
}

/** Best-effort extraction of the `{ error }` code from a registry error body. */
async function readErrorCode(res: globalThis.Response): Promise<string | null> {
  try {
    const parsed = (await res.json()) as { error?: unknown }
    return typeof parsed.error === 'string' ? parsed.error : null
  } catch {
    return null
  }
}
