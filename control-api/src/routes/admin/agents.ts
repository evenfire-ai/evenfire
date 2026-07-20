import { Router } from 'express'
import type { UiAuthedRequest } from '../../middleware/controlUIAuth.js'
import {
  listTeamsByAgent,
  listUsersByAgent,
  setAgentTeams,
  setAgentUsers,
} from '../../services/directory/index.js'

export function createAdminAgentsRouter(): Router {
  const router = Router()

  router.get('/admin/agents/:agentName/users', async (req, res, next) => {
    try {
      res.status(200).json({ items: await listUsersByAgent(req.params.agentName) })
    } catch (error) {
      next(error)
    }
  })

  router.get('/admin/agents/:agentName/teams', async (req, res, next) => {
    try {
      res.status(200).json({ items: await listTeamsByAgent(req.params.agentName) })
    } catch (error) {
      next(error)
    }
  })

  /**
   * Replace the full set of users authorized for this agent.
   * Body: { userIds: string[] }
   * Semantics: destructive (matches PUT /admin/users/:userId/agents).
   * Called by Control UI when creating or editing a Host.
   */
  router.put('/admin/agents/:agentName/users', async (req, res, next) => {
    try {
      const userIds = Array.isArray(req.body?.userIds) ? req.body.userIds.map(String) : []
      res
        .status(200)
        .json(
          await setAgentUsers(
            req.params.agentName,
            userIds,
            (req as UiAuthedRequest).adminAuth!.sub
          )
        )
    } catch (error) {
      next(error)
    }
  })

  /**
   * Replace the full set of teams authorized for this agent.
   * Body: { teamIds: string[] }
   * Semantics: destructive (matches PUT /admin/teams/:teamId/agents).
   */
  router.put('/admin/agents/:agentName/teams', async (req, res, next) => {
    try {
      const teamIds = Array.isArray(req.body?.teamIds) ? req.body.teamIds.map(String) : []
      res
        .status(200)
        .json(
          await setAgentTeams(
            req.params.agentName,
            teamIds,
            (req as UiAuthedRequest).adminAuth!.sub
          )
        )
    } catch (error) {
      next(error)
    }
  })

  return router
}
