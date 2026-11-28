import { type Request, Router } from 'express'
import { randomBytes } from 'node:crypto'
import { config } from '../../config.js'
import { withTransaction } from '../../db.js'
import {
  createExternalClientRateLimiters,
  externalClientIpRateLimitKey,
} from '../../middleware/externalClientIdentity.js'
import {
  type ExternalAuthedRequest,
  rejectBodyUserTeamMismatch,
  requireValidExternalSessionToken,
} from '../../middleware/externalSessionAuth.js'
import { requireAuthenticatedExternalUserRateLimitContext } from '../../middleware/externalUserRateLimitPolicy.js'
import { sendPasswordAdmissionError } from '../../middleware/passwordLoginAdmission.js'
import { rateLimitMiddleware } from '../../middleware/rateLimitMiddleware.js'
import { resolveEffectiveUserAccessPolicy } from '../../services/access/userAccessRuntimePolicy.js'
import {
  issueExternalUserSession,
  selectExternalSessionRepresentation,
} from '../../services/auth/externalSessionIssuance.js'
import { lockUserById } from '../../services/auth/oidcAccountResolution.js'
import {
  acceptInvitationForEmailInTransaction,
  getInvitationByToken,
  listPendingInvitations,
  setInvitationPasswordForEmail,
  setInvitationPasswordForUser,
} from '../../services/directory/index.js'
import {
  storeDesktopAuthorizationToken,
  validateInvitationFlowToken,
} from '../../services/invitationFlowRegistrationService.js'
import { memberRegistrationErrorResponse } from '../../services/memberRegistrationErrors.js'

function invitationAdmissionKey(req: Request, operation: 'preview' | 'password-token'): string {
  return `invite-token:${operation}:${externalClientIpRateLimitKey(req)}`
}

// Password setup never returns a session representation. Strip the fields at
// the public boundary even if a directory implementation supplies them.
function withoutSessionResponseFields<T extends object>(
  data: T
): Omit<T, 'sessionContext' | 'token'> {
  const {
    sessionContext: _sessionContext,
    token: _token,
    ...response
  } = data as T & {
    sessionContext?: unknown
    token?: unknown
  }
  return response
}

/**
 * The signed-in session's email, read from its live, active account row and
 * lowercased, or '' when the session names no user or the row is missing or
 * not active. The claim is not read: a v1 session keeps the email it was
 * issued with after an admin changes the account's address.
 */
async function liveSessionAccountEmail(req: ExternalAuthedRequest): Promise<string> {
  const userId = String(req.externalAuth?.userId || '').trim()
  if (!userId) return ''
  const account = await withTransaction(db => lockUserById(db, userId))
  return account?.lifecycle_state === 'active'
    ? String(account.email || '')
        .trim()
        .toLowerCase()
    : ''
}

export function createExternalInvitationsRouter(): Router {
  const router = Router()
  const externalInvitationsEdgeRateLimits = createExternalClientRateLimiters(
    'invitations',
    config.approvalRlExternalClientIpPerMin,
    config.approvalRlExternalEdgePerMin
  )

  router.get(
    '/external/invitations/token/:token',
    ...externalInvitationsEdgeRateLimits,
    rateLimitMiddleware({
      bucketType: 'external_invitation_lookup',
      maxPerMinute: 30,
      getBucketKey: req => invitationAdmissionKey(req, 'preview'),
      onBackendUnavailable: 'process-memory',
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
    ...externalInvitationsEdgeRateLimits,
    rateLimitMiddleware({
      bucketType: 'external_invitation_password_token',
      maxPerMinute: 10,
      getBucketKey: req => invitationAdmissionKey(req, 'password-token'),
      onBackendUnavailable: 'process-memory',
    }),
    async (req, res, next) => {
      try {
        const email = String(req.body?.email || '')
          .trim()
          .toLowerCase()
        const token = String(req.body?.token || '').trim()
        const invitationId = String(req.body?.invitationId || '').trim()
        const password = String(req.body?.password || '')
        if (!email || !token || !invitationId) {
          return res.status(400).json({ error: 'invalid payload' })
        }
        if (!password) {
          return res.status(400).json({ error: 'invalid_password' })
        }

        let validation: { email: string; invitationUuid: string }
        try {
          validation = await validateInvitationFlowToken(token, email)
        } catch (error) {
          if (memberRegistrationErrorResponse(error)) throw error
          return res.status(400).json({ error: 'invalid_invitation' })
        }
        // Bind the trusted provider token to the submitted database row before
        // the password service performs its independent lock-and-currentness check.
        const invitation = await getInvitationByToken(validation.invitationUuid)
        if (!invitation || invitation.id !== invitationId) {
          return res.status(403).json({ error: 'forbidden' })
        }
        if (
          invitation.email.toLowerCase() !== validation.email.toLowerCase() ||
          invitation.purpose !== 'password_reset' ||
          invitation.status !== 'pending'
        ) {
          return res.status(409).json({ error: 'invitation_not_pending' })
        }

        const result = await setInvitationPasswordForEmail(
          validation.email,
          invitation.id,
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
          if (result.error === 'user_retired') {
            return res.status(401).json({ error: 'user_retired' })
          }
          return res.status(400).json({ error: 'invalid_password' })
        }

        const userId = result.data.userId
        if (!userId) {
          return res.status(409).json({ error: 'invitation_not_ready' })
        }
        return res.status(200).json({
          ...withoutSessionResponseFields(result.data),
          reauthenticationRequired: true,
        })
      } catch (error) {
        if (sendPasswordAdmissionError(error, res)) return
        return next(error)
      }
    }
  )

  router.post(
    '/external/invitations/password',
    ...externalInvitationsEdgeRateLimits,
    requireValidExternalSessionToken,
    rejectBodyUserTeamMismatch,
    requireAuthenticatedExternalUserRateLimitContext,
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

        const result = await setInvitationPasswordForUser(
          userId,
          email,
          invitationId,
          password,
          undefined,
          { rejectIfPasswordAlreadySet: true }
        )
        if ('error' in result) {
          if (result.error === 'not_found') {
            return res.status(404).json({ error: 'not_found' })
          }
          if (result.error === 'forbidden') {
            return res.status(403).json({ error: 'forbidden' })
          }
          if (result.error === 'password_already_set') {
            return res.status(409).json({ error: 'password_already_set' })
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
            return res.status(401).json({ error: 'user_retired' })
          }
          return res.status(400).json({ error: 'invalid_password' })
        }
        return res.status(200).json(withoutSessionResponseFields(result.data))
      } catch (error) {
        if (sendPasswordAdmissionError(error, res)) return
        return next(error)
      }
    }
  )

  router.post(
    '/external/invitations/desktop-authorization',
    ...externalInvitationsEdgeRateLimits,
    requireValidExternalSessionToken,
    rejectBodyUserTeamMismatch,
    requireAuthenticatedExternalUserRateLimitContext,

    async (req: ExternalAuthedRequest, res, next) => {
      try {
        // The signed-in session is the only authority for /desktop-setup: no
        // body field is read, so a request cannot name another member, and no
        // password is asked for, so a member without one can authorize too.
        // The email comes from the session's live, active account row, not
        // its claim (liveSessionAccountEmail).
        const email = await liveSessionAccountEmail(req)
        if (!email) return res.status(401).json({ error: 'Unauthorized' })

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
    ...externalInvitationsEdgeRateLimits,
    requireValidExternalSessionToken,
    requireAuthenticatedExternalUserRateLimitContext,
    async (req: ExternalAuthedRequest, res, next) => {
      try {
        // The live account row's email, as /desktop-authorization reads it:
        // a v1 session's claim can name an address the account no longer has.
        const email = await liveSessionAccountEmail(req)
        if (!email) return res.status(401).json({ error: 'Unauthorized' })
        return res.status(200).json({ items: await listPendingInvitations(email) })
      } catch (error) {
        return next(error)
      }
    }
  )

  router.post(
    '/external/invitations/accept',
    ...externalInvitationsEdgeRateLimits,
    async (req: ExternalAuthedRequest, res, next) => {
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
          // Only the transaction that consumed a pending invitation proves the
          // capability. A replay must stay a success without minting a session,
          // because the token may already be public knowledge.
          if ('replay' in result.data) return { data: result.data, replay: true as const }
          // The acceptance locked the user row before its membership writes;
          // issuance reuses that locked row instead of locking it again.
          const issued = await issueExternalUserSession(
            {
              contract: selection.contract,
              userId: result.data.userId,
              email: result.data.email,
              teamId: result.data.teamId,
              role: result.data.role,
              authGeneration: Number(result.data.authGeneration),
              authenticationMethods: ['invitation'],
            },
            { db, policy, lockedUser: result.lockedUser }
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
          if (accepted.error === 'user_retired') {
            return res.status(401).json({ error: 'Unauthorized' })
          }
          return res.status(400).json({ error: 'not_pending' })
        }
        if ('replay' in accepted) {
          return res.status(200).json(accepted.data)
        }

        return res.status(200).json({
          ...accepted.data,
          token: accepted.issued.token,
          sessionContract: accepted.issued.contract,
        })
      } catch (error) {
        return next(error)
      }
    }
  )

  return router
}
