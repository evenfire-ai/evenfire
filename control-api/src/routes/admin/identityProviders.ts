import { Router } from 'express'
import { config } from '../../config.js'
import type { K8sGateway } from '../../k8s.js'
import type { UiAuthedRequest } from '../../middleware/controlUIAuth.js'
import {
  listAllTeams,
  listTeamAgentsByTeam,
  listTeamContextsByTeam,
} from '../../services/directory/index.js'
import { identityProviderError } from '../../services/identityProviders/errors.js'
import { executeMicrosoftImport } from '../../services/identityProviders/importExecution.js'
import {
  createPendingMicrosoftConnection,
  defaultMicrosoftCallbackUrl,
  disconnectIdentityProviderConnection,
  getIdentityProviderConnection,
  listIdentityProviderConnections,
  loadMicrosoftDirectory,
  startMicrosoftOAuth,
  updateMicrosoftIdentityProviderConnection,
} from '../../services/identityProviders/service.js'
import {
  attachConnectionToIdentityProviderSetup,
  createIdentityProviderSetup,
  getActiveIdentityProviderSetup,
  getIdentityProviderSetupById,
  loadIdentityProviderSetupSecret,
  saveIdentityProviderSetupSecret,
  updateIdentityProviderSetup,
} from '../../services/identityProviders/setup.js'
import { validateIdentityProviderReturnUrl } from '../../services/identityProviders/validation.js'
import {
  loadAdminActiveAgentNames,
  loadAdminActiveContextIds,
} from './accessReconciliationResponse.js'

function validatedAdminReturnUrl(req: UiAuthedRequest): string {
  return validateIdentityProviderReturnUrl('admin_connect', String(req.body?.returnUrl || ''))
}

function requireAdminSubject(req: UiAuthedRequest): string {
  const subject = String(req.adminAuth?.sub || '').trim()
  if (!subject) throw identityProviderError(401, 'Unauthorized')
  return subject
}

export function createAdminIdentityProvidersRouter(gateway: K8sGateway): Router {
  const router = Router()

  router.get('/admin/identity-provider-connections', async (req, res, next) => {
    try {
      const fallbackOrigin = `${req.protocol}://${req.get('host') || 'localhost'}`
      res.status(200).json({
        ...(await listIdentityProviderConnections(fallbackOrigin)),
        appName: config.controlUiAppName,
      })
    } catch (error) {
      next(error)
    }
  })

  router.get('/admin/identity-provider-setups/microsoft/active', async (req, res, next) => {
    try {
      const fallbackOrigin = `${req.protocol}://${req.get('host') || 'localhost'}`
      res.status(200).json({
        setup: await getActiveIdentityProviderSetup('microsoft'),
        callbackUrl: defaultMicrosoftCallbackUrl(fallbackOrigin),
        appName: config.controlUiAppName,
      })
    } catch (error) {
      next(error)
    }
  })

  router.post(
    '/admin/identity-provider-setups/microsoft',
    async (req: UiAuthedRequest, res, next) => {
      try {
        const adminUserId = requireAdminSubject(req)
        const fallbackOrigin = `${req.protocol}://${req.get('host') || 'localhost'}`
        const callbackUrl = defaultMicrosoftCallbackUrl(fallbackOrigin)
        const requestedDraft =
          req.body?.draft && typeof req.body.draft === 'object' && !Array.isArray(req.body.draft)
            ? (req.body.draft as Record<string, unknown>)
            : {}
        if (JSON.stringify(requestedDraft).length > 500_000) {
          res.status(413).json({ error: 'identity_provider_setup_too_large' })
          return
        }
        const requestedConnectionId = String(req.body?.connectionId || '').trim()
        const existingConnection = requestedConnectionId
          ? await getIdentityProviderConnection(requestedConnectionId)
          : null
        if (requestedConnectionId && existingConnection?.status !== 'connected') {
          res.status(404).json({ error: 'connected_identity_provider_not_found' })
          return
        }
        const setup = await createIdentityProviderSetup({
          provider: 'microsoft',
          adminUserId,
          initialDraft: {
            ...requestedDraft,
            displayName:
              existingConnection?.displayName ||
              String(requestedDraft.displayName || '') ||
              `${config.controlUiAppName} Teams Integration`,
            callbackUrl,
            tenantId:
              existingConnection?.directoryTenantId || String(requestedDraft.tenantId || ''),
            clientId: existingConnection?.clientId || String(requestedDraft.clientId || ''),
            allowMemberLogin:
              existingConnection?.allowMemberLogin !== false &&
              requestedDraft.allowMemberLogin !== false,
            options: {
              createTeams: true,
              createMembers: true,
              sendInvitations: true,
              allowMemberLogin: existingConnection?.allowMemberLogin !== false,
              ...(requestedDraft.options && typeof requestedDraft.options === 'object'
                ? requestedDraft.options
                : {}),
            },
          },
          connectionId: existingConnection?.id || null,
          currentStep: existingConnection
            ? 7
            : Math.max(1, Math.min(2, Number(req.body?.currentStep || 1))),
          status: existingConnection ? 'configuring' : 'draft',
          replaceActive: req.body?.replaceActive === true,
        })
        res.status(201).json({ setup, callbackUrl, appName: config.controlUiAppName })
      } catch (error) {
        next(error)
      }
    }
  )

  router.patch('/admin/identity-provider-setups/:setupId', async (req, res, next) => {
    try {
      const draft =
        req.body?.draft && typeof req.body.draft === 'object' && !Array.isArray(req.body.draft)
          ? (req.body.draft as Record<string, unknown>)
          : undefined
      if (draft && JSON.stringify(draft).length > 500_000) {
        res.status(413).json({ error: 'identity_provider_setup_too_large' })
        return
      }
      const setup = await updateIdentityProviderSetup({
        setupId: req.params.setupId,
        currentStep:
          req.body?.currentStep === undefined ? undefined : Number(req.body.currentStep || 1),
        draft,
      })
      if (!setup) {
        res.status(404).json({ error: 'identity_provider_setup_not_found' })
        return
      }
      res.status(200).json({ setup })
    } catch (error) {
      next(error)
    }
  })

  router.put('/admin/identity-provider-setups/:setupId/client-secret', async (req, res, next) => {
    try {
      const setup = await saveIdentityProviderSetupSecret(
        req.params.setupId,
        String(req.body?.clientSecret || '')
      )
      if (!setup) {
        res.status(404).json({ error: 'identity_provider_setup_not_found' })
        return
      }
      res.status(200).json({ setup })
    } catch (error) {
      next(error)
    }
  })

  router.post(
    '/admin/identity-provider-setups/:setupId/microsoft/authorize',
    async (req: UiAuthedRequest, res, next) => {
      try {
        const setup = await getIdentityProviderSetupById(req.params.setupId)
        const clientSecret = await loadIdentityProviderSetupSecret(req.params.setupId)
        if (!setup || !clientSecret) {
          res.status(409).json({ error: 'microsoft_setup_incomplete' })
          return
        }
        const displayName = String(setup.draft.displayName || '').trim()
        const tenantId = String(setup.draft.tenantId || '').trim()
        const clientId = String(setup.draft.clientId || '').trim()
        const returnUrl = validatedAdminReturnUrl(req)
        const connection = await createPendingMicrosoftConnection({
          displayName,
          tenantId,
          clientId,
          clientSecret,
          adminUserId: requireAdminSubject(req),
          callbackUrl: defaultMicrosoftCallbackUrl(new URL(returnUrl).origin),
          allowMemberLogin: setup.draft.allowMemberLogin !== false,
          clientSecretExpiresAt: String(setup.draft.clientSecretExpiresAt || '') || null,
        })
        await attachConnectionToIdentityProviderSetup(setup.id, connection.id)
        const oauth = await startMicrosoftOAuth({
          connectionId: connection.id,
          flow: 'admin_connect',
          returnUrl,
        })
        res.status(200).json({ connection, ...oauth })
      } catch (error) {
        next(error)
      }
    }
  )

  router.post(
    '/admin/identity-provider-connections/microsoft',
    async (req: UiAuthedRequest, res, next) => {
      try {
        const returnUrl = validatedAdminReturnUrl(req)
        const connection = await createPendingMicrosoftConnection({
          displayName: String(req.body?.displayName || ''),
          tenantId: String(req.body?.tenantId || ''),
          clientId: String(req.body?.clientId || ''),
          clientSecret: String(req.body?.clientSecret || ''),
          adminUserId: requireAdminSubject(req),
          callbackUrl: defaultMicrosoftCallbackUrl(new URL(returnUrl).origin),
        })
        const oauth = await startMicrosoftOAuth({
          connectionId: connection.id,
          flow: 'admin_connect',
          returnUrl,
        })
        res.status(201).json({ connection, ...oauth })
      } catch (error) {
        next(error)
      }
    }
  )

  router.post(
    '/admin/identity-provider-connections/:connectionId/microsoft/connect',
    async (req: UiAuthedRequest, res, next) => {
      try {
        res.status(200).json(
          await startMicrosoftOAuth({
            connectionId: req.params.connectionId,
            flow: 'admin_connect',
            returnUrl: validatedAdminReturnUrl(req),
          })
        )
      } catch (error) {
        next(error)
      }
    }
  )

  router.delete('/admin/identity-provider-connections/:connectionId', async (req, res, next) => {
    try {
      const disconnected = await disconnectIdentityProviderConnection(req.params.connectionId)
      if (!disconnected) {
        res.status(404).json({ error: 'connection_not_found' })
        return
      }
      res.status(200).json({ disconnected: true })
    } catch (error) {
      next(error)
    }
  })

  router.patch(
    '/admin/identity-provider-connections/:connectionId',
    async (req: UiAuthedRequest, res, next) => {
      try {
        // Validate the OAuth continuation before changing credentials. A bad
        // return URL must never turn a working connection into a pending one.
        const returnUrl = validatedAdminReturnUrl(req)
        const updated = await updateMicrosoftIdentityProviderConnection({
          connectionId: req.params.connectionId,
          displayName: String(req.body?.displayName || ''),
          tenantId: String(req.body?.tenantId || ''),
          clientId: String(req.body?.clientId || ''),
          clientSecret: String(req.body?.clientSecret || ''),
          allowMemberLogin: req.body?.allowMemberLogin !== false,
          clientSecretExpiresAt: String(req.body?.clientSecretExpiresAt || '') || null,
        })
        if (!updated) {
          res.status(404).json({ error: 'connection_not_found' })
          return
        }
        if (!updated.requiresAuthorization) {
          res.status(200).json(updated)
          return
        }
        res.status(200).json({
          ...updated,
          ...(await startMicrosoftOAuth({
            connectionId: updated.connection.id,
            flow: 'admin_connect',
            returnUrl,
          })),
        })
      } catch (error) {
        next(error)
      }
    }
  )

  router.get(
    '/admin/identity-provider-connections/:connectionId/directory',
    async (req, res, next) => {
      try {
        const [directory, teams, agents, contexts, teamAgents, teamContexts] = await Promise.all([
          loadMicrosoftDirectory(req.params.connectionId),
          listAllTeams(),
          loadAdminActiveAgentNames(gateway),
          loadAdminActiveContextIds(gateway),
          listTeamAgentsByTeam(),
          listTeamContextsByTeam(),
        ])
        res.status(200).json({
          ...directory,
          evenfireTeams: teams,
          agents,
          contexts,
          teamAgents,
          teamContexts,
        })
      } catch (error) {
        next(error)
      }
    }
  )

  router.post(
    '/admin/identity-provider-setups/:setupId/execute',
    async (req: UiAuthedRequest, res, next) => {
      try {
        const [activeAgentNames, activeContextIds] = await Promise.all([
          loadAdminActiveAgentNames(gateway),
          loadAdminActiveContextIds(gateway),
        ])
        res.status(200).json(
          await executeMicrosoftImport({
            setupId: req.params.setupId,
            allowedAgentNames: new Set(activeAgentNames),
            allowedContextIds: new Set(activeContextIds),
            operatorSub: requireAdminSubject(req),
          })
        )
      } catch (error) {
        next(error)
      }
    }
  )

  return router
}
