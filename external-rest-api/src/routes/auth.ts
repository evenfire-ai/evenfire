import { Request, Response, Router } from 'express'
import { OAuth2Client } from 'google-auth-library'
import { config } from '../config.js'
import { ControlApiError } from '../controlApiClient.js'
import { sendPasswordAuthorityError } from '../http/passwordAdmissionError.js'
import { createRateLimiter } from '../middleware/rateLimit.js'
import {
  loginWithGoogle,
  loginWithPassword,
  requestPasswordReset,
} from '../services/authService.js'
import { clearProfileSessionCookie, setProfileSessionCookie } from '../sessionCookie.js'

const googleClient = new OAuth2Client(config.googleClientId)
const passwordResetRateLimit = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 5,
  keyFn: req => {
    const email = String(req.body?.email || '')
      .trim()
      .toLowerCase()
    return email || req.socket.remoteAddress || 'unknown'
  },
})

function isControlApiStatus(error: unknown, status: number): error is ControlApiError {
  return error instanceof ControlApiError && error.status === status
}

type GooglePayload = {
  email: string
  name?: string
  picture?: string
}

type LoginResponse = {
  token: string
  me: unknown
}

function shouldExposeBearerToken(req: { header: (name: string) => string | undefined }): boolean {
  // Desktop App signs in from a native HTTP client and still needs the bearer
  // token body. Browser Profile UI requests include Origin or Fetch Metadata
  // headers that scripts cannot suppress, so the token stays only in the
  // HttpOnly cookie for those responses. This is a token-body exposure gate;
  // cookie auth remains the browser security boundary.
  const origin = String(req.header('origin') || '').trim()
  const fetchSite = String(req.header('sec-fetch-site') || '').trim()
  return !origin && !fetchSite
}

function sendLoginResponse(req: Request, res: Response, result: LoginResponse): void {
  setProfileSessionCookie(req, res, result.token)
  const body = shouldExposeBearerToken(req)
    ? { token: result.token, me: result.me }
    : { me: result.me }
  res.status(200).json(body)
}

async function verifyGoogleToken(idToken: string): Promise<GooglePayload> {
  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: config.googleClientId,
  })
  const payload = ticket.getPayload()
  if (!payload?.email) {
    throw new Error('Google token has no email')
  }
  return {
    email: payload.email.toLowerCase(),
    name: payload.name,
    picture: payload.picture,
  }
}

export function createAuthRouter(): Router {
  const router = Router()

  router.post('/auth/google', async (req, res, next) => {
    try {
      const idToken = String(req.body?.idToken || '')
      if (!idToken) {
        res.status(400).json({ error: 'idToken is required' })
        return
      }

      await verifyGoogleToken(idToken)
      const result = await loginWithGoogle({ idToken })
      sendLoginResponse(req, res, result)
    } catch (error) {
      if (isControlApiStatus(error, 404)) {
        res.status(404).json({ error: 'user_not_found' })
        return
      }
      if (isControlApiStatus(error, 403)) {
        res.status(403).json({ error: 'membership_not_found' })
        return
      }
      next(error)
    }
  })

  router.post('/auth/password-login', async (req, res, next) => {
    try {
      const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : ''
      const password = typeof req.body?.password === 'string' ? req.body.password : ''
      if (!email || !password || email.length > 320 || password.length > 256) {
        res.status(400).json({ error: 'invalid_request' })
        return
      }
      const result = await loginWithPassword(email, password)
      sendLoginResponse(req, res, result)
    } catch (error) {
      if (error instanceof ControlApiError && [401, 403, 409].includes(error.status)) {
        res.status(401).json({ error: 'invalid_credentials' })
        return
      }
      if (sendPasswordAuthorityError(error, res)) return
      next(error)
    }
  })

  router.post('/auth/password-reset/request', passwordResetRateLimit, async (req, res, next) => {
    try {
      const email = String(req.body?.email || '')
        .trim()
        .toLowerCase()
      await requestPasswordReset(email)
      res.status(200).json({ requested: true })
    } catch (error) {
      next(error)
    }
  })

  router.post('/auth/logout', (req, res) => {
    clearProfileSessionCookie(req, res)
    res.status(200).json({ ok: true })
  })

  return router
}
