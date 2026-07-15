import { Router } from 'express'
import type { Request, Response } from 'express'
import { generateKeyPairSync } from 'node:crypto'
import { config } from '../../config.js'
import { type UiAuthedRequest, requireAuthForControlUI } from '../../middleware/controlUIAuth.js'
import { rootLogger } from '../../observability/logger.js'
import { findAdminById } from '../../services/adminAuthService.js'
import {
  deleteConnection,
  getRegistryConnection,
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
 * Error mapping (C-M6): register 400 org_blocklisted and claim 409
 * already_claimed/client_unavailable are surfaced with distinct codes rather
 * than the opaque 502 registry_integration_error, and GET polls the registry
 * status endpoint so operator approval is visible before the user claims —
 * matching the register → poll status → claim flow.
 */
export function createRegistryConnectRouter(): Router {
  const router = Router()
  const base = (): string => `${config.registryUrl}/api/v1/deployments`

  async function requireSelfHostedAdmin(
    req: Request,
    res: Response
  ): Promise<{ adminId: string } | null> {
    if (config.registryConnectionMode !== 'self-hosted') {
      res.status(409).json({ error: 'not_self_hosted' })
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
  // on a transient registry hiccup. Returns the registry status string or null.
  async function pollRegistryStatus(row: {
    deploymentId: string
    keyId: string
    privateKeyPem: string
    adminId: string
  }): Promise<string | null> {
    try {
      const pop = signPop({ privateKeyPem: row.privateKeyPem, sub: row.adminId, kid: row.keyId })
      const statusRes = await fetch(`${base()}/${row.deploymentId}/status`, {
        method: 'GET',
        headers: { DPoP: pop },
      })
      if (!statusRes.ok) {
        rootLogger.warn(
          { event: 'registry_connect_status_poll_failed', status: statusRes.status },
          'status poll returned non-OK; degrading to local pending'
        )
        return null
      }
      const parsed = (await statusRes.json()) as { status?: unknown }
      return typeof parsed.status === 'string' ? parsed.status : null
    } catch (err) {
      rootLogger.warn(
        { event: 'registry_connect_status_poll_error', err: (err as Error).message },
        'status poll threw; degrading to local pending'
      )
      return null
    }
  }

  // GET status — current state; polls the registry so operator approval is
  // visible pre-claim (state ∈ disconnected|pending|approved|rejected|connected).
  router.get('/admin/registry/connect', requireAuthForControlUI, async (req, res, next) => {
    try {
      const ctx = await requireSelfHostedAdmin(req, res)
      if (!ctx) return
      const row = await getRegistryConnection()
      if (!row) {
        res.status(200).json({ state: 'disconnected' })
        return
      }
      if (row.status === 'connected') {
        res
          .status(200)
          .json({ state: 'connected', deploymentId: row.deploymentId, org: row.orgName })
        return
      }
      // Not yet connected — poll the registry so an operator approval (or
      // rejection) is reflected before the user attempts to claim.
      const registryStatus = await pollRegistryStatus({
        deploymentId: row.deploymentId,
        keyId: row.keyId,
        privateKeyPem: row.privateKeyPem,
        adminId: ctx.adminId,
      })
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
      })
    } catch (err) {
      next(err)
    }
  })

  // POST request — generate keypair, register with the registry, persist pending.
  router.post(
    '/admin/registry/connect/request',
    requireAuthForControlUI,
    async (req, res, next) => {
      try {
        const ctx = await requireSelfHostedAdmin(req, res)
        if (!ctx) return
        const existing = await getRegistryConnection()
        if (existing && existing.status === 'connected') {
          res.status(409).json({ error: 'already_connected' })
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
            deployment_info: {},
            pop,
          }),
        })
        // C-M6: surface the registry's 400 rejection code (org_blocklisted /
        // invalid_request) instead of collapsing it into an opaque 502.
        if (regRes.status === 400) {
          const err = await readErrorCode(regRes)
          res
            .status(400)
            .json({ error: err === 'org_blocklisted' ? 'org_blocklisted' : 'invalid_request' })
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
        const reg = (await regRes.json()) as { deployment_id: string; key_id: string }
        await upsertPendingConnection({
          deploymentId: reg.deployment_id,
          keyId: reg.key_id,
          publicKeyPem: publicKey,
          privateKeyPem: privateKey,
          requestedOrgName,
          contactEmail,
          registryUrl: config.registryUrl,
        })
        res
          .status(202)
          .json({ state: 'pending', deploymentId: reg.deployment_id, requestedOrgName })
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
      const pop = signPop({ privateKeyPem: row.privateKeyPem, sub: ctx.adminId, kid: row.keyId })
      const claimRes = await fetch(`${base()}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', DPoP: pop },
        body: JSON.stringify({ claim_token: claimToken }),
      })
      if (claimRes.status === 410) {
        res.status(410).json({ error: 'claim_expired' })
        return
      }
      if (claimRes.status === 401) {
        // The registry returns 401 for both invalid_pop and invalid_claim_token;
        // both mean the same to the operator — the claim was rejected.
        res.status(401).json({ error: 'claim_rejected' })
        return
      }
      // C-M6: a claim 409 (already_claimed / client_unavailable) is a distinct,
      // actionable state — surface it rather than the opaque 502.
      if (claimRes.status === 409) {
        const err = await readErrorCode(claimRes)
        res
          .status(409)
          .json({ error: err === 'client_unavailable' ? 'client_unavailable' : 'already_claimed' })
        return
      }
      if (!claimRes.ok) {
        rootLogger.error(
          { event: 'registry_connect_claim_failed', status: claimRes.status },
          'claim failed'
        )
        res.status(502).json({ error: 'registry_integration_error' })
        return
      }
      const claimed = (await claimRes.json()) as {
        client_id: string
        client_secret: string
        org: string
      }
      await markConnected({
        clientId: claimed.client_id,
        clientSecret: claimed.client_secret,
        orgName: claimed.org,
      })
      res.status(200).json({ state: 'connected', org: claimed.org })
    } catch (err) {
      next(err)
    }
  })

  // DELETE — disconnect (drop the row).
  router.delete('/admin/registry/connect', requireAuthForControlUI, async (req, res, next) => {
    try {
      const ctx = await requireSelfHostedAdmin(req, res)
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
