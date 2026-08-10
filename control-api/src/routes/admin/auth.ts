import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { config } from '../../config.js'
import { pool } from '../../db.js'
import { type UiAuthedRequest, requireAuthForControlUI } from '../../middleware/controlUIAuth.js'
import { rateLimitMiddleware } from '../../middleware/rateLimitMiddleware.js'
import { rootLogger } from '../../observability/logger.js'
import {
  completeControlAdminEmailChangeRequest,
  completeControlAdminInvitation,
  completeControlAdminPasswordResetRequest,
  createControlAdminPasswordResetRequest,
  findAdminById,
  findAdminByLogin,
  getPendingControlAdminEmailChangeRequest,
  getPendingControlAdminInvitation,
  getPendingControlAdminPasswordResetRequest,
  isValidAdminEmail,
  isValidAdminUsername,
  markControlAdminInvitationOpened,
  registerAdminFailedLogin,
  registerAdminSuccessfulLogin,
  revokeAdminTokenJti,
  revokeControlAdminPasswordResetRequest,
  setupInitialAdminCredentials,
} from '../../services/adminAuthService.js'
import {
  registerAndSendControlAdminPasswordReset,
  validateControlAdminEmailConfirmationToken,
  validateControlAdminInvitationToken,
  validateControlAdminPasswordResetToken,
} from '../../services/controlAdminInvitationRegistrationService.js'
import {
  acceptInvitationById,
  getPendingMemberInvitationForEmail,
  provisionAdminDesktopWorkspace,
  setInvitationPasswordForUser,
} from '../../services/directory/index.js'
import { memberRegistrationErrorResponse } from '../../services/memberRegistrationErrors.js'
import { signAdminToken } from '../../utils/auth/adminAuthToken.js'
import {
  CONTROL_UI_ADMIN_SESSION_COOKIE,
  clearHttpOnlySessionCookie,
  setHttpOnlySessionCookie,
} from '../../utils/auth/sessionCookies.js'

const ADMIN_PASSWORD_MIN_LENGTH = 8
const ADMIN_PASSWORD_MAX_LENGTH = 256

const logger = rootLogger.child({ module: 'admin-auth' })

function publicAdminTokenRateLimit(routeName: string) {
  return rateLimitMiddleware({
    bucketType: `control_admin_public_${routeName}`,
    maxPerMinute: config.adminPublicTokenRlPerMin,
    getBucketKey: req => {
      const token = String(req.body?.token || '').trim()
      const email = String(req.body?.email || '')
        .trim()
        .toLowerCase()
      const login = String(req.body?.username || req.body?.login || '').trim()
      const remote = req.ip || req.socket.remoteAddress || 'unknown'
      return `control-admin-public:${routeName}:${remote}:${email || login || token.slice(0, 48) || 'missing'}`
    },
  })
}

export function createAdminAuthRouter(): Router {
  const router = Router()

  router.post('/admin/auth/login', async (req, res, next) => {
    try {
      const username = String(req.body?.username || '').trim()
      const password = String(req.body?.password || '')
      if (!username || !password) {
        res.status(400).json({ error: 'username and password are required' })
        return
      }

      const user = await findAdminByLogin(username)
      if (!user || user.status !== 'active') {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }
      if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
        res.status(423).json({ error: 'Account is temporarily locked' })
        return
      }

      const ok = await bcrypt.compare(password, user.passwordHash)
      if (!ok) {
        await registerAdminFailedLogin(
          user.id,
          config.adminAuthLockMinutes,
          config.adminAuthMaxFailures
        )
        res.status(401).json({ error: 'Unauthorized' })
        return
      }

      await registerAdminSuccessfulLogin(user.id)
      const token = signAdminToken(user.id, 'admin', user.sessionVersion)
      setHttpOnlySessionCookie(
        req,
        res,
        CONTROL_UI_ADMIN_SESSION_COOKIE,
        token,
        config.adminJwtTtlSeconds
      )
      res.status(200).json({
        me: {
          id: user.id,
          username: user.username,
          email: user.email,
          role: 'admin',
        },
      })
    } catch (error) {
      next(error)
    }
  })

  router.post('/admin/auth/setup', async (req, res, next) => {
    try {
      const username = String(req.body?.username || '').trim()
      const email = String(req.body?.email || '')
        .trim()
        .toLowerCase()
      const password = String(req.body?.password || '')
      if (!email || !username || !password) {
        res.status(400).json({ error: 'email, username and password are required' })
        return
      }
      if (!isValidAdminEmail(email)) {
        res.status(400).json({ error: 'email must be valid' })
        return
      }
      if (!isValidAdminUsername(username)) {
        res.status(400).json({
          error:
            'username must be 3-64 characters and use letters, numbers, dots, dashes or underscores',
        })
        return
      }
      if (
        password.length < ADMIN_PASSWORD_MIN_LENGTH ||
        password.length > ADMIN_PASSWORD_MAX_LENGTH
      ) {
        res.status(400).json({ error: 'password must be between 8 and 256 characters' })
        return
      }

      const passwordHash = await bcrypt.hash(password, 12)
      // Only a literal false opts out (fail-safe toward the human first-run
      // flow, where one credential for Control UI + desktop is the feature).
      // Managed installs send false: the desktop password then comes only
      // from the directory invitation email.
      const seedDesktopPassword = req.body?.seedDesktopPassword !== false
      const created = await setupInitialAdminCredentials(
        config.adminBootstrapUsername,
        email,
        username,
        passwordHash
      )
      if (!created) {
        res.status(409).json({ error: 'Initial admin setup is no longer available' })
        return
      }

      // Best-effort: provision a matching desktop identity (users row + owner
      // team + default grants; password only when seedDesktopPassword). A
      // failure here must not block onboarding — the Control UI admin is
      // already created.
      try {
        await provisionAdminDesktopWorkspace({
          controlAdminId: created.id,
          email,
          displayName: username,
          passwordHash,
          agentNames: config.adminDefaultAgentNames,
          contextIds: config.adminDefaultContextIds,
          seedPassword: seedDesktopPassword,
          linkDesktopOperator: config.desktopGfsOperatorLinkingEnabled,
        })
      } catch (err) {
        // Intentionally logs only err + email — never passwordHash.
        logger.error(
          { err, email },
          'admin desktop workspace provisioning failed; control admin still created'
        )
      }

      const token = signAdminToken(created.id, 'admin', created.sessionVersion)
      setHttpOnlySessionCookie(
        req,
        res,
        CONTROL_UI_ADMIN_SESSION_COOKIE,
        token,
        config.adminJwtTtlSeconds
      )
      res.status(200).json({
        me: {
          id: created.id,
          username: created.username,
          email: created.email,
          role: 'admin',
        },
      })
    } catch (error) {
      next(error)
    }
  })

  router.post(
    '/admin/auth/password-reset/request',
    publicAdminTokenRateLimit('password_reset_request'),
    async (req, res, next) => {
      try {
        const username = String(req.body?.username || '').trim()
        if (!username) {
          res.status(202).json({ requested: true })
          return
        }

        const reset = await createControlAdminPasswordResetRequest(username)
        if ('skipped' in reset) {
          res.status(202).json({ requested: true })
          return
        }

        try {
          await registerAndSendControlAdminPasswordReset(
            reset.email,
            reset.id,
            reset.createdAt.toISOString(),
            reset.expiresAt.toISOString()
          )
        } catch (sendError) {
          await revokeControlAdminPasswordResetRequest(reset.id)
          throw sendError
        }

        res.status(202).json({ requested: true })
      } catch (error) {
        next(error)
      }
    }
  )

  router.post(
    '/admin/auth/password-reset/validate',
    publicAdminTokenRateLimit('password_reset_validate'),
    async (req, res, next) => {
      try {
        const token = String(req.body?.token || '').trim()
        const email = String(req.body?.email || '')
          .trim()
          .toLowerCase()
        if (!token) {
          res.status(400).json({ error: 'token is required' })
          return
        }

        const validation = await validateControlAdminPasswordResetToken(token, email || undefined)
        const reset = await getPendingControlAdminPasswordResetRequest(
          pool,
          validation.resetUuid,
          validation.email
        )
        if (!reset) {
          res.status(404).json({ error: 'invalid_password_reset' })
          return
        }

        res.status(200).json({
          valid: true,
          email: validation.email,
          resetUuid: validation.resetUuid,
        })
      } catch (error) {
        if (memberRegistrationErrorResponse(error)) return next(error)
        res.status(400).json({ error: 'invalid_password_reset' })
      }
    }
  )

  router.post(
    '/admin/auth/password-reset/complete',
    publicAdminTokenRateLimit('password_reset_complete'),
    async (req, res, next) => {
      try {
        const token = String(req.body?.token || '').trim()
        const email = String(req.body?.email || '')
          .trim()
          .toLowerCase()
        const password = String(req.body?.password || '')
        if (!token || !email || !password) {
          res.status(400).json({ error: 'token, email and password are required' })
          return
        }
        if (!isValidAdminEmail(email)) {
          res.status(400).json({ error: 'email must be valid' })
          return
        }
        if (
          password.length < ADMIN_PASSWORD_MIN_LENGTH ||
          password.length > ADMIN_PASSWORD_MAX_LENGTH
        ) {
          res.status(400).json({ error: 'password must be between 8 and 256 characters' })
          return
        }

        let validation: { email: string; resetUuid: string }
        try {
          validation = await validateControlAdminPasswordResetToken(token, email)
        } catch (error) {
          if (memberRegistrationErrorResponse(error)) throw error
          res.status(400).json({ error: 'invalid_password_reset' })
          return
        }
        const passwordHash = await bcrypt.hash(password, 12)
        const result = await completeControlAdminPasswordResetRequest({
          requestId: validation.resetUuid,
          email: validation.email,
          passwordHash,
        })
        if ('error' in result) {
          res.status(404).json({ error: 'invalid_password_reset' })
          return
        }

        res.status(200).json({
          completed: true,
          login: {
            username: result.email || result.username,
          },
        })
      } catch (error) {
        next(error)
      }
    }
  )

  router.post(
    '/admin/auth/control-admin-invitations/validate',
    publicAdminTokenRateLimit('invitation_validate'),
    async (req, res, next) => {
      try {
        const token = String(req.body?.token || '').trim()
        const email = String(req.body?.email || '')
          .trim()
          .toLowerCase()
        if (!token) {
          res.status(400).json({ error: 'token is required' })
          return
        }

        const validation = await validateControlAdminInvitationToken(token, email || undefined)
        const invitation = await getPendingControlAdminInvitation(
          pool,
          validation.invitationUuid,
          validation.email
        )
        if (!invitation) {
          res.status(404).json({ error: 'invalid_invitation' })
          return
        }
        await markControlAdminInvitationOpened(invitation.id)
        const desktopAccess = await getPendingMemberInvitationForEmail(validation.email)
        res.status(200).json({
          valid: true,
          email: validation.email,
          invitationUuid: validation.invitationUuid,
          desktopAccess,
        })
      } catch (error) {
        if (memberRegistrationErrorResponse(error)) return next(error)
        res.status(400).json({ error: 'invalid_invitation' })
      }
    }
  )

  router.post(
    '/admin/auth/control-admin-invitations/complete',
    publicAdminTokenRateLimit('invitation_complete'),
    async (req, res, next) => {
      try {
        const token = String(req.body?.token || '').trim()
        const email = String(req.body?.email || '')
          .trim()
          .toLowerCase()
        const username = String(req.body?.username || '').trim()
        const password = String(req.body?.password || '')
        const useSameMemberPassword = req.body?.useSameMemberPassword !== false
        const memberPassword = useSameMemberPassword
          ? password
          : String(req.body?.memberPassword || '')
        if (!token || !email || !username || !password) {
          res.status(400).json({ error: 'token, email, username and password are required' })
          return
        }
        if (!isValidAdminEmail(email)) {
          res.status(400).json({ error: 'email must be valid' })
          return
        }
        if (!isValidAdminUsername(username)) {
          res.status(400).json({
            error:
              'username must be 3-64 characters and use letters, numbers, dots, dashes or underscores',
          })
          return
        }
        if (
          password.length < ADMIN_PASSWORD_MIN_LENGTH ||
          password.length > ADMIN_PASSWORD_MAX_LENGTH
        ) {
          res.status(400).json({ error: 'password must be between 8 and 256 characters' })
          return
        }
        const desktopAccess = await getPendingMemberInvitationForEmail(email)
        if (desktopAccess && (memberPassword.length < 8 || memberPassword.length > 256)) {
          res.status(400).json({ error: 'member password must be between 8 and 256 characters' })
          return
        }

        const validation = await validateControlAdminInvitationToken(token, email)
        const passwordHash = await bcrypt.hash(password, 12)
        const result = await completeControlAdminInvitation({
          email: validation.email,
          invitationId: validation.invitationUuid,
          username,
          passwordHash,
        })
        if ('error' in result) {
          const status = result.error === 'not_found' ? 404 : 409
          res.status(status).json({ error: result.error })
          return
        }

        const acceptedDesktopAccess = desktopAccess
          ? await acceptInvitationById(validation.email, desktopAccess.id)
          : null
        if (acceptedDesktopAccess && 'error' in acceptedDesktopAccess) {
          res.status(409).json({ error: acceptedDesktopAccess.error })
          return
        }
        if (acceptedDesktopAccess?.data?.userId && desktopAccess) {
          const passwordResult = await setInvitationPasswordForUser(
            acceptedDesktopAccess.data.userId,
            validation.email,
            desktopAccess.id,
            memberPassword
          )
          if ('error' in passwordResult) {
            res.status(409).json({ error: passwordResult.error })
            return
          }
        }

        res.status(200).json({
          completed: true,
          desktopAccessCompleted: Boolean(
            acceptedDesktopAccess && !('error' in acceptedDesktopAccess)
          ),
          login: {
            username: result.email || result.username,
          },
        })
      } catch (error) {
        next(error)
      }
    }
  )

  router.post(
    '/admin/auth/control-admin-email-confirmations/validate',
    publicAdminTokenRateLimit('email_confirmation_validate'),
    async (req, res, next) => {
      try {
        const token = String(req.body?.token || '').trim()
        const email = String(req.body?.email || '')
          .trim()
          .toLowerCase()
        if (!token) {
          res.status(400).json({ error: 'token is required' })
          return
        }

        const validation = await validateControlAdminEmailConfirmationToken(
          token,
          email || undefined
        )
        const confirmation = await getPendingControlAdminEmailChangeRequest(
          pool,
          validation.confirmationUuid,
          validation.email
        )
        if (!confirmation) {
          res.status(404).json({ error: 'invalid_confirmation' })
          return
        }

        res.status(200).json({
          valid: true,
          email: validation.email,
          confirmationUuid: validation.confirmationUuid,
        })
      } catch (error) {
        if (memberRegistrationErrorResponse(error)) return next(error)
        res.status(400).json({ error: 'invalid_confirmation' })
      }
    }
  )

  router.post(
    '/admin/auth/control-admin-email-confirmations/complete',
    publicAdminTokenRateLimit('email_confirmation_complete'),
    async (req, res, next) => {
      try {
        const token = String(req.body?.token || '').trim()
        const email = String(req.body?.email || '')
          .trim()
          .toLowerCase()
        if (!token) {
          res.status(400).json({ error: 'token is required' })
          return
        }
        if (email && !isValidAdminEmail(email)) {
          res.status(400).json({ error: 'email must be valid' })
          return
        }

        let validation: { email: string; confirmationUuid: string }
        try {
          validation = await validateControlAdminEmailConfirmationToken(token, email || undefined)
        } catch (error) {
          if (memberRegistrationErrorResponse(error)) throw error
          res.status(400).json({ error: 'invalid_confirmation' })
          return
        }
        const result = await completeControlAdminEmailChangeRequest({
          requestId: validation.confirmationUuid,
          email: validation.email,
        })
        if ('alreadyConfirmed' in result) {
          res.status(200).json({
            completed: true,
            alreadyConfirmed: true,
            login: {
              username: result.admin.email || result.admin.username,
            },
          })
          return
        }
        if ('error' in result) {
          const status = result.error === 'not_found' ? 404 : 409
          res.status(status).json({ error: result.error })
          return
        }

        res.status(200).json({
          completed: true,
          alreadyConfirmed: false,
          login: {
            username: result.email || result.username,
          },
        })
      } catch (error) {
        next(error)
      }
    }
  )

  router.get('/admin/auth/me', requireAuthForControlUI, async (req: UiAuthedRequest, res, next) => {
    try {
      const adminId = req.adminAuth?.sub
      const admin = adminId ? await findAdminById(adminId) : null
      if (!admin) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }

      res.status(200).json({
        me: {
          id: admin.id,
          username: admin.username,
          email: admin.email,
          role: admin.role,
        },
        // The recipe-secret namespaces this control-api enforces (see
        // WORKFLOW_RECIPE_SECRET_NAMESPACES in the recipes route). In a managed
        // per-tenant deployment these are suffixed (sandbox-recipes-<slug> /
        // mcp-server-<slug>); control-ui needs them to write recipe-secret VALUES
        // to the correct namespace at CREATE time (the recipe namespace does not
        // exist yet). Same source of truth as the POST /admin/recipes/secrets
        // validator, so the UI and validator can never disagree.
        namespaces: {
          sandbox: config.sandboxNamespace,
          mcpServer: config.mcpServersNamespace,
        },
      })
    } catch (error) {
      next(error)
    }
  })

  router.post(
    '/admin/auth/logout',
    requireAuthForControlUI,
    async (req: UiAuthedRequest, res, next) => {
      try {
        const claims = req.adminAuth!
        await revokeAdminTokenJti(claims.jti, claims.exp)
        clearHttpOnlySessionCookie(req, res, CONTROL_UI_ADMIN_SESSION_COOKIE)
        res.status(200).json({ ok: true })
      } catch (error) {
        next(error)
      }
    }
  )

  return router
}
