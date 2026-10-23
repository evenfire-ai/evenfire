import { NextFunction, Request, Response, Router } from 'express'
import { verifyToken } from '../authToken.js'
import { ControlApiError } from '../controlApiClient.js'
import { sendPasswordAuthorityError } from '../http/passwordAdmissionError.js'
import { type AuthedRequest, extractAuthToken, requireAuth } from '../middleware/auth.js'
import { createRateLimiter } from '../middleware/rateLimit.js'
import {
  setupInvitationPassword,
  setupInvitationPasswordWithToken,
} from '../services/invitationPasswordService.js'
import {
  acceptInvitation,
  createDesktopAuthorization,
  getInvitationByToken,
  listPendingInvitations,
} from '../services/invitationsService.js'
import {
  PROFILE_SESSION_COOKIE,
  clearProfileSessionCookie,
  hasCookie,
  readCookie,
  setProfileSessionCookie,
} from '../sessionCookie.js'

const tokenLookupRateLimit = createRateLimiter({ windowMs: 60_000, maxRequests: 30 })
const acceptRateLimit = createRateLimiter({ windowMs: 60_000, maxRequests: 10 })

// The invitation password producer validates the trimmed value against the
// same inclusive bounds. The edge checks it before any acceptance so an invalid
// password cannot consume a still-pending invitation.
const INVITATION_PASSWORD_MIN_LENGTH = 8
const INVITATION_PASSWORD_MAX_LENGTH = 256

function isValidInvitationPassword(password: string): boolean {
  const trimmed = password.trim()
  return (
    trimmed.length >= INVITATION_PASSWORD_MIN_LENGTH &&
    trimmed.length <= INVITATION_PASSWORD_MAX_LENGTH
  )
}

function requestedSessionContract(req: Request): 'v2' | undefined {
  return req.header('x-evenfire-session-contract') === 'v2' ? 'v2' : undefined
}

type InvitationPasswordAuth = {
  userId: string
  email: string
  sessionToken: string
}

type AcceptInvitationError = 'not_found' | 'forbidden' | 'not_pending' | 'expired' | 'invalid'

function acceptInvitationErrorResponse(error: AcceptInvitationError): {
  status: number
  body: Record<string, string>
} {
  if (error === 'invalid') return { status: 400, body: { error: 'Invalid invitation' } }
  if (error === 'not_found') return { status: 404, body: { error: 'Invitation not found' } }
  if (error === 'forbidden') {
    return { status: 403, body: { error: 'Invitation email does not match authenticated user' } }
  }
  if (error === 'expired') return { status: 410, body: { error: 'Invitation has expired' } }
  return { status: 400, body: { error: 'Invitation is not pending' } }
}

// The password fallback publishes stable machine codes: profile-ui classifies
// terminal states from `code` (profile-ui/lib/invitationErrors.ts).
const FALLBACK_ACCEPT_ERROR_RESPONSES: Record<
  AcceptInvitationError,
  { status: number; body: Record<string, string> }
> = {
  invalid: { status: 400, body: { error: 'Invalid invitation' } },
  not_found: { status: 404, body: { error: 'Invitation not found', code: 'not_found' } },
  forbidden: { status: 403, body: { error: 'Invitation email does not match authenticated user' } },
  expired: { status: 410, body: { error: 'Invitation has expired', code: 'expired' } },
  not_pending: {
    status: 400,
    body: { error: 'Invitation is not pending', code: 'invitation_not_pending' },
  },
}

function fallbackAcceptErrorResponse(error: AcceptInvitationError): {
  status: number
  body: Record<string, string>
} {
  return FALLBACK_ACCEPT_ERROR_RESPONSES[error]
}

function sendAcceptInvitationError(res: Response, error: AcceptInvitationError): void {
  const response = acceptInvitationErrorResponse(error)
  res.status(response.status).json(response.body)
}

function sendInvitationPasswordError(
  res: Response,
  error:
    | 'not_found'
    | 'forbidden'
    | 'not_accepted'
    | 'not_pending'
    | 'expired'
    | 'invalid_invitation'
    | 'invalid_password'
    | 'password_already_set'
): void {
  if (error === 'invalid_invitation') {
    res.status(400).json({ error: 'invalid_invitation' })
    return
  }
  if (error === 'not_found') {
    res.status(404).json({ error: 'Invitation not found', code: 'not_found' })
    return
  }
  if (error === 'forbidden') {
    res.status(403).json({ error: 'Invitation is invalid or unavailable' })
    return
  }
  if (error === 'not_accepted') {
    res.status(409).json({ error: 'Invitation must be accepted before setting a password' })
    return
  }
  if (error === 'password_already_set') {
    res
      .status(409)
      .json({ error: 'This account already has a password', code: 'password_already_set' })
    return
  }
  if (error === 'not_pending') {
    res
      .status(409)
      .json({ error: 'Invitation has already been used', code: 'invitation_not_pending' })
    return
  }
  if (error === 'expired') {
    res.status(410).json({ error: 'Invitation has expired', code: 'expired' })
    return
  }
  res.status(400).json({ error: 'Password must be between 8 and 256 characters' })
}

function sendPasswordResetError(
  res: Response,
  error:
    | 'not_found'
    | 'forbidden'
    | 'not_accepted'
    | 'not_pending'
    | 'expired'
    | 'invalid_invitation'
    | 'invalid_password'
): void {
  const response = {
    not_found: { status: 404, code: 'not_found', message: 'Invitation not found' },
    forbidden: {
      status: 403,
      code: 'forbidden',
      message: 'Invitation is invalid or unavailable',
    },
    not_accepted: {
      status: 409,
      code: 'invitation_not_accepted',
      message: 'Invitation must be accepted before setting a password',
    },
    not_pending: {
      status: 409,
      code: 'invitation_not_pending',
      message: 'Invitation has already been used',
    },
    expired: { status: 410, code: 'expired', message: 'Invitation has expired' },
    invalid_invitation: {
      status: 400,
      code: 'invalid_invitation',
      message: 'This recovery link is invalid or expired',
    },
    invalid_password: {
      status: 400,
      code: 'invalid_password',
      message: 'Password must be between 8 and 256 characters',
    },
  }[error]
  res.status(response.status).json({ error: response.code, message: response.message })
}

// The session token a request presents. A present Authorization header must
// carry a bearer credential; any other value yields '' and fails verification
// instead of yielding to the cookie.
function presentedSessionToken(authorization: string | undefined, req: Request): string {
  if (authorization === undefined) return readCookie(req, PROFILE_SESSION_COOKIE)
  const raw = authorization.trim()
  return /^bearer\s+/i.test(raw) ? raw.replace(/^bearer\s+/i, '').trim() : ''
}

async function invitationPasswordAuthFromRequest(req: Request): Promise<
  | { auth: InvitationPasswordAuth }
  | {
      status: number
      body: Record<string, string>
    }
> {
  // A presented session credential is the only proof considered: an invalid
  // one fails closed instead of falling through to the invitation link.
  // Presence is decided before extraction, because extractAuthToken returns ''
  // for an empty or malformed credential and '' must not read as "absent".
  const authorization = req.headers.authorization
  if (authorization !== undefined || hasCookie(req, PROFILE_SESSION_COOKIE)) {
    const sessionToken = presentedSessionToken(authorization, req)
    // An empty or malformed credential is rejected before verification and
    // never reaches the verifier.
    if (!sessionToken) {
      return { status: 401, body: { error: 'Unauthorized' } }
    }
    const claims = verifyToken(sessionToken)
    if (!claims) {
      return { status: 401, body: { error: 'Unauthorized' } }
    }
    return { auth: { userId: claims.userId, email: claims.email, sessionToken } }
  }

  const token = String(req.body?.token || '').trim()
  const email = String(req.body?.email || '')
    .trim()
    .toLowerCase()
  if (!token || !email) {
    return { status: 401, body: { error: 'Unauthorized' } }
  }

  // Validate before this fallback accepts the invitation: that acceptance is a
  // one-time consumption, so an invalid password must be refused while the link
  // is still pending. A presented session never reaches this branch, so its
  // 401 precedence is unchanged.
  const password = String(req.body?.password || '')
  if (!isValidInvitationPassword(password)) {
    return { status: 400, body: { error: 'Password must be between 8 and 256 characters' } }
  }

  const accepted = await acceptInvitation(token, email, requestedSessionContract(req))
  if (accepted.error) {
    return fallbackAcceptErrorResponse(accepted.error)
  }
  // A replay is an explicit success without a session. It must not continue
  // into the password change: the token no longer proves a pending invitation,
  // so it maps exactly like a not-pending acceptance instead of the 502 that
  // marks a broken first-acceptance response.
  if (accepted.data?.replay) {
    return fallbackAcceptErrorResponse('not_pending')
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

function isInvalidInvitationProof(error: unknown): boolean {
  return (
    error instanceof ControlApiError && error.status === 400 && error.code === 'invalid_invitation'
  )
}

async function completePasswordReset(
  req: Request,
  res: Response,
  token: string,
  email: string,
  invitationId: string,
  password: string,
  // The reset producer cannot report password_already_set; type this hook to
  // the reset errors it can publish.
  sendError: typeof sendPasswordResetError = sendInvitationPasswordError
): Promise<void> {
  const result = await setupInvitationPasswordWithToken(token, email, invitationId, password)
  if (result.error) {
    sendError(res, result.error)
    return
  }
  if (!result.data) {
    res.status(502).json({ error: 'Password recovery service returned an invalid response' })
    return
  }
  clearProfileSessionCookie(req, res)
  res.status(200).json({ ...result.data, reauthenticationRequired: true })
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

      let invitation: Awaited<ReturnType<typeof getInvitationByToken>>
      try {
        invitation = await getInvitationByToken(token)
      } catch (error) {
        if (isInvalidInvitationProof(error)) {
          res.status(400).json({ error: 'invalid_invitation' })
          return
        }
        throw error
      }
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

      const token = String(req.body?.token || '').trim()
      const email = String(req.body?.email || '')
        .trim()
        .toLowerCase()
      if (token && email) {
        let preview: Awaited<ReturnType<typeof getInvitationByToken>>
        try {
          preview = await getInvitationByToken(token)
        } catch (error) {
          if (isInvalidInvitationProof(error)) {
            res.status(400).json({ error: 'invalid_invitation' })
            return
          }
          throw error
        }
        if (preview?.purpose === 'password_reset') {
          await completePasswordReset(req, res, token, email, invitationId, password)
          return
        }
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
      if (sendPasswordAuthorityError(error, res)) return
      next(error)
    }
  })

  router.post('/invitations/password-reset', acceptRateLimit, async (req: Request, res, next) => {
    try {
      const invitationId = String(req.body?.invitationId || '').trim()
      if (!invitationId) {
        res.status(400).json({ error: 'invitationId is required' })
        return
      }
      const token = String(req.body?.token || '').trim()
      const email = String(req.body?.email || '')
        .trim()
        .toLowerCase()
      if (!token || !email) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }
      const password = String(req.body?.password || '')
      await completePasswordReset(
        req,
        res,
        token,
        email,
        invitationId,
        password,
        sendPasswordResetError
      )
    } catch (error) {
      if (sendPasswordAuthorityError(error, res)) return
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
        if (sendPasswordAuthorityError(error, res)) return
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
      const accepted = result.data
      if (!accepted) {
        throw new Error('control-api accepted an invitation without a response payload')
      }
      if (accepted.replay) {
        const { token: _token, ...data } = accepted
        res.status(200).json(data)
        return
      }
      if (!accepted.token) {
        throw new Error('control-api accepted an invitation without issuing a session')
      }
      setProfileSessionCookie(req, res, accepted.token)
      const { token: _token, ...data } = accepted
      res.status(200).json(data)
    } catch (error) {
      next(error)
    }
  })

  return router
}
