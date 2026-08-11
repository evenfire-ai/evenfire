import { NextFunction, Request, Response, Router } from 'express'
import { verifyToken } from '../authToken.js'
import { type AuthedRequest, extractAuthToken, requireAuth } from '../middleware/auth.js'
import { createRateLimiter } from '../middleware/rateLimit.js'
import {
  acceptInvitation,
  createDesktopAuthorization,
  getInvitationByToken,
  listPendingInvitations,
  setupInvitationPassword,
  setupInvitationPasswordWithToken,
} from '../services/invitationsService.js'
import { clearProfileSessionCookie, setProfileSessionCookie } from '../sessionCookie.js'

const tokenLookupRateLimit = createRateLimiter({ windowMs: 60_000, maxRequests: 30 })
const acceptRateLimit = createRateLimiter({ windowMs: 60_000, maxRequests: 10 })

function requestedSessionContract(req: Request): 'v2' | undefined {
  return req.header('x-evenfire-session-contract') === 'v2' ? 'v2' : undefined
}

function sendAcceptInvitationError(
  res: Response,
  error: 'not_found' | 'forbidden' | 'not_pending' | 'expired' | 'invalid'
): void {
  if (error === 'invalid') {
    res.status(400).json({ error: 'Invalid invitation' })
    return
  }
  if (error === 'not_found') {
    res.status(404).json({ error: 'Invitation not found' })
    return
  }
  if (error === 'forbidden') {
    res.status(403).json({ error: 'Invitation email does not match authenticated user' })
    return
  }
  if (error === 'expired') {
    res.status(410).json({ error: 'Invitation has expired' })
    return
  }
  res.status(400).json({ error: 'Invitation is not pending' })
}

function sendInvitationPasswordError(
  res: Response,
  error: 'not_found' | 'forbidden' | 'not_accepted' | 'not_pending' | 'expired' | 'invalid_password'
): void {
  if (error === 'not_found') {
    res.status(404).json({ error: 'Invitation not found' })
    return
  }
  if (error === 'forbidden') {
    res.status(403).json({ error: 'Invitation email does not match authenticated user' })
    return
  }
  if (error === 'not_accepted') {
    res.status(409).json({ error: 'Invitation must be accepted before setting a password' })
    return
  }
  if (error === 'not_pending') {
    res.status(409).json({ error: 'Invitation has already been used' })
    return
  }
  if (error === 'expired') {
    res.status(410).json({ error: 'Invitation has expired' })
    return
  }
  res.status(400).json({ error: 'Password must be between 8 and 256 characters' })
}

export function createInvitationsRouter(): Router {
  const router = Router()

  router.get('/invitations/token/:token', tokenLookupRateLimit, async (req, res, next) => {
    try {
      const token = String(req.params.token || '').trim()
      if (!token) {
        res.status(400).json({ error: 'token is required' })
        return
      }

      const invitation = await getInvitationByToken(token)
      if (!invitation) {
        res.status(404).json({ error: 'Invitation not found' })
        return
      }
      res.status(200).json(invitation)
    } catch (error) {
      next(error)
    }
  })

  router.post('/invitations/password', acceptRateLimit, async (req: AuthedRequest, res, next) => {
    try {
      const invitationId = String(req.body?.invitationId || '').trim()
      const password = String(req.body?.password || '')
      if (!invitationId) {
        res.status(400).json({ error: 'invitationId is required' })
        return
      }

      const sessionToken = extractAuthToken(req)
      const claims = sessionToken ? verifyToken(sessionToken) : null
      const invitationToken = String(req.body?.token || '').trim()
      const invitationEmail = String(req.body?.email || '')
        .trim()
        .toLowerCase()
      if (!claims && (!invitationToken || !invitationEmail)) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }
      const result = claims
        ? await setupInvitationPassword(
            { userId: claims.userId, email: claims.email, sessionToken },
            invitationId,
            password
          )
        : await setupInvitationPasswordWithToken({
            token: invitationToken,
            email: invitationEmail,
            invitationId,
            password,
            sessionContract: requestedSessionContract(req),
          })
      if (result.error) {
        sendInvitationPasswordError(res, result.error)
        return
      }
      clearProfileSessionCookie(req, res)
      res.status(200).json({ ...result.data, reauthenticationRequired: true })
    } catch (error) {
      next(error)
    }
  })

  router.post(
    '/invitations/desktop-authorization',
    requireAuth,
    async (req: AuthedRequest, res, next) => {
      try {
        const auth = req.auth!
        const sessionToken = extractAuthToken(req)
        const password = String(req.body?.password || '')
        if (!password) {
          res.status(400).json({ error: 'password is required' })
          return
        }

        const result = await createDesktopAuthorization({ ...auth, sessionToken }, password)
        if (result.error === 'not_found') {
          res.status(404).json({ error: 'Invitation setup not found' })
          return
        }
        if (result.error === 'invalid_password') {
          res.status(401).json({ error: 'Invalid password' })
          return
        }
        res.status(200).json(result.data)
      } catch (error) {
        next(error)
      }
    }
  )

  router.get('/invitations/pending', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const auth = req.auth!
      const sessionToken = extractAuthToken(req)
      res.status(200).json({ items: await listPendingInvitations(auth.email, sessionToken) })
    } catch (error) {
      next(error)
    }
  })

  router.post('/invitations/accept', acceptRateLimit, async (req: AuthedRequest, res, next) => {
    try {
      const token = String(req.body?.token || '').trim()
      const email = String(req.body?.email || '')
        .trim()
        .toLowerCase()
      if (!token || !email) {
        res.status(400).json({ error: 'token and email are required' })
        return
      }

      const result = await acceptInvitation(token, email, requestedSessionContract(req))
      if (result.error) {
        sendAcceptInvitationError(res, result.error)
        return
      }
      setProfileSessionCookie(req, res, result.data!.token)
      const { token: _token, ...data } = result.data!
      res.status(200).json(data)
    } catch (error) {
      next(error)
    }
  })

  return router
}
