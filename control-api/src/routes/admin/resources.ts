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
import { getModelAllowlistState, isModelAllowed } from '../../services/llmAllowedModels.js'
import { K8sConflictError } from '../../services/resourceService.js'
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
import { enumerateHostModelReferences } from './hostModelReferences.js'
import { validateHostSecretRef } from './hostSecrets.js'
import { type HostSpecValidationDeps, validateHostSpec } from './hostSpecValidation.js'
import {
  type HostSpecIncoherenceToleratedEvent,
  emitHostSpecIncoherenceTolerated,
} from './hostWriteGateAudit.js'
import type { StaleModelWarning } from './staleModelWarning.js'

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
          await rollbackPrunedCommunicationChannelCreate(gateway, body.metadata.name, ns)
          sendPrunedProviderSettingError(res, missingField)
          return
        }
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
        // Read the stored CR so the write gate can tolerate a pre-existing
        // model_not_allowed incoherence this write does not worsen (Pieza D — the
        // editability trap). If the stored CR cannot be read, tolerance is skipped
        // (fail-closed: the gate behaves exactly as before this feature). Read
        // before the lock: it feeds tolerance, not the availability race, and the
        // K8s resourceVersion precondition guards CR-level concurrency.
        let storedHostSpec: Record<string, unknown> | undefined
        try {
          const existing = (await gateway.getResource(plural, req.params.name, ns)) as {
            spec?: Record<string, unknown>
          } | null
          storedHostSpec =
            existing?.spec && typeof existing.spec === 'object' ? existing.spec : undefined
        } catch {
          storedHostSpec = undefined
        }
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
        const updated = await gateway.updateResource(plural, req.params.name, updateBody, ns)
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
              resourceVersionFromResource(updated)
            )
            sendPrunedProviderSettingError(res, missingField)
            return
          }
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
