import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { type UiAuthedRequest, requireAuthForControlUI } from '../../middleware/controlUIAuth.js'
import {
  createControlAdminEmailChangeRequest,
  createControlAdminInvitation,
  deleteControlAdmin,
  findAdminById,
  getPendingControlAdminEmailChangeForAdmin,
  isValidAdminEmail,
  isValidAdminUsername,
  listControlAdmins,
  revokeControlAdminEmailChangeRequest,
  revokeControlAdminInvitation,
  updateAdminPassword,
  updateAdminUsername,
} from '../../services/adminAuthService.js'
import {
  registerAndSendControlAdminEmailConfirmation,
  registerAndSendControlAdminInvitation,
} from '../../services/controlAdminInvitationRegistrationService.js'
import {
  findMemberByEmail,
  provisionMemberFromAdmin,
} from '../../services/directory/adminProvisioning.js'
import {
  createSilentInvitationForTeams,
  revokePendingInvitation,
} from '../../services/directory/index.js'
import { normalizeTeamRoleInput } from '../../services/directory/types.js'
import {
  GfsDesktopOperatorLinkError,
  gfsDesktopOperatorLinkService,
} from '../../services/gfsDesktopOperatorLinkService.js'

function readString(value: unknown): string {
  return String(value || '').trim()
}

const ADMIN_PASSWORD_MIN_LENGTH = 8
const ADMIN_PASSWORD_MAX_LENGTH = 256

export function createAdminControlAdminsRouter(): Router {
  const router = Router()

  router.get('/admin/settings/me', async (req: UiAuthedRequest, res, next) => {
    try {
      const adminId = req.adminAuth?.sub
      const admin = adminId ? await findAdminById(adminId) : null
      if (!admin) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }
      const pendingEmailChange = await getPendingControlAdminEmailChangeForAdmin(admin.id)
      res.status(200).json({
        me: {
          id: admin.id,
          username: admin.username,
          email: admin.email,
          role: admin.role,
          pendingEmailChange: pendingEmailChange
            ? {
                email: pendingEmailChange.email,
                expiresAt: pendingEmailChange.expiresAt.toISOString(),
                createdAt: pendingEmailChange.createdAt.toISOString(),
              }
            : null,
        },
      })
    } catch (error) {
      next(error)
    }
  })

  router.get('/admin/settings/bridge-status', async (req: UiAuthedRequest, res, next) => {
    try {
      const adminId = req.adminAuth?.sub
      const admin = adminId ? await findAdminById(adminId) : null
      if (!admin) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }
      const pendingEmailChange = await getPendingControlAdminEmailChangeForAdmin(admin.id)
      const member = admin.email ? await findMemberByEmail(admin.email) : null
      res.status(200).json({
        admin: {
          id: admin.id,
          username: admin.username,
          email: admin.email,
          emailConfirmed: Boolean(admin.email && !pendingEmailChange),
          pendingEmailChange: pendingEmailChange
            ? {
                email: pendingEmailChange.email,
                expiresAt: pendingEmailChange.expiresAt.toISOString(),
                createdAt: pendingEmailChange.createdAt.toISOString(),
              }
            : null,
        },
        member,
      })
    } catch (error) {
      next(error)
    }
  })

  router.patch('/admin/settings/username', async (req: UiAuthedRequest, res, next) => {
    try {
      const adminId = req.adminAuth?.sub
      if (!adminId) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }

      const username = readString(req.body?.username)
      if (!username) {
        res.status(400).json({ error: 'username is required' })
        return
      }
      if (!isValidAdminUsername(username)) {
        res.status(400).json({
          error:
            'username must be 3-64 characters and use letters, numbers, dots, dashes or underscores',
        })
        return
      }

      const result = await updateAdminUsername(adminId, username)
      if ('error' in result) {
        const status = result.error === 'not_found' ? 404 : 409
        res.status(status).json({ error: result.error })
        return
      }

      res.status(200).json({
        me: {
          id: result.id,
          username: result.username,
          email: result.email,
          role: result.role,
        },
      })
    } catch (error) {
      next(error)
    }
  })

  router.post('/admin/settings/email-change', async (req: UiAuthedRequest, res, next) => {
    try {
      const adminId = req.adminAuth?.sub
      if (!adminId) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }

      const email = readString(req.body?.email).toLowerCase()
      if (!email) {
        res.status(400).json({ error: 'email is required' })
        return
      }
      if (!isValidAdminEmail(email)) {
        res.status(400).json({ error: 'email must be valid' })
        return
      }

      const confirmation = await createControlAdminEmailChangeRequest(adminId, email)
      if ('error' in confirmation) {
        const status = confirmation.error === 'not_found' ? 404 : 409
        res.status(status).json({ error: confirmation.error })
        return
      }

      try {
        await registerAndSendControlAdminEmailConfirmation(
          confirmation.email,
          confirmation.id,
          confirmation.createdAt.toISOString(),
          confirmation.expiresAt.toISOString()
        )
      } catch (sendError) {
        await revokeControlAdminEmailChangeRequest(confirmation.id)
        throw sendError
      }

      res.status(202).json({
        confirmation: {
          id: confirmation.id,
          email: confirmation.email,
          status: confirmation.status,
          expiresAt: confirmation.expiresAt.toISOString(),
          createdAt: confirmation.createdAt.toISOString(),
        },
      })
    } catch (error) {
      next(error)
    }
  })

  router.post('/admin/settings/password', async (req: UiAuthedRequest, res, next) => {
    try {
      const adminId = req.adminAuth?.sub
      const admin = adminId ? await findAdminById(adminId) : null
      if (!admin) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }

      const currentPassword = String(req.body?.currentPassword || '')
      const newPassword = String(req.body?.newPassword || '')
      if (!currentPassword || !newPassword) {
        res.status(400).json({ error: 'currentPassword and newPassword are required' })
        return
      }
      if (
        newPassword.length < ADMIN_PASSWORD_MIN_LENGTH ||
        newPassword.length > ADMIN_PASSWORD_MAX_LENGTH
      ) {
        res.status(400).json({ error: 'newPassword must be between 8 and 256 characters' })
        return
      }

      const currentPasswordOk = await bcrypt.compare(currentPassword, admin.passwordHash)
      if (!currentPasswordOk) {
        res.status(401).json({ error: 'current_password_invalid' })
        return
      }

      await updateAdminPassword(admin.id, await bcrypt.hash(newPassword, 12))
      res.status(200).json({ updated: true })
    } catch (error) {
      next(error)
    }
  })

  router.get('/admin/control-admins', async (req: UiAuthedRequest, res, next) => {
    try {
      if (!req.adminAuth?.sub) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }

      const result = await listControlAdmins()
      res.status(200).json(result)
    } catch (error) {
      next(error)
    }
  })

  router.post('/admin/control-admin-invitations', async (req: UiAuthedRequest, res, next) => {
    try {
      const invitedByAdminId = req.adminAuth?.sub
      if (!invitedByAdminId) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }

      const email = readString(req.body?.email).toLowerCase()
      if (!email) {
        res.status(400).json({ error: 'email is required' })
        return
      }
      if (!isValidAdminEmail(email)) {
        res.status(400).json({ error: 'email must be valid' })
        return
      }

      const invitation = await createControlAdminInvitation(email, invitedByAdminId)
      if ('error' in invitation) {
        res.status(409).json({ error: invitation.error })
        return
      }

      const createDesktopAccess = req.body?.createDesktopAccess === true
      const teamsInput: unknown[] =
        createDesktopAccess && Array.isArray(req.body?.teams) ? req.body.teams : []
      const teamAssignments = teamsInput
        .map(item => {
          const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
          const teamId = readString(row.teamId || row.id)
          const role = normalizeTeamRoleInput(row.role) || 'member'
          return teamId ? { teamId, role } : null
        })
        .filter((item): item is { teamId: string; role: 'admin' | 'inviter' | 'member' } =>
          Boolean(item)
        )
      let desktopInvitation: Awaited<ReturnType<typeof createSilentInvitationForTeams>> | null =
        null

      try {
        if (createDesktopAccess) {
          desktopInvitation = await createSilentInvitationForTeams({
            inviteeName: email,
            email,
            teamAssignments,
            fallbackRole: 'member',
            purpose: 'admin_desktop_access',
          })
        }
        await registerAndSendControlAdminInvitation(
          invitation.email,
          invitation.id,
          invitation.createdAt.toISOString(),
          invitation.expiresAt.toISOString(),
          {
            desktopTeamNames: desktopInvitation?.teams.map(team => team.name) || [],
          }
        )
      } catch (sendError) {
        await revokeControlAdminInvitation(invitation.id)
        if (desktopInvitation) {
          await revokePendingInvitation(desktopInvitation.team_id, desktopInvitation.id)
        }
        throw sendError
      }

      res.status(201).json({
        invitation: {
          id: invitation.id,
          email: invitation.email,
          status: invitation.status,
          expiresAt: invitation.expiresAt.toISOString(),
          createdAt: invitation.createdAt.toISOString(),
        },
      })
    } catch (error) {
      next(error)
    }
  })

  router.get(
    '/admin/control-admins/:adminId/gfs-operator-link',
    async (req: UiAuthedRequest, res, next) => {
      try {
        const adminId = readString(req.params.adminId)
        if (!adminId) return void res.status(400).json({ error: 'adminId is required' })
        const link = await gfsDesktopOperatorLinkService.getLinkForControlAdmin(adminId)
        res.status(200).json({
          gfsOperatorLinkStatus: link?.state === 'active' ? 'active' : 'revoked',
          controlAdminId: adminId,
          desktopUserId: link?.desktopUserId ?? null,
          generation: link?.generation ?? null,
          rowVersion: link?.rowVersion ?? null,
          revocationReason: link?.revocationReason ?? null,
        })
      } catch (error) {
        next(error)
      }
    }
  )

  router.delete(
    '/admin/control-admin-invitations/:invitationId',
    requireAuthForControlUI,
    async (req: UiAuthedRequest, res, next) => {
      try {
        const adminId = req.adminAuth?.sub
        if (!adminId) {
          res.status(401).json({ error: 'Unauthorized' })
          return
        }

        const invitationId = readString(req.params.invitationId)
        if (!invitationId) {
          res.status(400).json({ error: 'invitationId is required' })
          return
        }

        await revokeControlAdminInvitation(invitationId)
        res.status(200).json({ revoked: true })
      } catch (error) {
        next(error)
      }
    }
  )

  router.delete('/admin/control-admins/:adminId', async (req: UiAuthedRequest, res, next) => {
    try {
      const currentAdminId = req.adminAuth?.sub
      if (!currentAdminId) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }

      const adminId = readString(req.params.adminId)
      if (!adminId) {
        res.status(400).json({ error: 'adminId is required' })
        return
      }
      if (adminId === currentAdminId) {
        res.status(400).json({ error: 'cannot_delete_current_admin' })
        return
      }

      const result = await deleteControlAdmin(currentAdminId, adminId)
      if ('error' in result) {
        res.status(404).json({ error: result.error })
        return
      }

      res.status(200).json(result)
    } catch (error) {
      next(error)
    }
  })

  router.delete(
    '/admin/control-admins/:adminId/gfs-operator-link',
    async (req: UiAuthedRequest, res, next) => {
      try {
        const operatorSub = req.adminAuth?.sub
        if (!operatorSub) {
          res.status(401).json({ error: 'Unauthorized' })
          return
        }

        const adminId = readString(req.params.adminId)
        if (!adminId) {
          res.status(400).json({ error: 'adminId is required' })
          return
        }

        const targetAdmin = await findAdminById(adminId)
        if (!targetAdmin) {
          res.status(404).json({ error: 'not_found' })
          return
        }

        // Resolve the exact persisted pair server-side. The caller cannot
        // choose a Desktop user or ask the endpoint to create/reassign one.
        const link = await gfsDesktopOperatorLinkService.getLinkForControlAdmin(adminId)
        if (!link || link.state === 'revoked') {
          res.status(200).json({
            revoked: false,
            gfsOperatorLinkStatus: 'revoked',
            controlAdminId: adminId,
            desktopUserId: link?.desktopUserId ?? null,
            generation: link?.generation ?? null,
            rowVersion: link?.rowVersion ?? null,
          })
          return
        }

        const requestedRowVersion =
          req.body?.rowVersion === undefined ? link.rowVersion : Number(req.body.rowVersion)
        const result = await gfsDesktopOperatorLinkService.unlink({
          desktopUserId: link.desktopUserId,
          controlAdminId: link.controlAdminId,
          operatorSub,
          rowVersion: requestedRowVersion,
          reason: readString(req.body?.reason),
        })
        res.status(200).json({
          revoked: result.unlinked,
          gfsOperatorLinkStatus: 'revoked',
          controlAdminId: adminId,
          desktopUserId: link.desktopUserId,
          generation: result.link?.generation ?? link.generation ?? null,
          rowVersion: result.link?.rowVersion ?? null,
        })
      } catch (error) {
        if (error instanceof GfsDesktopOperatorLinkError) {
          if (error.code === 'invalid_input') {
            res.status(400).json({ error: error.code })
            return
          }
          if (error.code === 'control_admin_not_found') {
            res.status(404).json({ error: error.code })
            return
          }
          if (error.code === 'link_conflict' || error.code === 'malformed_link') {
            res.status(409).json({ error: error.code })
            return
          }
        }
        next(error)
      }
    }
  )

  router.post(
    '/admin/control-admins/:adminId/gfs-operator-link/reactivate',
    async (req: UiAuthedRequest, res, next) => {
      try {
        const operatorSub = req.adminAuth?.sub
        const adminId = readString(req.params.adminId)
        if (!operatorSub) return void res.status(401).json({ error: 'Unauthorized' })
        if (!adminId) return void res.status(400).json({ error: 'adminId is required' })
        const result = await gfsDesktopOperatorLinkService.reactivate({
          controlAdminId: adminId,
          operatorSub,
          rowVersion: Number(req.body?.rowVersion),
          reason: readString(req.body?.reason),
        })
        res.status(200).json({
          reactivated: result.reactivated,
          gfsOperatorLinkStatus: result.reactivated ? 'active' : 'revoked',
          controlAdminId: adminId,
          desktopUserId: result.link?.desktopUserId ?? null,
          generation: result.link?.generation ?? null,
          rowVersion: result.link?.rowVersion ?? null,
        })
      } catch (error) {
        if (error instanceof GfsDesktopOperatorLinkError && error.code === 'invalid_input') {
          res.status(400).json({ error: error.code })
          return
        }
        if (error instanceof GfsDesktopOperatorLinkError && error.code === 'link_conflict') {
          res.status(409).json({ error: error.code })
          return
        }
        if (
          error instanceof GfsDesktopOperatorLinkError &&
          (error.code === 'control_admin_inactive' ||
            error.code === 'desktop_user_retired' ||
            error.code === 'malformed_link')
        ) {
          res.status(409).json({ error: error.code })
          return
        }
        if (
          error instanceof GfsDesktopOperatorLinkError &&
          error.code === 'desktop_user_not_found'
        ) {
          res.status(404).json({ error: error.code })
          return
        }
        next(error)
      }
    }
  )

  router.post('/admin/control-admins/:adminId/member', async (req: UiAuthedRequest, res, next) => {
    try {
      const currentAdminId = req.adminAuth?.sub
      if (!currentAdminId) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }

      const adminId = readString(req.params.adminId)
      if (!adminId) {
        res.status(400).json({ error: 'adminId is required' })
        return
      }

      const teamsInput: unknown[] = Array.isArray(req.body?.teams) ? req.body.teams : []
      const teamAssignments = teamsInput
        .map(item => {
          const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
          const teamId = readString(row.teamId || row.id)
          const role = normalizeTeamRoleInput(row.role) || 'member'
          return teamId ? { teamId, role } : null
        })
        .filter((item): item is { teamId: string; role: 'admin' | 'inviter' | 'member' } =>
          Boolean(item)
        )

      const result = await provisionMemberFromAdmin({
        adminId,
        operatorSub: currentAdminId,
        teamAssignments,
        seedPassword: req.body?.reusePassword === true,
      })
      if ('error' in result) {
        const status = result.error === 'admin_not_found' ? 404 : 409
        res.status(status).json({ error: result.error })
        return
      }

      res.status(result.created ? 201 : 200).json(result)
    } catch (error) {
      next(error)
    }
  })

  return router
}
