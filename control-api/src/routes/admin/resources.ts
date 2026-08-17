import { type NextFunction, type Request, type Response, Router } from 'express'
import { config } from '../../config.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import { enforceNamespace } from '../../http/namespaceAudit.js'
import { validateCommunicationChannelSpec } from '../../http/validateCommunicationChannelSpec.js'
import { validateMcpServerSpecPreflight } from '../../http/validateMcpServerSpec.js'
import { K8sGateway } from '../../k8s.js'
import { stripHookRefFromHosts } from '../../services/hostGuardrailRefs.js'
import {
  K8sConflictError,
  K8sNotFoundError,
  type MutableResourceSnapshot,
} from '../../services/resourceService.js'
import { secretKeyNames } from '../../services/secretKeyNames.js'
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
import { collectResourceSpecFieldIssues, validateResourceName } from './resourceFieldValidation.js'

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
 * Deploy-order guard for the additive context `spec.displayName` field (PR #304).
 *
 * `spec.displayName` is a new, optional, additive field on the context CRD. If a
 * create/update carries a non-empty `spec.displayName` but the CRD applied to
 * the cluster does NOT yet declare the field (deploy-order skew: control-ui
 * writes the field before the CRD update lands), the apiserver PRUNES the
 * unknown field SILENTLY and returns success — the display name is lost with no
 * error surfaced to the operator.
 *
 * This is a pure read-after-write check: it compares the value the caller sent
 * against the object the apiserver actually persisted. A create/replace returns
 * the persisted object AFTER pruning, so this reuses that response with NO extra
 * apiserver read (preserving the N1 single-read-per-PUT optimization).
 *
 * STRICTLY SCOPED to `contexts` + `spec.displayName` — the only additive field
 * at pruning risk in this PR. Do NOT generalize to other fields or resources:
 * that would be a decision module (which fields, precedence) requiring its own
 * mini-spec, not a one-field hardening net.
 */
function contextDisplayNameNotPersisted(
  requestedSpec: Record<string, unknown>,
  persisted: unknown
): boolean {
  const requested = requestedSpec.displayName
  // Only fire when the caller actually asked for a non-empty display name.
  if (typeof requested !== 'string' || requested.trim() === '') return false
  const persistedSpec = recordValue((persisted as { spec?: unknown } | null)?.spec) || {}
  // Missing (pruned) OR differs from what was sent — either way it did not
  // round-trip. displayName is stored verbatim (free text, no server-side
  // normalization), so a mismatch here means loss, not transformation.
  return persistedSpec.displayName !== requested
}

function sendPrunedDisplayNameError(res: Response): void {
  console.warn('[Admin] Context spec.displayName was pruned by the apiserver (CRD outdated)')
  res.status(409).json({
    code: 'context_crd_outdated',
    error:
      'Context spec.displayName was not persisted by Kubernetes; the context CRD does not ' +
      'support spec.displayName. Apply the latest clerum-crds (which add spec.displayName) ' +
      'before setting a display name.',
  })
}

/**
 * Best-effort rollback of a context whose create silently dropped
 * `spec.displayName`. Unlike the update path, a POST is NOT idempotent: leaving
 * the pruned context in place would make the operator's retry (after applying
 * the CRD) collide with a 409 AlreadyExists. Deleting it restores a clean retry
 * path. Mirrors rollbackPrunedCommunicationChannelCreate.
 */
async function rollbackPrunedContextCreate(
  gateway: K8sGateway,
  name: string,
  namespace: string
): Promise<void> {
  try {
    await gateway.deleteResource('contexts', name, namespace)
  } catch (err) {
    const safeName = String(name).replace(/[\r\n]/g, '')
    const safeErrMsg = (err instanceof Error ? err.message : String(err)).replace(/[\r\n]/g, '')
    console.warn(
      `[Admin] context pruned-displayName rollback failed for "${safeName}": ${safeErrMsg}`
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

const PROVIDER_REQUIRED_KEYS: Record<string, string[]> = {
  telegram: ['telegram-bot-token'],
  slack: ['slack-bot-token', 'slack-signing-secret'],
  teams: ['teams-app-password'],
  email: ['email-username', 'email-password'],
}

function providersEnabled(spec: Record<string, unknown> | null): Set<string> {
  const enabled = new Set<string>()
  if (!spec) return enabled
  if (ccSpecHasTelegramProvider(spec)) enabled.add('telegram')
  if (ccSpecHasSlackProvider(spec)) enabled.add('slack')
  if (ccSpecHasTeamsProvider(spec)) enabled.add('teams')
  if (Array.isArray(spec.email) && spec.email.length > 0) enabled.add('email')
  return enabled
}

/**
 * Validate providers that go absent -> present. Returns an error message, or null.
 *
 * Deliberately scoped to the transition: a channel already missing keys in a
 * cluster stays editable, and enabling a NEW provider without its credentials is
 * refused. Presence of `credentialsSecretRef` proves nothing, which is why the
 * pre-existing POST guard missed this entirely — the channel that motivated this
 * (#312) already had a ref, holding only its Telegram token, and still accepted a
 * Slack App Name.
 *
 * Fails CLOSED: an unreadable Secret rejects the write. Refusing a write on a
 * read failure is safe; assuming the keys are there is how a channel ends up
 * advertising a provider it cannot serve.
 */
async function providerTransitionError(
  gateway: K8sGateway,
  nextSpec: Record<string, unknown>,
  previousSpec: Record<string, unknown> | null,
  credentials: Record<string, string> | undefined,
  namespace: string
): Promise<string | null> {
  const previouslyEnabled = providersEnabled(previousSpec)
  const added = [...providersEnabled(nextSpec)].filter(p => !previouslyEnabled.has(p))
  if (added.length === 0) return null

  const secretName = (nextSpec.credentialsSecretRef as { name?: string } | undefined)?.name?.trim()
  let existingKeys: string[] = []
  if (secretName) {
    try {
      existingKeys = await secretKeyNames(gateway, secretName, namespace)
    } catch {
      return `Cannot read the credentials Secret "${secretName}" to validate the new provider. Fix access to that Secret, or supply the credentials with this request.`
    }
  }

  for (const provider of added) {
    for (const key of PROVIDER_REQUIRED_KEYS[provider] || []) {
      // Trimmed, because this reads the RAW envelope while the Secret is written
      // from the CLEANED values: `validateCommunicationChannelCredentials` drops
      // whitespace-only entries, so a truthy "   " here would satisfy the guard
      // and then never reach the Secret. A present-but-non-string value (e.g. a
      // number) is NOT "missing" though: it's `validateCommunicationChannelCredentials`
      // below that owns rejecting the wrong type with its own 400, so this only
      // calls `.trim()` once `typeof` has confirmed there's a string to trim.
      const rawValue = credentials?.[key]
      const isMissing = rawValue === undefined || (typeof rawValue === 'string' && !rawValue.trim())
      if (isMissing && !existingKeys.includes(key)) {
        return `credentials["${key}"] is required to enable the ${provider} provider on this CommunicationChannel`
      }
    }
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
  llmhooks: 'llmhooks',
  'llm-hooks': 'llmhooks',
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
    case 'llmhooks':
      return config.llmHooksNamespace
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

// LlmHook guardrail CRs get READ + DELETE only through the generic router.
// Creation/update goes through the org-scoped registry `install-hook` saga
// (registry.ts) so the install-time trust_level + image-allowlist preflight
// cannot be bypassed by a raw POST/PUT — the same reason recipes are not in the
// generic CRUD pattern. This lane powers the control-ui cluster-wide list, the
// per-hook status detail, and uninstall.
const LLMHOOK_PATTERN = '/admin/:resource(llmhooks|llm-hooks)'

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

      // FIX-A1: validate metadata.name (RFC1123) for ALL plurals BEFORE any spec
      // validation or side effect (e.g. CC credentials Secret creation). An
      // invalid name would otherwise reach K8s and its 422 would collapse to 500.
      const nameIssue = validateResourceName(body.metadata?.name)
      if (nameIssue) {
        res.status(422).json(nameIssue)
        return
      }

      // F0.3: identifier/display field validation for hosts + contexts (create =
      // no ratchet; every present field is validated).
      if ((plural === 'hosts' || plural === 'contexts') && body.spec) {
        const fieldIssues = collectResourceSpecFieldIssues(plural, body.spec, null)
        if (fieldIssues.length > 0) {
          res.status(422).json({ errors: fieldIssues })
          return
        }
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

        // Every declared provider is new on create, so the whole spec is the
        // transition. A credentialsSecretRef satisfies the guard above without
        // proving the Secret behind it holds this provider's keys.
        const transitionError = await providerTransitionError(
          gateway,
          body.spec,
          null,
          body.credentials,
          ns
        )
        if (transitionError) {
          res.status(400).json({ error: transitionError })
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
      if (
        plural === 'contexts' &&
        body.spec &&
        contextDisplayNameNotPersisted(body.spec, created)
      ) {
        await rollbackPrunedContextCreate(gateway, body.metadata.name, ns)
        sendPrunedDisplayNameError(res)
        return
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

      // N1 — the CR read by the ratchet below is handed to updateResource so a
      // hosts/contexts PUT reads the apiserver ONCE, not twice (updateResource
      // already reads `current` internally). Undefined for non hosts/contexts
      // plurals and on the 404 path, where updateResource reads afresh and
      // surfaces the real 404.
      let ratchetCurrent: MutableResourceSnapshot | undefined

      // F0.3 RATCHET: for hosts + contexts, validate an identifier/display field
      // ONLY IF its value changed vs the current CR, so a legacy resource whose
      // spec.host / contextId is out of norm is never blocked for other edits.
      if ((plural === 'hosts' || plural === 'contexts') && body.spec) {
        let currentSpec: Record<string, unknown> | null = null
        try {
          const current = (await gateway.getResource(plural, req.params.name, ns)) as
            | (MutableResourceSnapshot & { spec?: Record<string, unknown> })
            | null
          currentSpec = recordValue(current?.spec)
          ratchetCurrent = current ?? undefined
        } catch (err) {
          // Missing resource: fall through with currentSpec=null (validate every
          // present field). The subsequent updateResource surfaces the real 404.
          // getResource wraps a namespaced 404 as K8sNotFoundError (httpStatus),
          // which extractK8sStatusCode does not read, so check both.
          if (!(err instanceof K8sNotFoundError) && extractK8sStatusCode(err) !== 404) throw err
        }
        const fieldIssues = collectResourceSpecFieldIssues(plural, body.spec, currentSpec)
        if (fieldIssues.length > 0) {
          res.status(422).json({ errors: fieldIssues })
          return
        }
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
      // A null snapshot means the channel does not exist (loadCommunicationChannelSpecSnapshot
      // returns null only on 404). Skipping the guard here is what makes the response
      // honest: with no previous spec every provider reads as newly added, so the guard
      // would answer a PUT to a missing channel with `credentials[...] is required`
      // instead of the 404 updateResource is about to produce.
      if (isCommunicationChannelUpdate && previousCommunicationChannelSpec) {
        // updateBody.spec, not body.spec: the ref the write will actually carry
        // is the preserved one, and that is the Secret whose keys decide whether
        // a newly enabled provider can work. Reuses the snapshot already loaded
        // above — no second fetch.
        const transitionError = await providerTransitionError(
          gateway,
          updateBody.spec,
          previousCommunicationChannelSpec?.spec ?? null,
          undefined,
          ns
        )
        if (transitionError) {
          res.status(400).json({ error: transitionError })
          return
        }
      }
      try {
        // Only the ratchet path (hosts/contexts) has a pre-read to hand off; the
        // CC/mcpservers paths call with the original 4-arg arity untouched.
        const updated = ratchetCurrent
          ? await gateway.updateResource(plural, req.params.name, updateBody, ns, {
              preReadCurrent: ratchetCurrent,
            })
          : await gateway.updateResource(plural, req.params.name, updateBody, ns)
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
        if (
          plural === 'contexts' &&
          body.spec &&
          contextDisplayNameNotPersisted(body.spec, updated)
        ) {
          // Deliberately NO spec restore (unlike the CC update rollback): the
          // context's other spec fields persisted legitimately, and a PUT is
          // idempotent — once the operator applies the CRD and replays the same
          // request, spec.displayName round-trips and the whole spec converges.
          // Restoring the prior spec would instead discard those legitimate
          // edits. The loud 409 is the recovery signal.
          sendPrunedDisplayNameError(res)
          return
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
            spec?: Record<string, unknown> & {
              contextId?: string
              description?: string
              mcpServers?: string[]
            }
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
                    ...ctx.spec,
                    contextId: ctx.spec?.contextId ?? ctxName,
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

  // ── LlmHook guardrail CRs: read + delete only (see LLMHOOK_PATTERN) ──────────
  router.use(LLMHOOK_PATTERN, (req: Request, _res: Response, next: NextFunction) => {
    const resolved = resolveResource(req.params.resource)
    if (resolved) {
      enforceNamespace(resolved.ns)(req, _res, next)
    } else {
      next()
    }
  })

  // Cluster-wide list (control-ui hooks dashboard).
  router.get(
    LLMHOOK_PATTERN,
    asyncHandler(async (req, res) => {
      const { plural, ns } = resolveResource(req.params.resource)!
      const items = await gateway.listResource(plural, ns)
      res.status(200).json({ items })
    })
  )

  // Single hook (status detail / digest drift).
  router.get(
    `${LLMHOOK_PATTERN}/:name`,
    asyncHandler(async (req, res) => {
      const { plural, ns } = resolveResource(req.params.resource)!
      const resource = await gateway.getResource(plural, req.params.name, ns)
      res.status(200).json(resource)
    })
  )

  // Uninstall. Referential integrity (§8.2): strip the `{id}` reference from every
  // referencing Host's guardrails.hooks FIRST, so no dangling ref is ever visible
  // (mcp-host can't fail-closed on a vanished CR — N11), THEN delete the LlmHook
  // CR; host-context-controller garbage-collects the shared pod once the last
  // referencing hook is gone.
  router.delete(
    `${LLMHOOK_PATTERN}/:name`,
    asyncHandler(async (req, res) => {
      const { plural, ns } = resolveResource(req.params.resource)!
      const unlinkedHosts = await stripHookRefFromHosts(
        gateway,
        req.params.name,
        config.hostsNamespace
      )
      const deleted = await gateway.deleteResource(plural, req.params.name, ns)
      res.status(200).json({ ...(deleted as object), unlinkedHosts })
    })
  )

  return router
}
