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
} from '../services/invitationsService.js'
import { clearProfileSessionCookie, setProfileSessionCookie } from '../sessionCookie.js'

const tokenLookupRateLimit = createRateLimiter({ windowMs: 60_000, maxRequests: 30 })
const acceptRateLimit = createRateLimiter({ windowMs: 60_000, maxRequests: 10 })

type InvitationPasswordAuth = {
  userId: string
  email: string
  sessionToken: string
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

async function invitationPasswordAuthFromRequest(req: Request): Promise<
  | { auth: InvitationPasswordAuth }
  | {
      status: number
      body: Record<string, string>
    }
> {
  const sessionToken = extractAuthToken(req)
  if (sessionToken) {
    const claims = verifyToken(sessionToken)
    if (claims) {
      return { auth: { userId: claims.userId, email: claims.email, sessionToken } }
    }
  }

  const token = String(req.body?.token || '').trim()
  const email = String(req.body?.email || '')
    .trim()
    .toLowerCase()
  if (!token || !email) {
    return { status: 401, body: { error: 'Unauthorized' } }
  }

  const accepted = await acceptInvitation(token, email)
  if (accepted.error) {
    const response = {
      invalid: { status: 400, body: { error: 'Invalid invitation' } },
      not_found: { status: 404, body: { error: 'Invitation not found' } },
      forbidden: {
        status: 403,
        body: { error: 'Invitation email does not match authenticated user' },
      },
      expired: { status: 410, body: { error: 'Invitation has expired' } },
      not_pending: { status: 400, body: { error: 'Invitation is not pending' } },
    }[accepted.error]
    return response ?? { status: 502, body: { error: 'Failed to start invited session' } }
  }
  if (!accepted.data?.token || !accepted.data.userId) {
    return { status: 502, body: { error: 'Failed to start invited session' } }
  }

  return {
    auth: {
      userId: accepted.data.userId,
      email: accepted.data.email,
      sessionToken: accepted.data.token,
    },
  }
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

      const authResult = await invitationPasswordAuthFromRequest(req)
      if ('status' in authResult) {
        res.status(authResult.status).json(authResult.body)
        return
      }

      const result = await setupInvitationPassword(authResult.auth, invitationId, password)
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

      const result = await acceptInvitation(token, email)
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
