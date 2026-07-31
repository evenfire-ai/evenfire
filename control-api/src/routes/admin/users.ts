import { Router } from 'express'
import type { K8sGateway } from '../../k8s.js'
import {
  adminDeleteUser,
  createAdminUser,
  createPasswordSetupInvitationForUser,
  findMembership,
  getAdminUserContext,
  listTeams,
  listUsers,
  updateAdminUserContext,
} from '../../services/directory/index.js'
import { disableVerifiedMediumAccount } from '../../services/workflowApprovalMediumIdentityService.js'
import { createMediumLinkSession } from '../../services/workflowApprovalMediumLinkSessionService.js'
import {
  listVerifiedMediumAccountsWithPreference,
  preferVerifiedMediumAccount,
} from '../../services/workflowApprovalMediumPreferenceService.js'
import { registerAdminUserAccessRoutes } from './userAccess.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function userExists(userId: string): Promise<boolean> {
  return Boolean(await getAdminUserContext(userId))
}

function mediumLifecycleStatus(error: string): number {
  if (error === 'unsupported_medium') return 400
  if (error === 'telegram_target_required') return 400
  if (error === 'slack_workspace_id_required') return 400
  if (error === 'invalid_provider_workspace_id') return 400
  return 500
}

export function createAdminUsersRouter(gateway: K8sGateway): Router {
  const router = Router()

  router.get('/admin/users', async (req, res, next) => {
    try {
      const q = String(req.query.q || '')
      res.status(200).json({ items: await listUsers(q) })
    } catch (error) {
      next(error)
    }
  })

  router.post('/admin/users', async (req, res, next) => {
    try {
      const email = String(req.body?.email || '')
        .trim()
        .toLowerCase()
      const name = String(req.body?.name || '').trim()
      if (!email) {
        res.status(400).json({ error: 'email is required' })
        return
      }
      const user = await createAdminUser(email, name)
      res.status(201).json(user)
    } catch (error) {
      const code = (error as { code?: string } | null)?.code
      if (code === '23505') {
        res
          .status(409)
          .json({ error: 'email_already_exists', message: 'A user with this email already exists' })
        return
      }
      next(error)
    }
  })

  router.get('/admin/users/:userId/teams', async (req, res, next) => {
    try {
      res
        .status(200)
        .json(await listTeams(req.params.userId, String(req.query.currentTeamId || '')))
    } catch (error) {
      next(error)
    }
  })

  router.get('/admin/users/:userId/workflow-approval-mediums', async (req, res, next) => {
    try {
      if (!(await userExists(req.params.userId))) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      res
        .status(200)
        .json({ items: await listVerifiedMediumAccountsWithPreference(req.params.userId) })
    } catch (error) {
      next(error)
    }
  })

  router.post(
    '/admin/users/:userId/workflow-approval-mediums/link-sessions',
    async (req, res, next) => {
      try {
        if (!(await userExists(req.params.userId))) {
          res.status(404).json({ error: 'not_found' })
          return
        }
        const result = await createMediumLinkSession({
          userId: req.params.userId,
          medium: String(req.body?.medium || '').trim(),
          providerWorkspaceId: req.body?.providerWorkspaceId,
        })
        res.status(202).json({
          linkSessionId: result.id,
          nonce: result.nonce,
          expiresAt: result.expiresAt,
          deepLinkUrl: result.deepLinkUrl,
        })
      } catch (error) {
        if (error instanceof Error) {
          const status = mediumLifecycleStatus(error.message)
          if (status !== 500) {
            res.status(status).json({ error: error.message })
            return
          }
        }
        next(error)
      }
    }
  )

  router.put(
    '/admin/users/:userId/workflow-approval-mediums/:accountId/preference',
    async (req, res, next) => {
      try {
        const accountId = String(req.params.accountId || '').trim()
        if (!UUID_RE.test(accountId)) {
          res.status(400).json({ error: 'Invalid account id format' })
          return
        }
        const account = await preferVerifiedMediumAccount({ userId: req.params.userId, accountId })
        if (!account) {
          res.status(404).json({ error: 'medium_account_not_found' })
          return
        }
        res.status(200).json({ ok: true, account })
      } catch (error) {
        next(error)
      }
    }
  )

  router.delete(
    '/admin/users/:userId/workflow-approval-mediums/:accountId',
    async (req, res, next) => {
      try {
        const accountId = String(req.params.accountId || '').trim()
        if (!UUID_RE.test(accountId)) {
          res.status(400).json({ error: 'Invalid account id format' })
          return
        }
        const disabled = await disableVerifiedMediumAccount({
          userId: req.params.userId,
          accountId,
        })
        res.status(disabled ? 204 : 404).send()
      } catch (error) {
        next(error)
      }
    }
  )

  router.post('/admin/users/:userId/invitations/password-setup/resend', async (req, res, next) => {
    try {
      const result = await createPasswordSetupInvitationForUser(req.params.userId)
      if ('error' in result) {
        if (result.error === 'not_found') {
          res.status(404).json({ error: 'not_found' })
          return
        }
        if (result.error === 'password_already_set') {
          res.status(409).json({ error: 'password_already_set' })
          return
        }
        if (result.error === 'no_accepted_invitation') {
          res.status(409).json({ error: 'no_accepted_invitation' })
          return
        }
      }
      res.status(200).json(result)
    } catch (error) {
      next(error)
    }
  })

  router.get('/admin/users/:userId/context', async (req, res, next) => {
    try {
      const context = await getAdminUserContext(req.params.userId)
      if (!context) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      res.status(200).json(context)
    } catch (error) {
      next(error)
    }
  })

  router.put('/admin/users/:userId/context', async (req, res, next) => {
    try {
      const email = String(req.body?.email || '')
        .trim()
        .toLowerCase()
      const hasName = Object.prototype.hasOwnProperty.call(req.body || {}, 'name')
      const name = hasName ? String(req.body?.name || '').trim() : undefined
      const updated = await updateAdminUserContext(
        req.params.userId,
        email,
        name,
        req.body?.channels
      )
      if (!updated) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      res.status(200).json(updated)
    } catch (error) {
      const code = (error as { code?: string } | null)?.code
      if (code === '23505') {
        res.status(409).json({ error: 'email_already_exists' })
        return
      }
      next(error)
    }
  })

  router.get('/admin/users/:userId/memberships/:teamId', async (req, res, next) => {
    try {
      const membership = await findMembership(req.params.userId, req.params.teamId)
      if (!membership) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      res.status(200).json(membership)
    } catch (error) {
      next(error)
    }
  })

  registerAdminUserAccessRoutes(router, gateway)

  /**
   * Hard-delete user profile, memberships, and personal context/agent links (DB CASCADE).
   * Teams are retained even when this leaves them with no members.
   */
  router.delete('/admin/users/:userId', async (req, res, next) => {
    try {
      const result = await adminDeleteUser(req.params.userId)
      if ('error' in result) {
        if (result.error === 'not_found') {
          res.status(404).json({ error: 'not_found' })
          return
        }
        const exhaustive: never = result.error
        throw new Error(`Unhandled adminDeleteUser result: ${exhaustive}`)
      }
      res.status(200).json({ deleted: true, id: result.id })
    } catch (error) {
      next(error)
    }
  })

  return router
}
