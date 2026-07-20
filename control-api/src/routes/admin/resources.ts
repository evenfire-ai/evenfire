import { type NextFunction, type Request, type Response, Router } from 'express'
import { config } from '../../config.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import { enforceNamespace } from '../../http/namespaceAudit.js'
import { validateCommunicationChannelSpec } from '../../http/validateCommunicationChannelSpec.js'
import { validateMcpServerSpecPreflight } from '../../http/validateMcpServerSpec.js'
import { K8sGateway } from '../../k8s.js'
import { K8sConflictError } from '../../services/resourceService.js'
import { ClerumResourceType } from '../../types.js'
import {
  registerCommunicationChannelCredentialsRoutes,
  validateCommunicationChannelCredentials,
} from './communicationChannelCredentials.js'
import {
  ccCredentialsSecretName,
  extractK8sStatusCode,
  preserveCommunicationChannelCredentialsSecretRef,
} from './communicationChannelSpecHelpers.js'
import { validateHostSecretRef } from './hostSecrets.js'
import { validateHostSpec } from './hostSpecValidation.js'

const PROVIDER_SETTINGS_FIELDS: Readonly<Record<string, readonly string[]>> = {
  telegramSettings: ['botHandle', 'replyOnlyWhenMentioned'],
  slackSettings: ['workspaceId', 'botHandle', 'replyOnlyWhenMentioned', 'replyInThreads'],
  teamsSettings: ['appName', 'appId', 'tenantId', 'replyOnlyWhenMentioned'],
}

type CommunicationChannelSpecSnapshot = {
  spec: Record<string, unknown>
  resourceVersion?: string
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function resourceVersionFromResource(resource: unknown): string | undefined {
  const metadata = recordValue((resource as { metadata?: unknown } | null)?.metadata)
  const resourceVersion = metadata?.resourceVersion
  return typeof resourceVersion === 'string' && resourceVersion ? resourceVersion : undefined
}

function missingPersistedProviderSetting(
  requestedSpec: Record<string, unknown>,
  persisted: unknown
): string | null {
  const persistedSpec = recordValue((persisted as { spec?: unknown } | null)?.spec) || {}

  for (const [settingsKey, fields] of Object.entries(PROVIDER_SETTINGS_FIELDS)) {
    const requestedSettings = recordValue(requestedSpec[settingsKey])
    if (!requestedSettings) continue
    const persistedSettings = recordValue(persistedSpec[settingsKey])

    for (const field of fields) {
      if (requestedSettings[field] === undefined) continue
      if (persistedSettings?.[field] === undefined) return `spec.${settingsKey}.${field}`
    }
  }

  return null
}

function sendPrunedProviderSettingError(res: Response, field: string): void {
  console.warn(`[Admin] CommunicationChannel provider setting was pruned: ${field}`)
  res.status(409).json({
    code: 'communication_channel_crd_outdated',
    error:
      `CommunicationChannel ${field} was not persisted by Kubernetes. ` +
      'Apply the latest clerum-crds before creating or updating this provider.',
  })
}

async function rollbackPrunedCommunicationChannelCreate(
  gateway: K8sGateway,
  name: string,
  namespace: string,
  credentialsSecretName?: string
): Promise<void> {
  try {
    await gateway.deleteResource('communicationchannels', name, namespace)
  } catch (err) {
    console.warn(
      `[Admin] cc pruned-setting rollback failed for "${name}": ${err instanceof Error ? err.message : String(err)}`
    )
  }
  if (!credentialsSecretName) return
  try {
    await gateway.deleteSecret(credentialsSecretName, namespace)
  } catch (err) {
    console.warn(
      `[Admin] cc credentials rollback failed for "${credentialsSecretName}": ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

async function loadCommunicationChannelSpecSnapshot(
  gateway: K8sGateway,
  name: string,
  namespace: string
): Promise<CommunicationChannelSpecSnapshot | null> {
  try {
    const existing = await gateway.getResource('communicationchannels', name, namespace)
    const spec = recordValue((existing as { spec?: unknown } | null)?.spec)
    const resourceVersion = resourceVersionFromResource(existing)
    return {
      spec: spec ? { ...spec } : {},
      ...(resourceVersion ? { resourceVersion } : {}),
    }
  } catch (err) {
    if (extractK8sStatusCode(err) === 404) return null
    throw err
  }
}

async function rollbackPrunedCommunicationChannelUpdate(
  gateway: K8sGateway,
  name: string,
  namespace: string,
  snapshot: CommunicationChannelSpecSnapshot | null,
  resourceVersion?: string
): Promise<void> {
  if (!snapshot) return
  try {
    const restored = await gateway.updateResource(
      'communicationchannels',
      name,
      {
        ...(resourceVersion ? { metadata: { resourceVersion } } : {}),
        spec: snapshot.spec,
      },
      namespace
    )
    const missingField = missingPersistedProviderSetting(snapshot.spec, restored)
    if (missingField) {
      console.warn(
        `[Admin] cc pruned-setting rollback for "${name}" could not restore ${missingField}`
      )
    }
  } catch (err) {
    console.warn(
      `[Admin] cc pruned-setting rollback failed for "${name}": ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/**
 * Return true if the CC spec has at least one non-empty provider array
 * (telegram, slack, teams, or email). These are the providers that require a
 * credentials Secret to function; a CC without any provider is valid
 * (e.g. a bare hostRef-only CC for future configuration).
 */
function ccSpecHasProvider(spec: Record<string, unknown>): boolean {
  const telegramSettings = recordValue(spec.telegramSettings)
  const slackSettings = recordValue(spec.slackSettings)
  const teamsSettings = recordValue(spec.teamsSettings)
  return (
    (Array.isArray(spec.telegram) && spec.telegram.length > 0) ||
    (Array.isArray(spec.slack) && spec.slack.length > 0) ||
    (Array.isArray(spec.teams) && spec.teams.length > 0) ||
    (Array.isArray(spec.email) && spec.email.length > 0) ||
    !!telegramSettings?.botHandle ||
    !!slackSettings?.workspaceId ||
    !!slackSettings?.botHandle ||
    !!teamsSettings?.appName ||
    !!teamsSettings?.appId ||
    !!teamsSettings?.tenantId
  )
}

function ccSpecHasTelegramProvider(spec: Record<string, unknown>): boolean {
  const telegramSettings = recordValue(spec.telegramSettings)
  return (Array.isArray(spec.telegram) && spec.telegram.length > 0) || !!telegramSettings?.botHandle
}

function ccSpecHasSlackProvider(spec: Record<string, unknown>): boolean {
  const slackSettings = recordValue(spec.slackSettings)
  return (
    (Array.isArray(spec.slack) && spec.slack.length > 0) ||
    !!slackSettings?.workspaceId ||
    !!slackSettings?.botHandle
  )
}

function ccSpecHasTeamsProvider(spec: Record<string, unknown>): boolean {
  const teamsSettings = recordValue(spec.teamsSettings)
  return (
    (Array.isArray(spec.teams) && spec.teams.length > 0) ||
    !!teamsSettings?.appName ||
    !!teamsSettings?.appId ||
    !!teamsSettings?.tenantId
  )
}

function missingCreateCredentialKey(
  spec: Record<string, unknown>,
  credentials: Record<string, string>
): string | null {
  if (ccSpecHasTelegramProvider(spec) && !credentials['telegram-bot-token']) {
    return 'telegram-bot-token'
  }
  if (ccSpecHasSlackProvider(spec)) {
    for (const key of ['slack-signing-secret', 'slack-bot-token']) {
      if (!credentials[key]) return key
    }
  }
  if (ccSpecHasTeamsProvider(spec) && !credentials['teams-app-password']) {
    return 'teams-app-password'
  }
  return null
}

// workflowrecipes is handled by recipes.ts (canonical sandbox-recipes route).
// workflowrecipepolicies is read inline by the recipes policy-invariant
// helper and does not need generic admin CRUD routing.
// sharedfilesystems is handled by sharedFilesystems.ts (admin-only writes
// + token mint + reverse proxy to the per-SFS wfc).
type AdminResourceType = Exclude<
  ClerumResourceType,
  'workflowrecipes' | 'workflowrecipepolicies' | 'sharedfilesystems'
>

const RESOURCE_MAP: Record<string, AdminResourceType> = {
  hosts: 'hosts',
  contexts: 'contexts',
  communicationchannels: 'communicationchannels',
  'communication-channels': 'communicationchannels',
  mcpservers: 'mcpservers',
  'mcp-servers': 'mcpservers',
}

function resourceNamespace(plural: AdminResourceType): string {
  switch (plural) {
    case 'hosts':
      return config.hostsNamespace
    case 'contexts':
      return config.contextsNamespace
    case 'communicationchannels':
      return config.communicationChannelsNamespace
    case 'mcpservers':
      return config.mcpServersNamespace
  }
}

function communicationChannelMatchesConfirmedUser(item: unknown, userId: string): boolean {
  const spec = (item as { spec?: Record<string, unknown> } | null)?.spec
  if (!spec) return false
  const groups = [
    ...(Array.isArray(spec.telegram) ? spec.telegram : []),
    ...(Array.isArray(spec.slack) ? spec.slack : []),
    ...(Array.isArray(spec.teams) ? spec.teams : []),
    ...(Array.isArray(spec.email) ? spec.email : []),
  ]
  return groups.some(group => {
    if (!group || typeof group !== 'object') return false
    return String((group as { confirmedByUserId?: unknown }).confirmedByUserId || '') === userId
  })
}

const RESOURCE_PATTERN =
  '/admin/:resource(hosts|contexts|communication-channels|communicationchannels|mcp-servers|mcpservers)'

/** Resolve the plural type and canonical namespace for a resource route param. */
function resolveResource(param: string): { plural: AdminResourceType; ns: string } | null {
  const plural = RESOURCE_MAP[param]
  if (!plural) return null
  return { plural, ns: resourceNamespace(plural) }
}

export function createAdminResourcesRouter(gateway: K8sGateway): Router {
  const router = Router()

  // Middleware: enforce namespace per resource type and audit any injection attempt.
  // Uses enforceNamespace() consistently with all other admin routers.
  router.use(RESOURCE_PATTERN, (req: Request, _res: Response, next: NextFunction) => {
    const resolved = resolveResource(req.params.resource)
    if (resolved) {
      enforceNamespace(resolved.ns)(req, _res, next)
    } else {
      next()
    }
  })

  router.get(
    RESOURCE_PATTERN,
    asyncHandler(async (req, res) => {
      const { plural, ns } = resolveResource(req.params.resource)!
      let items = await gateway.listResource(plural, ns)
      const confirmedByUserId =
        typeof req.query.confirmedByUserId === 'string' ? req.query.confirmedByUserId.trim() : ''
      if (plural === 'communicationchannels' && confirmedByUserId) {
        items = items.filter(item =>
          communicationChannelMatchesConfirmedUser(item, confirmedByUserId)
        )
      }
      res.status(200).json({ items })
    })
  )

  router.post(
    RESOURCE_PATTERN,
    asyncHandler(async (req, res) => {
      const { plural, ns } = resolveResource(req.params.resource)!
      const body = req.body as {
        metadata: { name: string }
        spec: Record<string, unknown> & {
          envSecret?: { name?: unknown }
        }
        credentials?: Record<string, string>
      }

      if (plural === 'communicationchannels' && body.spec) {
        const errors = validateCommunicationChannelSpec(body.spec)
        if (errors.length > 0) {
          res.status(422).json({ errors })
          return
        }

        // B4: a CC with a provider (telegram/slack/teams/email) must not be created
        // without credentials. Require EITHER a `credentials` envelope on the
        // request OR a `credentialsSecretRef` already present in the spec.
        if (ccSpecHasProvider(body.spec) && !body.credentials && !body.spec.credentialsSecretRef) {
          res.status(400).json({
            error:
              'A CommunicationChannel with a provider (telegram, slack, teams, or email) requires ' +
              'credentials. Supply a "credentials" envelope on the request, or set ' +
              '"spec.credentialsSecretRef" to an existing Secret.',
          })
          return
        }
      }

      if (plural === 'communicationchannels' && body.credentials) {
        const credentialValidation = validateCommunicationChannelCredentials(body.credentials)
        if (!credentialValidation.ok) {
          res.status(400).json({ error: credentialValidation.error })
          return
        }
        const missingKey = missingCreateCredentialKey(body.spec, credentialValidation.values)
        if (missingKey) {
          res.status(400).json({
            error: `credentials["${missingKey}"] is required for this CommunicationChannel provider`,
          })
          return
        }
        const ccName = body.metadata?.name
        if (!ccName) {
          res.status(400).json({ error: 'metadata.name is required' })
          return
        }
        const secretName = ccCredentialsSecretName(ccName)
        await gateway.createSecret({
          name: secretName,
          namespace: ns,
          type: 'Opaque',
          stringData: credentialValidation.values,
        })
        // Inject credentialsSecretRef into the CC spec; strip the
        // non-CRD `credentials` envelope so it does not leak into the
        // CustomObjects API call.
        const { credentials: _credentials, ...rest } = body
        const ccBody = {
          ...rest,
          spec: {
            ...rest.spec,
            credentialsSecretRef: { name: secretName },
          },
        }
        try {
          const created = await gateway.createResource(plural, ccBody, ns)
          const missingField = missingPersistedProviderSetting(ccBody.spec, created)
          if (missingField) {
            await rollbackPrunedCommunicationChannelCreate(gateway, ccName, ns, secretName)
            sendPrunedProviderSettingError(res, missingField)
            return
          }
          res.status(201).json(created)
        } catch (err) {
          // Best-effort rollback. 404 from a stale Secret read or a
          // missing-secret race is tolerable — log and bubble the
          // original CRD error up so the caller sees the failure cause.
          try {
            await gateway.deleteSecret(secretName, ns)
          } catch (rollbackErr) {
            console.warn(
              `[Admin] cc credentials rollback failed for "${secretName}": ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`
            )
          }
          throw err
        }
        return
      }

      // Early validation for Host specs — spec.approval.tools shape + R3 model
      // allowlist enforcement (fail-closed for a declared spec.model.name).
      if (plural === 'hosts' && body.spec) {
        const issue = await validateHostSpec(body.spec)
        if (issue) {
          res.status(422).json(issue)
          return
        }
        // Anti-spoofing: an existing secretRef target must be an LLM host Secret.
        const secretRefIssue = await validateHostSecretRef(gateway, body.spec)
        if (secretRefIssue) {
          res.status(422).json(secretRefIssue)
          return
        }
      }

      // Early validation for McpServer specs — UX safety net + defense-in-depth.
      // HCC reconciler also sanitizes as a backstop.
      if (plural === 'mcpservers' && body.spec) {
        const errors = await validateMcpServerSpecPreflight(body.spec, {
          allowedImagePrefixes: config.allowedPluginImagePrefixes,
          enforceImageAllowlist: config.enforcePluginImageAllowlist,
        })
        if (errors.length > 0) {
          res.status(422).json({ errors })
          return
        }

        // Missing envSecret refs are allowed at creation time so Connector
        // Secrets can be completed from the Secrets UI after the McpServer CRD
        // exists. HCC/Kubernetes still fail closed until the Secret is added.
      }

      const created = await gateway.createResource(plural, body, ns)
      if (plural === 'communicationchannels' && body.spec) {
        const missingField = missingPersistedProviderSetting(body.spec, created)
        if (missingField) {
          await rollbackPrunedCommunicationChannelCreate(gateway, body.metadata.name, ns)
          sendPrunedProviderSettingError(res, missingField)
          return
        }
      }
      res.status(201).json(created)
    })
  )

  router.get(
    `${RESOURCE_PATTERN}/:name`,
    asyncHandler(async (req, res) => {
      const { plural, ns } = resolveResource(req.params.resource)!
      const resource = await gateway.getResource(plural, req.params.name, ns)
      res.status(200).json(resource)
    })
  )

  router.put(
    `${RESOURCE_PATTERN}/:name`,
    asyncHandler(async (req, res) => {
      const { plural, ns } = resolveResource(req.params.resource)!
      const body = req.body as {
        metadata?: {
          labels?: Record<string, string>
          annotations?: Record<string, string>
          resourceVersion?: string
        }
        spec: Record<string, unknown>
      }

      if (plural === 'communicationchannels' && body.spec) {
        const errors = validateCommunicationChannelSpec(body.spec)
        if (errors.length > 0) {
          res.status(422).json({ errors })
          return
        }
      }

      // Same early validation for McpServer updates.
      if (plural === 'mcpservers' && body.spec) {
        const errors = await validateMcpServerSpecPreflight(body.spec, {
          allowedImagePrefixes: config.allowedPluginImagePrefixes,
          enforceImageAllowlist: config.enforcePluginImageAllowlist,
        })
        if (errors.length > 0) {
          res.status(422).json({ errors })
          return
        }
      }

      if (plural === 'hosts' && body.spec) {
        const issue = await validateHostSpec(body.spec)
        if (issue) {
          res.status(422).json(issue)
          return
        }
        const secretRefIssue = await validateHostSecretRef(gateway, body.spec)
        if (secretRefIssue) {
          res.status(422).json(secretRefIssue)
          return
        }
      }

      const isCommunicationChannelUpdate = plural === 'communicationchannels' && body.spec
      const previousCommunicationChannelSpec = isCommunicationChannelUpdate
        ? await loadCommunicationChannelSpecSnapshot(gateway, req.params.name, ns)
        : null
      const updateBody = isCommunicationChannelUpdate
        ? {
            ...body,
            metadata: {
              ...body.metadata,
              ...(body.metadata?.resourceVersion ||
              !previousCommunicationChannelSpec?.resourceVersion
                ? {}
                : { resourceVersion: previousCommunicationChannelSpec.resourceVersion }),
            },
            spec: await preserveCommunicationChannelCredentialsSecretRef(
              gateway,
              req.params.name,
              ns,
              body.spec,
              previousCommunicationChannelSpec?.spec ?? null
            ),
          }
        : body
      try {
        const updated = await gateway.updateResource(plural, req.params.name, updateBody, ns)
        if (plural === 'communicationchannels' && body.spec) {
          const missingField = missingPersistedProviderSetting(updateBody.spec, updated)
          if (missingField) {
            await rollbackPrunedCommunicationChannelUpdate(
              gateway,
              req.params.name,
              ns,
              previousCommunicationChannelSpec,
              resourceVersionFromResource(updated)
            )
            sendPrunedProviderSettingError(res, missingField)
            return
          }
        }
        res.status(200).json(updated)
      } catch (err) {
        // AP-6: the caller sent the resourceVersion it read and the resource
        // changed underneath it. Machine-readable so the UI can tell the
        // operator to reload — never retried server-side with the stale body.
        if (err instanceof K8sConflictError) {
          res.status(409).json({ error: 'conflict', reason: 'resource_changed' })
          return
        }
        throw err
      }
    })
  )

  router.delete(
    `${RESOURCE_PATTERN}/:name`,
    asyncHandler(async (req, res) => {
      const { plural, ns } = resolveResource(req.params.resource)!
      const name = req.params.name

      // CommunicationChannel: read the credentialsSecretRef name FIRST (we
      // can't read the CC after it's deleted), then delete the CC, then
      // delete the Secret. The CC-first order means HCC's SecretInformer
      // observes the Secret DELETED event when no CC references it anymore,
      // so reconcileChannelReaderRevision short-circuits cleanly with zero
      // CCs — no transient "patch with sha256 of empty data" annotation
      // roll. Tradeoff: if Secret delete fails after CC delete, an orphan
      // Secret survives. That's harmless (Secrets without referencing CCs
      // do nothing) and easier to clean up than an orphan CC.
      let ccSecretRefName: string | undefined
      if (plural === 'communicationchannels') {
        try {
          const cc = (await gateway.getResource(plural, name, ns)) as {
            spec?: { credentialsSecretRef?: { name?: string } }
          }
          ccSecretRefName = cc.spec?.credentialsSecretRef?.name
        } catch (err) {
          if (extractK8sStatusCode(err) !== 404) {
            throw err
          }
        }
      }

      const deleted = await gateway.deleteResource(plural, name, ns)

      if (plural === 'communicationchannels' && ccSecretRefName) {
        try {
          await gateway.deleteSecret(ccSecretRefName, ns)
          console.log(`[Admin] Deleted CC credentials Secret "${ccSecretRefName}" in ${ns}`)
        } catch (err) {
          if (extractK8sStatusCode(err) === 404) {
            console.log(`[Admin] CC credentials Secret "${ccSecretRefName}" already gone in ${ns}`)
          } else {
            // CC is already gone; log and swallow so the operator gets a 200
            // and can clean the orphan Secret manually if needed.
            console.error(
              `[Admin] CC delete succeeded but credentials Secret "${ccSecretRefName}" cleanup failed:`,
              err
            )
          }
        }
      }

      if (plural === 'mcpservers') {
        const contextsNs = resourceNamespace('contexts')
        try {
          await gateway.deleteSecret(`${name}-credentials`, ns)
          console.log(`[Admin] Deleted credentials secret "${name}-credentials" in ${ns}`)
        } catch (err) {
          console.log(
            `[Admin] No credentials secret to delete for "${name}": ${err instanceof Error ? err.message : String(err)}`
          )
        }

        try {
          const ctxList = (await gateway.listResource('contexts', contextsNs)) as Array<{
            metadata?: { name?: string }
            spec?: { contextId?: string; description?: string; mcpServers?: string[] }
          }>
          for (const ctx of ctxList) {
            const ctxName = ctx.metadata?.name
            const servers = ctx.spec?.mcpServers ?? []
            if (ctxName && servers.includes(name)) {
              await gateway.updateResource(
                'contexts',
                ctxName,
                {
                  spec: {
                    contextId: ctx.spec?.contextId ?? ctxName,
                    description: ctx.spec?.description,
                    mcpServers: servers.filter(s => s !== name),
                  } as Record<string, unknown>,
                },
                contextsNs
              )
              console.log(`[Admin] Removed "${name}" from Context "${ctxName}" allowlist`)
            }
          }
        } catch (err) {
          console.error(
            `[Admin] Failed to clean up Context allowlists for "${name}": ${err instanceof Error ? err.message : String(err)}`
          )
        }
      }

      res.status(200).json(deleted)
    })
  )

  registerCommunicationChannelCredentialsRoutes(router, gateway)

  return router
}
