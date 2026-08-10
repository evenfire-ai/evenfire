import { Router } from 'express'
import { type AuthedRequest, extractAuthToken, requireAuth } from '../middleware/auth.js'
import {
  createTeamForUser,
  deleteMember,
  getCurrentTeam,
  getTeamAgents,
  getTeamContexts,
  inviteMember,
  listMembers,
  renameTeam,
  updateMemberRole,
} from '../services/teamService.js'
import { TeamRole } from '../types.js'

export function createTeamRouter(): Router {
  const router = Router()

  router.get('/team', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const auth = req.auth!
      const sessionToken = extractAuthToken(req)
      const team = await getCurrentTeam({ ...auth, sessionToken })
      if (!team) {
        res.status(200).json({ team: null })
        return
      }
      res.status(200).json({ team })
    } catch (error) {
      next(error)
    }
  })

  router.post('/team', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const auth = req.auth!
      const sessionToken = extractAuthToken(req)
      const name = String(req.body?.name || '').trim()
      if (!name) {
        res.status(400).json({ error: 'Team name is required' })
        return
      }
      const result = await createTeamForUser({ ...auth, sessionToken }, name)
      const browserRequest = Boolean(req.header('origin') || req.header('sec-fetch-site'))
      res.status(201).json(browserRequest ? { team: result.team } : result)
    } catch (error) {
      next(error)
    }
  })

  router.put('/team/name', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const auth = req.auth!
      const sessionToken = extractAuthToken(req)
      const name = String(req.body?.name || '').trim()
      if (!name) {
        res.status(400).json({ error: 'Team name is required' })
        return
      }

      const result = await renameTeam({ ...auth, sessionToken }, name)
      if (result.error === 'forbidden') {
        res.status(403).json({ error: 'You are not allowed to rename the team' })
        return
      }
      if (result.error === 'not_found') {
        res.status(404).json({ error: 'Team not found' })
        return
      }
      res.status(200).json(result)
    } catch (error) {
      next(error)
    }
  })

  router.get('/team/members', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const auth = req.auth!
      const sessionToken = extractAuthToken(req)
      res.status(200).json({ items: await listMembers(auth.teamId, sessionToken) })
    } catch (error) {
      next(error)
    }
  })

  router.get('/team/contexts', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const auth = req.auth!
      const sessionToken = extractAuthToken(req)
      res.status(200).json(await getTeamContexts(auth.teamId, sessionToken))
    } catch (error) {
      next(error)
    }
  })

  router.get('/team/agents', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const auth = req.auth!
      const sessionToken = extractAuthToken(req)
      res.status(200).json(await getTeamAgents(auth.teamId, sessionToken))
    } catch (error) {
      next(error)
    }
  })

  router.patch('/team/members/:userId/role', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const auth = req.auth!
      const sessionToken = extractAuthToken(req)
      const targetUserId = req.params.userId
      const newRole = String(req.body?.role || '').trim() as TeamRole

      if (!targetUserId || !['admin', 'inviter', 'member'].includes(newRole)) {
        res.status(400).json({ error: 'Target user and valid role are required' })
        return
      }

      const result = await updateMemberRole({ ...auth, sessionToken }, targetUserId, newRole)
      if (result.error === 'bad_request') {
        res
          .status(400)
          .json({ error: 'Use dedicated self-role flow; self role change disabled here' })
        return
      }
      if (result.error === 'not_found') {
        res.status(404).json({ error: 'Target member not found' })
        return
      }
      if (result.error === 'forbidden') {
        res.status(403).json({ error: 'You are not allowed to change roles' })
        return
      }

      res.status(200).json(result.data)
    } catch (error) {
      next(error)
    }
  })

  router.post('/team/members/invite', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const auth = req.auth!
      const sessionToken = extractAuthToken(req)
      const email = String(req.body?.email || '')
        .trim()
        .toLowerCase()
      const role = String(req.body?.role || 'member') as TeamRole
      if (!email || !['admin', 'inviter', 'member'].includes(role)) {
        res.status(400).json({ error: 'email and valid role are required' })
        return
      }

      const result = await inviteMember({ ...auth, sessionToken }, email, role)
      if (result.error === 'forbidden') {
        res.status(403).json({ error: 'You are not allowed to invite members' })
        return
      }
      res.status(201).json(result.invited)
    } catch (error) {
      next(error)
    }
  })

  router.delete('/team/members/:userId', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const auth = req.auth!
      const sessionToken = extractAuthToken(req)
      const userId = req.params.userId
      const result = await deleteMember({ ...auth, sessionToken }, userId)
      if (result.error === 'forbidden') {
        res.status(403).json({ error: 'You are not allowed to delete members' })
        return
      }
      if (result.error === 'bad_request') {
        res.status(400).json({ error: 'Cannot delete yourself from this endpoint' })
        return
      }
      if (result.error === 'not_found') {
        res.status(404).json({ error: 'Team member not found' })
        return
      }
      res.status(200).json(result.deleted)
    } catch (error) {
      next(error)
    }
  })

  return router
}
