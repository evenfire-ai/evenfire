import { type NextFunction, type Request, type Response, Router } from 'express'
import { config } from '../../config.js'
import {
  type DbClient,
  advisoryLockModelNames,
  boundCarrierTransactionIdleTimeout,
  withTransaction,
} from '../../db.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import { enforceNamespace } from '../../http/namespaceAudit.js'
import { validateCommunicationChannelSpec } from '../../http/validateCommunicationChannelSpec.js'
import { validateMcpServerSpecPreflight } from '../../http/validateMcpServerSpec.js'
import { K8sGateway } from '../../k8s.js'
import { rootLogger } from '../../observability/logger.js'
import { stripHookRefFromHosts } from '../../services/hostGuardrailRefs.js'
import { getModelAllowlistState, isModelAllowed } from '../../services/llmAllowedModels.js'
import {
  K8sConflictError,
  K8sNotFoundError,
  type MutableResourceSnapshot,
} from '../../services/resourceService.js'
import { secretKeyNames } from '../../services/secretKeyNames.js'
import {
  ClerumResourceType,
  type ResourcePreconditions,
  type SecretPreconditions,
} from '../../types.js'
import {
  registerCommunicationChannelCredentialsRoutes,
  validateCommunicationChannelCredentials,
} from './communicationChannelCredentials.js'
import {
  ccCredentialsSecretName,
  extractK8sStatusCode,
  preserveCommunicationChannelCredentialsSecretRef,
} from './communicationChannelSpecHelpers.js'
import { enumerateHostModelReferences } from './hostModelReferences.js'
import { validateHostSecretRef } from './hostSecrets.js'
import { type HostSpecValidationDeps, validateHostSpec } from './hostSpecValidation.js'
import {
  type HostSpecIncoherenceToleratedEvent,
  emitHostSpecIncoherenceTolerated,
} from './hostWriteGateAudit.js'
import { collectResourceSpecFieldIssues, validateResourceName } from './resourceFieldValidation.js'
import type { StaleModelWarning } from './staleModelWarning.js'

export const adminResourcesLogger = rootLogger.child({ module: 'admin-resources' })
const log = adminResourcesLogger

const PROVIDER_SETTINGS_FIELDS: Readonly<Record<string, readonly string[]>> = {
  telegramSettings: ['botHandle', 'replyOnlyWhenMentioned'],
  slackSettings: ['workspaceId', 'botHandle', 'replyOnlyWhenMentioned', 'replyInThreads'],
  teamsSettings: ['appName', 'appId', 'tenantId', 'replyOnlyWhenMentioned'],
}

type CommunicationChannelSpecSnapshot = {
  spec: Record<string, unknown>
  uid?: string
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

function resourcePreconditionsFromResource(resource: unknown): ResourcePreconditions | undefined {
  const metadata = recordValue((resource as { metadata?: unknown } | null)?.metadata)
  const uid = metadata?.uid
  const resourceVersion = metadata?.resourceVersion
  if (typeof uid !== 'string' || !uid || typeof resourceVersion !== 'string' || !resourceVersion) {
    return undefined
  }
  return { uid, resourceVersion }
}

function credentialPreconditionsFromObject(object: unknown): SecretPreconditions | undefined {
  const metadata = recordValue((object as { metadata?: unknown } | null)?.metadata)
  const flat = recordValue(object)
  const uid = typeof flat?.uid === 'string' ? flat.uid : metadata?.uid
  const resourceVersion =
    typeof flat?.resourceVersion === 'string' ? flat.resourceVersion : metadata?.resourceVersion
  if (typeof uid !== 'string' || !uid || typeof resourceVersion !== 'string' || !resourceVersion) {
    return undefined
  }
  return { uid, resourceVersion }
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
  log.warn({ field }, 'CommunicationChannel provider setting was pruned')
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
  credentialsSecretName?: string,
  resourcePreconditions?: ResourcePreconditions,
  credentialPreconditions?: SecretPreconditions
): Promise<void> {
  if (resourcePreconditions) {
    try {
      await gateway.deleteResource('communicationchannels', name, namespace, resourcePreconditions)
    } catch (err) {
      log.warn({ name, err }, 'CommunicationChannel pruned-setting rollback failed')
    }
  } else {
    log.warn({ name }, 'CommunicationChannel pruned-setting rollback skipped: identity unavailable')
  }
  if (!credentialsSecretName) return
  if (credentialPreconditions) {
    try {
      await gateway.deleteSecret(credentialsSecretName, namespace, credentialPreconditions)
    } catch (err) {
      log.warn(
        { secretName: credentialsSecretName, err },
        'CommunicationChannel credentials rollback failed'
      )
    }
  } else {
    log.warn(
      { secretName: credentialsSecretName },
      'CommunicationChannel credentials rollback skipped: identity unavailable'
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
    const identity = resourcePreconditionsFromResource(existing)
    return {
      spec: spec ? { ...spec } : {},
      ...(identity ?? {}),
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
  resourcePreconditions?: ResourcePreconditions
): Promise<void> {
  if (!snapshot) return
  if (!resourcePreconditions?.uid || !resourcePreconditions.resourceVersion) {
    log.warn({ name }, 'CommunicationChannel rollback skipped: identity unavailable')
    return
  }
  try {
    const restored = await gateway.updateResource(
      'communicationchannels',
      name,
      {
        metadata: resourcePreconditions,
        spec: snapshot.spec,
      },
      namespace
    )
    const missingField = missingPersistedProviderSetting(snapshot.spec, restored)
    if (missingField) {
      log.warn({ name, field: missingField }, 'CommunicationChannel rollback did not restore field')
    }
  } catch (err) {
    log.warn({ name, err }, 'CommunicationChannel pruned-setting rollback failed')
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
  log.warn('Context spec.displayName was pruned by the apiserver (CRD outdated)')
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
  namespace: string,
  resourcePreconditions?: ResourcePreconditions
): Promise<void> {
  if (!resourcePreconditions) {
    log.warn({ name }, 'Context pruned-displayName rollback skipped: identity unavailable')
    return
  }
  try {
    await gateway.deleteResource('contexts', name, namespace, resourcePreconditions)
  } catch (err) {
    log.warn({ name, err }, 'Context pruned-displayName rollback failed')
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

// R1-H3 fase 1: a Host write (create/update) validates its model references and
// writes the CR INSIDE a carrier transaction that holds the per-model-name
// advisory lock across the K8s write, so a concurrent llm-model disable/delete
// cannot strand a reference (INV-1). `validateHostSpec` returning an issue must
// abort the whole thing WITHOUT persisting: it throws this so `withTransaction`
// rolls back (releasing the lock) and the caller answers 422 with the issue.
class HostSpecInvalidError extends Error {
  constructor(readonly issue: { errors: Array<{ field: string; message: string }> }) {
    super('host_spec_invalid')
    this.name = 'HostSpecInvalidError'
  }
}

// Every distinct model NAME a Host spec references (primary + allowedModels +
// fallbacks). Reuses the single Host-reference enumeration (regla D4); the raw
// model name is what the advisory lock keys on (adenda A1). Dedup + total order
// are handled by `advisoryLockModelNames`.
function hostModelLockNames(spec: unknown): string[] {
  return enumerateHostModelReferences(spec).map(ref => ref.model)
}

// Bind the Host-spec validation gates to the carrier TRANSACTION client so the
// allowlist reads happen under the advisory lock, on the same connection. BOTH
// `isModelAllowed` (the fail-closed gate) AND `getModelAllowlistState` (the
// stale-warning lookup) are bound — leaving the latter defaulted would let
// `maybeWarnStale` escape to the global pool under the lock (adenda A3).
function hostValidationDeps(db: DbClient): HostSpecValidationDeps {
  return {
    isModelAllowed: (provider, model) => isModelAllowed(provider, model, db),
    getModelAllowlistState: (provider, model) => getModelAllowlistState(provider, model, db),
  }
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
      // Fase 6 soft-quarantine warnings granted during Host validation, returned
      // in the 201 body only after the CR persists (below). Empty for every
      // non-host create.
      const hostWarnings: StaleModelWarning[] = []

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
        let createdCredentialPreconditions: SecretPreconditions | undefined
        const createdCredential = await gateway.createSecret({
          name: secretName,
          namespace: ns,
          type: 'Opaque',
          stringData: credentialValidation.values,
        })
        createdCredentialPreconditions = credentialPreconditionsFromObject(createdCredential)
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
            await rollbackPrunedCommunicationChannelCreate(
              gateway,
              ccName,
              ns,
              secretName,
              resourcePreconditionsFromResource(created),
              createdCredentialPreconditions
            )
            sendPrunedProviderSettingError(res, missingField)
            return
          }
          res.status(201).json(created)
        } catch (err) {
          // Best-effort rollback. 404 from a stale Secret read or a
          // missing-secret race is tolerable — log and bubble the
          // original CRD error up so the caller sees the failure cause.
          if (createdCredentialPreconditions) {
            try {
              await gateway.deleteSecret(secretName, ns, createdCredentialPreconditions)
            } catch (rollbackErr) {
              log.warn(
                { secretName, err: rollbackErr },
                'CommunicationChannel credentials rollback failed'
              )
            }
          } else {
            log.warn(
              { secretName },
              'CommunicationChannel credentials rollback skipped: identity unavailable'
            )
          }
          throw err
        }
        return
      }

      // Host create (R1-H3 fase 1): validate + CREATE the CR INSIDE a carrier
      // transaction that HOLDS the per-model-name advisory lock across the K8s
      // write, so a concurrent llm-model disable/delete cannot strand the new
      // reference (INV-1). The impact gate on the reductor side takes the SAME
      // lock and LISTs Hosts live, so whichever side commits first wins and the
      // loser re-reads under the lock and aborts.
      if (plural === 'hosts' && body.spec) {
        const hostSpec = body.spec
        let created: unknown
        try {
          created = await withTransaction(async db => {
            // Bound idle-in-transaction tenancy first (the lock is held across the
            // live K8s write), then acquire the model-name locks in total order.
            await boundCarrierTransactionIdleTimeout(db)
            await advisoryLockModelNames(db, hostModelLockNames(hostSpec))
            // Create: no stored CR, so the no-worsening tolerance (Pieza D) can
            // never apply — a fresh Host may not introduce a disabled model. The
            // allowlist gates read UNDER the lock (deps bound to `db`).
            const issue = await validateHostSpec(hostSpec, hostValidationDeps(db), {
              hostRef: { namespace: ns, name: body.metadata.name },
              // Fase 6: a fresh Host has no stored CR, so EVERY assignment is new —
              // a stale enabled model warns (never blocks). Emitted after the CR
              // lands (below), so a rejected write surfaces no warning.
              warnings: hostWarnings,
            })
            if (issue) throw new HostSpecInvalidError(issue)
            // Anti-spoofing: an existing secretRef target must be an LLM host
            // Secret. Kept before the write and inside the lock so precedence
            // (spec issue → secretRef issue) is byte-identical to before.
            const secretRefIssue = await validateHostSecretRef(gateway, hostSpec)
            if (secretRefIssue) throw new HostSpecInvalidError(secretRefIssue)
            // K8s write INSIDE the held lock: the COMMIT that releases the lock
            // happens only after the CR is durable.
            return gateway.createResource(plural, body, ns)
          })
        } catch (err) {
          if (err instanceof HostSpecInvalidError) {
            res.status(422).json(err.issue)
            return
          }
          throw err
        }
        res
          .status(201)
          .json(
            hostWarnings.length > 0
              ? { ...(created as Record<string, unknown>), warnings: hostWarnings }
              : created
          )
        return
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
          await rollbackPrunedCommunicationChannelCreate(
            gateway,
            body.metadata.name,
            ns,
            undefined,
            resourcePreconditionsFromResource(created)
          )
          sendPrunedProviderSettingError(res, missingField)
          return
        }
      }
      if (
        plural === 'contexts' &&
        body.spec &&
        contextDisplayNameNotPersisted(body.spec, created)
      ) {
        await rollbackPrunedContextCreate(
          gateway,
          body.metadata.name,
          ns,
          resourcePreconditionsFromResource(created)
        )
        sendPrunedDisplayNameError(res)
        return
      }
      // Host CR persisted: attach any Fase 6 warnings additively (older clients
      // ignore the field). Absent when there is nothing to warn about.
      res
        .status(201)
        .json(
          hostWarnings.length > 0
            ? { ...(created as Record<string, unknown>), warnings: hostWarnings }
            : created
        )
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
      // Pieza D tolerations granted during Host validation, emitted only after
      // the CR persists (below). Empty for every non-host / non-tolerated write.
      const hostTolerations: HostSpecIncoherenceToleratedEvent[] = []
      // Fase 6 soft-quarantine warnings, returned in the 200 body only after the
      // CR persists (below). Empty for every non-host / non-stale write.
      const hostWarnings: StaleModelWarning[] = []

      // N1 — the CR read by the ratchet below is the single pre-write read for
      // hosts + contexts. For CONTEXTS it is handed to updateResource
      // (preReadCurrent, see below) so the PUT reads the apiserver ONCE, not
      // twice. For HOSTS it also feeds the Pieza D tolerance (storedHostSpec,
      // below) — but the host write goes through the carrier transaction, whose
      // updateResource deliberately reads afresh UNDER the advisory lock (INV-1:
      // a pre-lock snapshot would reopen the availability race the lock closes),
      // so preReadCurrent is not used there. Undefined for non hosts/contexts
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

      // Host update (R1-H3 fase 1): validate + REPLACE the CR INSIDE a carrier
      // transaction holding the per-model-name advisory lock across the K8s write,
      // exactly like create. The revalidation under the lock reuses the SAME
      // `validateHostSpec` — which already encapsulates the no-worsening tolerance
      // (Pieza D) — so the tolerance is preserved, not tightened (mini-spec §7).
      if (plural === 'hosts' && body.spec) {
        const hostSpec = body.spec
        // The stored CR lets the write gate tolerate a pre-existing
        // model_not_allowed incoherence this write does not worsen (Pieza D — the
        // editability trap). Reuse the snapshot the ratchet already read above
        // (ratchetCurrent) instead of a second getResource: for hosts the ratchet
        // block always ran (its guard is a superset of this one), so ratchetCurrent
        // is set, or undefined on the 404 path. If it is absent, tolerance is
        // skipped (fail-closed: the gate behaves exactly as before this feature).
        // This snapshot feeds tolerance, not the availability race — the write gate
        // re-reads fresh under the lock — and the K8s resourceVersion precondition
        // guards CR-level concurrency.
        const storedHostSpec: Record<string, unknown> | undefined =
          recordValue(ratchetCurrent?.spec) ?? undefined
        let updated: unknown
        try {
          updated = await withTransaction(async db => {
            await boundCarrierTransactionIdleTimeout(db)
            // Lock the models the INCOMING spec references — a newly added
            // reference is the only one this write can strand.
            await advisoryLockModelNames(db, hostModelLockNames(hostSpec))
            const issue = await validateHostSpec(hostSpec, hostValidationDeps(db), {
              stored: storedHostSpec,
              hostRef: { namespace: ns, name: req.params.name },
              // Sink for tolerations granted by validation; emitted below ONLY
              // after the CR persists (mini-spec 01), so a secretRef 422 or a K8s
              // conflict leaves no audit record.
              tolerations: hostTolerations,
              // Fase 6 warnings: a NEW assignment of an enabled-but-stale model
              // warns (never blocks). A live reference already in the stored CR is
              // not revalidated. Returned in the body only after the CR persists.
              warnings: hostWarnings,
            })
            if (issue) throw new HostSpecInvalidError(issue)
            const secretRefIssue = await validateHostSecretRef(gateway, hostSpec)
            if (secretRefIssue) throw new HostSpecInvalidError(secretRefIssue)
            return gateway.updateResource(plural, req.params.name, body, ns)
          })
        } catch (err) {
          if (err instanceof HostSpecInvalidError) {
            res.status(422).json(err.issue)
            return
          }
          // AP-6: the caller sent the resourceVersion it read and the resource
          // changed underneath it. Machine-readable so the UI can tell the operator
          // to reload — never retried server-side with the stale body.
          if (err instanceof K8sConflictError) {
            res.status(409).json({ error: 'conflict', reason: 'resource_changed' })
            return
          }
          throw err
        }
        // Host CR persisted: NOW emit any Pieza D tolerations (never before the
        // write lands, so a K8s conflict/error leaves no audit record).
        for (const event of hostTolerations) emitHostSpecIncoherenceTolerated(event)
        res
          .status(200)
          .json(
            hostWarnings.length > 0
              ? { ...(updated as Record<string, unknown>), warnings: hostWarnings }
              : updated
          )
        return
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
              ...(previousCommunicationChannelSpec?.uid
                ? { uid: previousCommunicationChannelSpec.uid }
                : {}),
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
        // Host CR persisted: NOW emit any Pieza D tolerations (never before the
        // write lands, so a K8s conflict/error leaves no audit record).
        for (const event of hostTolerations) emitHostSpecIncoherenceTolerated(event)
        if (plural === 'communicationchannels' && body.spec) {
          const missingField = missingPersistedProviderSetting(updateBody.spec, updated)
          if (missingField) {
            await rollbackPrunedCommunicationChannelUpdate(
              gateway,
              req.params.name,
              ns,
              previousCommunicationChannelSpec,
              resourcePreconditionsFromResource(updated)
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
        res
          .status(200)
          .json(
            hostWarnings.length > 0
              ? { ...(updated as Record<string, unknown>), warnings: hostWarnings }
              : updated
          )
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
          log.info(
            { secretName: ccSecretRefName, namespace: ns },
            'Deleted CommunicationChannel credentials Secret'
          )
        } catch (err) {
          if (extractK8sStatusCode(err) === 404) {
            log.info(
              { secretName: ccSecretRefName, namespace: ns },
              'CommunicationChannel credentials Secret already gone'
            )
          } else {
            // CC is already gone; log and swallow so the operator gets a 200
            // and can clean the orphan Secret manually if needed.
            log.error(
              { secretName: ccSecretRefName, namespace: ns, err },
              'CommunicationChannel delete succeeded but credentials cleanup failed'
            )
          }
        }
      }

      if (plural === 'mcpservers') {
        const contextsNs = resourceNamespace('contexts')
        try {
          await gateway.deleteSecret(`${name}-credentials`, ns)
          log.info(
            { secretName: `${name}-credentials`, namespace: ns },
            'Deleted MCP credentials Secret'
          )
        } catch (err) {
          log.info({ serverName: name, err }, 'No MCP credentials Secret to delete')
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
              log.info(
                { serverName: name, contextName: ctxName },
                'Removed MCP server from Context allowlist'
              )
            }
          }
        } catch (err) {
          log.error({ serverName: name, err }, 'Failed to clean up Context allowlists')
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
