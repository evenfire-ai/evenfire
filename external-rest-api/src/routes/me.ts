import { Router } from 'express'
import {
  type AuthedRequest,
  extractAuthToken,
  requireAuth,
  requireSelf,
} from '../middleware/auth.js'
import { createRateLimiter } from '../middleware/rateLimit.js'
import {
  getMe,
  getMyAgents,
  getMyContexts,
  getMyTeamDirectory,
  listTeams,
  switchTeam,
  updatePassword,
  updateProfile,
} from '../services/meService.js'
import { setProfileSessionCookie } from '../sessionCookie.js'

const teamDirectoryRateLimit = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 10,
  keyFn: req => {
    const userId = (req as AuthedRequest).auth?.userId
    return userId ? `team-directory:${userId}` : 'team-directory:unknown'
  },
})

export function createMeRouter(): Router {
  const router = Router()

  router.get('/me/teams', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const auth = req.auth!
      const sessionToken = extractAuthToken(req)
      res.status(200).json(await listTeams(auth.userId, auth.teamId, sessionToken))
    } catch (error) {
      next(error)
    }
  })

  router.get(
    '/me/teams/directory',
    requireAuth,
    teamDirectoryRateLimit,
    async (req: AuthedRequest, res, next) => {
      try {
        const auth = req.auth!
        const sessionToken = extractAuthToken(req)
        res.status(200).json(await getMyTeamDirectory(auth.userId, sessionToken))
      } catch (error) {
        next(error)
      }
    }
  )

  router.post('/me/switch-team', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const auth = req.auth!
      const sessionToken = extractAuthToken(req)
      const nextTeamId = String(req.body?.teamId || '').trim()
      if (!nextTeamId) {
        res.status(400).json({ error: 'teamId is required' })
        return
      }

      const result = await switchTeam(auth.userId, auth.email, nextTeamId, sessionToken, req.ip)
      if (!result) {
        res.status(403).json({ error: 'You are not a member of this team' })
        return
      }
      const browserRequest = Boolean(req.header('origin') || req.header('sec-fetch-site'))
      if (browserRequest) setProfileSessionCookie(req, res, result.token)
      res.status(200).json(browserRequest ? { team: result.team } : result)
    } catch (error) {
      next(error)
    }
  })

  router.get('/me', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const auth = req.auth!
      const sessionToken = extractAuthToken(req)
      const me = await getMe(auth.userId, auth.teamId, sessionToken)
      if (!me) {
        res.status(404).json({ error: 'User not found' })
        return
      }
      res.status(200).json(me)
    } catch (error) {
      next(error)
    }
  })

  router.get('/me/contexts', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const auth = req.auth!
      const sessionToken = extractAuthToken(req)
      res.status(200).json(await getMyContexts(auth.userId, sessionToken))
    } catch (error) {
      next(error)
    }
  })

  router.get('/me/agents', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const auth = req.auth!
      const sessionToken = extractAuthToken(req)
      res.status(200).json(await getMyAgents(auth.userId, sessionToken))
    } catch (error) {
      next(error)
    }
  })

  router.put(
    '/me/profile',
    requireAuth,
    requireSelf('userId'),
    async (req: AuthedRequest, res, next) => {
      try {
        const auth = req.auth!
        const displayName = String(req.body?.displayName || '').trim()
        const sessionToken = extractAuthToken(req)
        res
          .status(200)
          .json(await updateProfile(auth.userId, displayName, req.body?.channels, sessionToken))
      } catch (error) {
        next(error)
      }
    }
  )

  router.put('/me/password', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const auth = req.auth!
      const sessionToken = extractAuthToken(req)
      const currentPassword = String(req.body?.currentPassword || '')
      const newPassword = String(req.body?.newPassword || '')
      if (!currentPassword || !newPassword) {
        res.status(400).json({ error: 'Current password and new password are required' })
        return
      }
      res
        .status(200)
        .json(await updatePassword(auth.userId, currentPassword, newPassword, sessionToken))
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (message.includes('(401)')) {
        res.status(401).json({ error: 'Invalid current password' })
        return
      }
      if (message.includes('(409)')) {
        res.status(409).json({ error: 'Password is not set' })
        return
      }
      if (message.includes('(400)')) {
        res.status(400).json({ error: 'Password must be between 8 and 256 characters' })
        return
      }
      next(error)
    }
  })

  return router
}
