import { Router } from 'express'
import { randomBytes } from 'node:crypto'
import { withTransaction } from '../../db.js'
import {
  type ExternalAuthedRequest,
  rejectBodyUserTeamMismatch,
  requireValidExternalSessionToken,
} from '../../middleware/externalSessionAuth.js'
import { authenticatedExternalUserRateLimit } from '../../middleware/externalUserRateLimitPolicy.js'
import { rateLimitMiddleware } from '../../middleware/rateLimitMiddleware.js'
import { resolveEffectiveUserAccessPolicy } from '../../services/access/userAccessRuntimePolicy.js'
import {
  issueExternalUserSession,
  selectExternalSessionRepresentation,
} from '../../services/auth/externalSessionIssuance.js'
import {
  acceptInvitationForEmailInTransaction,
  getInvitationByToken,
  listPendingInvitations,
  setInvitationPasswordForEmail,
  setInvitationPasswordForUser,
  verifyUserPassword,
} from '../../services/directory/index.js'
import {
  storeDesktopAuthorizationToken,
  validateInvitationFlowToken,
} from '../../services/invitationFlowRegistrationService.js'
import { memberRegistrationErrorResponse } from '../../services/memberRegistrationErrors.js'

function invitationLookupIpKey(req: {
  ip?: string
  socket?: { remoteAddress?: string }
}): string | null {
  const ip = req.ip ?? req.socket?.remoteAddress ?? null
  if (!ip) return null
  return `invite-token-ip:${String(ip).slice(0, 128)}`
}

export function createExternalInvitationsRouter(): Router {
  const router = Router()

  router.get(
    '/external/invitations/token/:token',
    rateLimitMiddleware({
      bucketType: 'external_invitation_lookup',
      maxPerMinute: 30,
      getBucketKey: req => invitationLookupIpKey(req),
    }),
    async (req, res, next) => {
      try {
        const token = String(req.params.token || '').trim()
        if (!token) {
          return res.status(400).json({ error: 'token is required' })
        }

        let validation: { email: string; invitationUuid: string }
        try {
          validation = await validateInvitationFlowToken(token)
        } catch (error) {
          if (memberRegistrationErrorResponse(error)) throw error
          return res.status(400).json({ error: 'invalid_invitation' })
        }
        const invitation = await getInvitationByToken(validation.invitationUuid)
        if (!invitation) {
          return res.status(404).json({ error: 'not_found' })
        }
        return res.status(200).json(invitation)
      } catch (error) {
        return next(error)
      }
    }
  )

  router.post(
    '/external/invitations/password-token',
    rateLimitMiddleware({
      bucketType: 'external_invitation_password_token',
      maxPerMinute: 10,
      getBucketKey: req => invitationLookupIpKey(req),
    }),
    async (req, res, next) => {
      try {
        const email = String(req.body?.email || '')
          .trim()
          .toLowerCase()
        const token = String(req.body?.token || '').trim()
        const invitationId = String(req.body?.invitationId || '').trim()
        const password = String(req.body?.password || '')
        if (!email || !token || !invitationId || !password) {
          return res.status(400).json({ error: 'invalid payload' })
        }

        let validation: { email: string; invitationUuid: string }
        try {
          validation = await validateInvitationFlowToken(token, email)
        } catch (error) {
          if (memberRegistrationErrorResponse(error)) throw error
          return res.status(400).json({ error: 'invalid_invitation' })
        }
        const result = await setInvitationPasswordForEmail(
          validation.email,
          validation.invitationUuid,
          invitationId,
          password
        )
        if ('error' in result) {
          if (result.error === 'not_found') {
            return res.status(404).json({ error: 'not_found' })
          }
          if (result.error === 'forbidden') {
            return res.status(403).json({ error: 'forbidden' })
          }
          if (result.error === 'not_pending') {
            return res.status(409).json({ error: 'invitation_not_pending' })
          }
          if (result.error === 'expired') {
            return res.status(410).json({ error: 'expired' })
          }
          return res.status(400).json({ error: 'invalid_password' })
        }

        if (!result.data.userId) {
          return res.status(409).json({ error: 'invitation_not_ready' })
        }

        return res.status(200).json({
          ...result.data,
          reauthenticationRequired: true,
        })
      } catch (error) {
        return next(error)
      }
    }
  )

  router.post(
    '/external/invitations/password',
    requireValidExternalSessionToken,
    rejectBodyUserTeamMismatch,
    ...authenticatedExternalUserRateLimit('invitation_mutation'),
    async (req, res, next) => {
      try {
        const userId = String(req.body?.userId || '').trim()
        const email = String(req.body?.email || '')
          .trim()
          .toLowerCase()
        const invitationId = String(req.body?.invitationId || '').trim()
        const password = String(req.body?.password || '')
        if (!userId || !email || !invitationId) {
          return res.status(400).json({ error: 'invalid payload' })
        }

        const result = await setInvitationPasswordForUser(userId, email, invitationId, password)
        if ('error' in result) {
          if (result.error === 'not_found') {
            return res.status(404).json({ error: 'not_found' })
          }
          if (result.error === 'forbidden') {
            return res.status(403).json({ error: 'forbidden' })
          }
          if (result.error === 'not_accepted') {
            return res.status(409).json({ error: 'invitation_not_accepted' })
          }
          if (result.error === 'not_pending') {
            return res.status(409).json({ error: 'invitation_not_pending' })
          }
          if (result.error === 'expired') {
            return res.status(410).json({ error: 'expired' })
          }
          return res.status(400).json({ error: 'invalid_password' })
        }
        return res.status(200).json(result.data)
      } catch (error) {
        return next(error)
      }
    }
  )

  router.post(
    '/external/invitations/desktop-authorization',
    requireValidExternalSessionToken,
    rejectBodyUserTeamMismatch,
    ...authenticatedExternalUserRateLimit('invitation_sensitive_action'),
    async (req, res, next) => {
      try {
        const userId = String(req.body?.userId || '').trim()
        const email = String(req.body?.email || '')
          .trim()
          .toLowerCase()
        const password = String(req.body?.password || '')
        if (!userId || !email || !password) {
          return res.status(400).json({ error: 'invalid payload' })
        }

        const passwordValid = await verifyUserPassword({ userId, email, password })
        if (!passwordValid) {
          return res.status(401).json({ error: 'invalid_password' })
        }

        const authorizationToken = randomBytes(24).toString('base64url')
        try {
          await storeDesktopAuthorizationToken(email, authorizationToken)
        } catch (error) {
          if (memberRegistrationErrorResponse(error)) throw error
          const message = error instanceof Error ? error.message : ''
          if (message.includes('(404)')) {
            return res.status(404).json({ error: 'not_found' })
          }
          throw error
        }
        return res.status(200).json({
          authorizationToken,
          expiresInSeconds: 120,
        })
      } catch (error) {
        return next(error)
      }
    }
  )

  router.get(
    '/external/invitations/pending',
    requireValidExternalSessionToken,
    ...authenticatedExternalUserRateLimit('invitation_read'),
    async (req, res, next) => {
      try {
        const email = String((req as ExternalAuthedRequest).externalAuth?.email || '')
          .trim()
          .toLowerCase()
        if (!email) return res.status(401).json({ error: 'Unauthorized' })
        return res.status(200).json({ items: await listPendingInvitations(email) })
      } catch (error) {
        return next(error)
      }
    }
  )

  router.post('/external/invitations/accept', async (req: ExternalAuthedRequest, res, next) => {
    try {
      const email = String(req.body?.email || '')
        .trim()
        .toLowerCase()
      const token = String(req.body?.token || '').trim()
      if (!email || !token) return res.status(400).json({ error: 'invalid payload' })

      let validation: { email: string; invitationUuid: string }
      try {
        validation = await validateInvitationFlowToken(token, email)
      } catch (error) {
        if (memberRegistrationErrorResponse(error)) throw error
        return res.status(400).json({ error: 'invalid_invitation' })
      }
      const policy = await resolveEffectiveUserAccessPolicy()
      const selection = selectExternalSessionRepresentation(
        {
          version: String(req.header('x-evenfire-client-version') || '').trim() || undefined,
          requestedContract:
            req.body?.sessionContract === 'v1' || req.body?.sessionContract === 'v2'
              ? req.body.sessionContract
              : undefined,
        },
        policy
      )
      if (selection.status !== 'selected') {
        return res.status(426).json({ error: 'upgrade_required' })
      }
      const accepted = await withTransaction(async db => {
        const result = await acceptInvitationForEmailInTransaction(
          db,
          validation.email,
          validation.invitationUuid
        )
        if ('error' in result && result.error) return { error: result.error }
        const lockedUser = await db.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [
          result.data.userId,
        ])
        if ((lockedUser.rowCount ?? 0) === 0) return { error: 'not_found' as const }
        const issued = await issueExternalUserSession(
          {
            contract: selection.contract,
            userId: result.data.userId,
            email: result.data.email,
            teamId: result.data.teamId,
            role: result.data.role,
            authenticationMethods: ['invitation'],
          },
          { db, policy }
        )
        return { data: result.data, issued }
      })
      if ('error' in accepted && accepted.error) {
        if (accepted.error === 'not_found') {
          return res.status(404).json({ error: 'not_found' })
        }
        if (accepted.error === 'forbidden') {
          return res.status(403).json({ error: 'forbidden' })
        }
        if (accepted.error === 'expired') {
          return res.status(410).json({ error: 'expired' })
        }
        return res.status(400).json({ error: 'not_pending' })
      }

      return res.status(200).json({
        ...accepted.data,
        token: accepted.issued.token,
        sessionContract: accepted.issued.contract,
      })
    } catch (error) {
      return next(error)
    }
  })

  return router
}
