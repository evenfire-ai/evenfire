import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { randomBytes } from 'node:crypto'
import { config } from '../../config.js'
import {
  type ExternalAuthedRequest,
  rejectBodyUserTeamMismatch,
  requireValidExternalSessionToken,
} from '../../middleware/externalSessionAuth.js'
import { rateLimitMiddleware } from '../../middleware/rateLimitMiddleware.js'
import {
  acceptInvitationForEmail,
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
import { signExternalSessionToken } from '../../utils/auth/externalSessionAuthToken.js'

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
  const externalInvitationsEdgeRateLimit = rateLimit({
    windowMs: 60_000,
    limit: config.approvalRlExternalPerMin,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  })
  const externalDesktopAuthorizationRateLimit = rateLimit({
    windowMs: 60_000,
    limit: config.approvalRlExternalPerMin,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  })

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
    externalInvitationsEdgeRateLimit,
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
        if (validation.invitationUuid !== invitationId) {
          return res.status(403).json({ error: 'forbidden' })
        }

        const result = await setInvitationPasswordForEmail(
          validation.email,
          validation.invitationUuid,
          password
        )
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
          if (result.error === 'user_retired') {
            return res.status(401).json({ error: 'Unauthorized' })
          }
          return res.status(400).json({ error: 'invalid_password' })
        }

        const userId = result.data.userId
        if (!userId) {
          return res.status(409).json({ error: 'invitation_not_ready' })
        }
        const authGeneration = Number(result.data.authGeneration)
        if (
          result.data.lifecycleState !== 'active' ||
          !Number.isSafeInteger(authGeneration) ||
          authGeneration < 1
        ) {
          return res.status(409).json({ error: 'invitation_not_ready' })
        }

        const sessionToken = signExternalSessionToken({
          userId,
          email: result.data.email,
          teamId: result.data.teamId || null,
          role: result.data.role,
          authGeneration,
        })

        return res.status(200).json({
          ...result.data,
          token: sessionToken,
        })
      } catch (error) {
        return next(error)
      }
    }
  )

  router.post(
    '/external/invitations/password',
    externalInvitationsEdgeRateLimit,
    requireValidExternalSessionToken,
    rejectBodyUserTeamMismatch,
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
          if (result.error === 'user_retired') {
            return res.status(401).json({ error: 'Unauthorized' })
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
    externalDesktopAuthorizationRateLimit,
    requireValidExternalSessionToken,
    rejectBodyUserTeamMismatch,
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
    async (req, res, next) => {
      try {
        const email = String(req.query.email || '')
          .trim()
          .toLowerCase()
        if (!email) return res.status(400).json({ error: 'email is required' })
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
      const result = await acceptInvitationForEmail(validation.email, validation.invitationUuid)
      if ('error' in result) {
        if (result.error === 'not_found') {
          return res.status(404).json({ error: 'not_found' })
        }
        if (result.error === 'forbidden') {
          return res.status(403).json({ error: 'forbidden' })
        }
        if (result.error === 'expired') {
          return res.status(410).json({ error: 'expired' })
        }
        if (result.error === 'user_retired') {
          return res.status(401).json({ error: 'Unauthorized' })
        }
        return res.status(400).json({ error: 'not_pending' })
      }

      const authGeneration = Number(result.data.authGeneration)
      if (
        result.data.lifecycleState !== 'active' ||
        !Number.isSafeInteger(authGeneration) ||
        authGeneration < 1
      ) {
        return res.status(409).json({ error: 'invitation_not_ready' })
      }
      const sessionToken = signExternalSessionToken({
        userId: result.data.userId,
        email: result.data.email,
        teamId: result.data.teamId || null,
        role: result.data.role,
        authGeneration,
      })

      return res.status(200).json({
        ...result.data,
        token: sessionToken,
      })
    } catch (error) {
      return next(error)
    }
  })

  return router
}
