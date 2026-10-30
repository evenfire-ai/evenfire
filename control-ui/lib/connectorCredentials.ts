import {
  CLOCK_SKEW_TOLERANCE_MS,
  CREDENTIAL_FORBIDDEN_ENV,
  MCP_SECRET_NAME_PATTERN,
} from '@constants/connectorCredentials'
import {
  createMcpSecret,
  deleteMcpSecret,
  getMcpSecretRollbackRepairIdentity,
  getMcpServer,
  listMcpSecrets,
  updateMcpSecret,
  updateMcpServer,
} from '@lib/api'
import type { McpServerResource, SecretIdentity } from '@lib/api'
import type { McpSecretSummary } from '@lib/oauthInstall.types'
import type {
  AttachCredentialRow,
  AttachCredentialsRequest,
  AttachMode,
  AttachPayload,
  AttachValidation,
  AttachValidationOptions,
  AttachedCredentials,
  ChangeCredentialReferenceRequest,
} from './connectorCredentials.types'

/** Structural eligibility, independent of potentially stale status conditions. */
export function credentialAttachUnavailable(server: McpServerResource): string | undefined {
  const spec = server.spec
  if (!spec) return 'Connector settings are unavailable. Refresh before attaching credentials.'
  if (Object.hasOwn(spec, 'envSecret'))
    return 'This connector already has a Secret reference. Refresh to edit its credentials.'
  if (Object.hasOwn(spec, 'oauth'))
    return 'OAuth credentials must be managed through the OAuth configuration.'
  if (spec.managed === false)
    return "This connector's credentials are managed by its WorkflowRecipe. Add the Secret through the recipe's secrets."
  if (spec.enabled === false)
    return 'Enable this connector before attaching credentials and restarting it.'
  return undefined
}

/** A reference change is separate from rotating values in a shared Secret. */
export function credentialReferenceChangeUnavailable(
  server: McpServerResource
): string | undefined {
  const raw = server.spec?.envSecret as { name?: unknown; keys?: unknown } | undefined
  if (
    !raw ||
    typeof raw.name !== 'string' ||
    raw.name !== raw.name.trim() ||
    !MCP_SECRET_NAME_PATTERN.test(raw.name) ||
    !Array.isArray(raw.keys) ||
    !raw.keys.length ||
    raw.keys.some(
      key => !key || typeof key.secretKey !== 'string' || typeof key.envVar !== 'string'
    )
  )
    return 'The connector has no valid Secret reference to change.'
  const { envSecret: _reference, ...spec } = server.spec!
  return credentialAttachUnavailable({ ...server, spec })
}

/** Refresh metadata only. Never read, create, rotate, or delete credential values. */
export async function verifyExistingCredentialSelection(
  secretName: string,
  rows: AttachCredentialRow[],
  selected: McpSecretSummary | undefined,
  server: McpServerResource
): Promise<void> {
  const { items } = await listMcpSecrets()
  const current = items.find(item => item.name === secretName)
  if (!selected || !current || (selected.uid && selected.uid !== current.uid)) {
    throw new CredentialAttachError(
      'This Secret no longer exists or was replaced. Refresh and select it again.',
      true
    )
  }
  if (rows.some(row => row.value !== '' || !current.keys.includes(row.secretKey.trim()))) {
    throw new CredentialAttachError(
      'A selected key is no longer available. Refresh and select its replacement.',
      true
    )
  }
  const invalid = validateCredentialAttach('use-existing', secretName, rows, server, current, {
    storedKeysOnly: true,
  })
  if (invalid) throw new CredentialAttachError(invalid.message)
}

/** Replace only envSecret, with explicit snapshot and API concurrency checks. */
export async function changeConnectorSecretReference({
  serverName,
  server,
  selection,
}: ChangeCredentialReferenceRequest): Promise<AttachedCredentials> {
  const initial = await getMcpServer(serverName)
  if (
    !server.metadata?.uid ||
    initial.metadata?.uid !== server.metadata.uid ||
    !initial.metadata?.resourceVersion ||
    credentialReferenceChangeUnavailable(initial) ||
    !sameCredentialSpec(server.spec, initial.spec)
  )
    throw new CredentialAttachError(
      'The connector changed. Refresh before changing its assigned Secret.',
      true
    )
  const secretName = selection.secret?.name ?? ''
  if (!selection.ready)
    throw new CredentialAttachError('Wait for the Secret list to finish loading.')
  await verifyExistingCredentialSelection(secretName, selection.rows, selection.secret, initial)
  const { reference } = buildAttachPayload(secretName, selection.rows)
  if (sameCredentialSpec(initial.spec?.envSecret, reference)) {
    throw new CredentialAttachError('Choose a different Secret or change its key mappings.')
  }
  const latest = await getMcpServer(serverName)
  if (
    latest.metadata?.uid !== initial.metadata.uid ||
    !latest.metadata?.resourceVersion ||
    credentialReferenceChangeUnavailable(latest) ||
    !sameCredentialSpec(initial.spec, latest.spec)
  )
    throw new CredentialAttachError(
      'The connector changed. Refresh before changing its assigned Secret.',
      true
    )
  const spec = { ...latest.spec, envSecret: reference }
  const cutoff = new Date(Date.now() - CLOCK_SKEW_TOLERANCE_MS).toISOString()
  let saved: McpServerResource
  try {
    saved = await updateMcpServer(serverName, {
      metadata: { uid: latest.metadata.uid, resourceVersion: latest.metadata.resourceVersion },
      spec,
    })
  } catch (error) {
    if (definiteRejection(error)) {
      throw new CredentialAttachError(
        'The assignment was rejected. Refresh and review the connector before retrying.',
        true
      )
    }
    try {
      saved = await getMcpServer(serverName)
    } catch {
      throw new CredentialAttachError(
        'The assignment outcome could not be confirmed. Refresh to check the connector.',
        true
      )
    }
    if (saved.metadata?.uid !== initial.metadata.uid || !sameCredentialSpec(saved.spec, spec)) {
      throw new CredentialAttachError(
        'The assignment outcome could not be confirmed. Refresh to check the connector.',
        true
      )
    }
  }
  return { server: saved, cutoff, affectedConnectors: [] }
}

export function suggestedCredentialEnvVar(key: string): string {
  const name = key.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : ''
}

/** Mirrors the rotate route's key rule (control-api `invalidSecretDataKeyReason`):
 *  Kubernetes Secret key names, up to 253 chars, never `.` or a `..` prefix.
 *  Shared by attach validation and the add-key editor so the two cannot drift. */
export function invalidSecretKeyNameReason(key: string): string | undefined {
  const trimmed = key.trim()
  if (!trimmed) return 'Enter a Secret key name.'
  if (
    !/^[-._a-zA-Z0-9]+$/.test(trimmed) ||
    trimmed.length > 253 ||
    trimmed === '.' ||
    trimmed.startsWith('..')
  ) {
    return 'Enter a valid Secret key (letters, numbers, -, _, or .; not . or a .. prefix; up to 253 characters).'
  }
  return undefined
}

export function validateCredentialAttach(
  mode: AttachMode,
  secretName: string,
  rows: AttachCredentialRow[],
  server: McpServerResource,
  selected?: McpSecretSummary,
  options?: AttachValidationOptions
): AttachValidation | undefined {
  if (!MCP_SECRET_NAME_PATTERN.test(secretName.trim()) || secretName.trim().length > 253) {
    return {
      message:
        'Enter a Secret name with lowercase letters, numbers, or hyphens, up to 253 characters.',
      field: 'secret',
    }
  }
  if (mode === 'use-existing' && (!selected || selected.name !== secretName.trim())) {
    return { message: 'Select an existing Secret.', field: 'secret' }
  }
  if (!rows.length) return { message: 'Add at least one key mapping.' }
  const destinations = new Set<string>()
  const values = new Map<string, string>()
  const plainEnv = Array.isArray(server.spec?.env) ? server.spec.env : []
  const mapping = server.spec?.envMapping
  const reserved = new Set([
    ...plainEnv.map(item => (item as { name?: string })?.name),
    ...(mapping && typeof mapping === 'object' ? Object.values(mapping) : []),
  ])
  for (const row of rows) {
    const key = row.secretKey.trim()
    const env = row.envVar.trim()
    if (options?.storedKeysOnly) {
      // Reference-only reuse: keys must already exist in the selected Secret
      // and values are never accepted. A missing or stale key is a key
      // selection problem, never a request to re-enter a credential value.
      if (!key) {
        return { message: 'Choose a stored key from the selected Secret.', field: `${row.id}-key` }
      }
      if (!selected || !selected.keys.includes(key)) {
        return {
          message: `"${key}" is not stored in the selected Secret. Refresh the Secret list and choose a stored key.`,
          field: `${row.id}-key`,
        }
      }
      if (row.value !== '') {
        return {
          message: 'Stored keys never take a value here. Values stay unchanged in the Secret.',
          field: `${row.id}-value`,
        }
      }
    }
    const keyProblem = invalidSecretKeyNameReason(key)
    if (keyProblem) {
      return { message: keyProblem, field: `${row.id}-key` }
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(env) || CREDENTIAL_FORBIDDEN_ENV.has(env.toUpperCase())) {
      return {
        message:
          'Enter a valid environment variable name that does not control the container runtime.',
        field: `${row.id}-env`,
      }
    }
    if (destinations.has(env) || reserved.has(env)) {
      return {
        message: `Environment variable "${env}" is already mapped. Choose another name.`,
        field: `${row.id}-env`,
      }
    }
    destinations.add(env)
    if ((mode === 'create-new' || !selected?.keys.includes(key)) && !row.value.trim()) {
      return { message: `Enter a credential value for "${key}".`, field: `${row.id}-value` }
    }
    if (row.value !== '') {
      if (values.has(key) && values.get(key) !== row.value) {
        return {
          message: `Enter the same value for each mapping of "${key}".`,
          field: `${row.id}-value`,
        }
      }
      values.set(key, row.value)
    }
  }
}

export function buildAttachPayload(secretName: string, rows: AttachCredentialRow[]): AttachPayload {
  const data = Object.create(null) as Record<string, string>
  for (const row of rows) if (row.value !== '') data[row.secretKey.trim()] = row.value
  return {
    data,
    reference: {
      name: secretName.trim(),
      keys: rows.map(row => ({ secretKey: row.secretKey.trim(), envVar: row.envVar.trim() })),
    },
  }
}

/** Order-independent comparison for API JSON snapshots, including prototype-like keys. */
export function sameCredentialSpec(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object')
    return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const a = Object.keys(left)
  const b = Object.keys(right)
  return (
    a.length === b.length &&
    a.every(key => Object.hasOwn(right, key) && sameCredentialSpec(left[key], right[key]))
  )
}

export class CredentialAttachError extends Error {
  constructor(
    message: string,
    readonly refreshRequired = false,
    readonly collision = false
  ) {
    super(message)
  }
}

function httpStatus(error: unknown): number | undefined {
  return error instanceof Error ? (error as Error & { status?: number }).status : undefined
}

function definiteRejection(error: unknown): boolean {
  const status = httpStatus(error)
  return status >= 400 && status < 500 && status !== 408
}

async function cleanupCreatedSecret(name: string, identity: SecretIdentity): Promise<string> {
  try {
    await deleteMcpSecret(name, { uid: identity.uid, resourceVersion: identity.resourceVersion })
    return ''
  } catch (error) {
    if (httpStatus(error) === 404) return ''
    return ` Cleanup of the created Secret "${name}" could not be confirmed. Refresh and review its references before taking further action.`
  }
}

/** Values are never included in returned results or errors. No create→overwrite fallback. */
export async function attachConnectorCredentials(
  request: AttachCredentialsRequest
): Promise<AttachedCredentials> {
  const { serverName, mode, rows, selectedSecret, onSecretWritten } = request
  const secretName = request.secretName.trim()
  const initial = await getMcpServer(serverName)
  if (request.expectedUid && initial.metadata?.uid !== request.expectedUid) {
    throw new CredentialAttachError(
      'The connector was replaced. Refresh before attaching credentials.',
      true
    )
  }
  const unavailable = credentialAttachUnavailable(initial)
  if (unavailable) throw new CredentialAttachError(unavailable, true)
  if (!initial.metadata?.uid || !initial.metadata?.resourceVersion) {
    throw new CredentialAttachError(
      'Connector identity is unavailable. Refresh before attaching.',
      true
    )
  }
  let selected = selectedSecret
  if (mode === 'use-existing') {
    const { items } = await listMcpSecrets()
    selected = items.find(item => item.name === secretName)
    if (!selected || (selectedSecret?.uid && selected.uid !== selectedSecret.uid)) {
      throw new CredentialAttachError(
        'This Secret no longer exists or was replaced. Refresh and select it again.',
        true
      )
    }
  }
  const invalid = validateCredentialAttach(mode, secretName, rows, initial, selected)
  if (invalid) throw new CredentialAttachError(invalid.message)
  const { reference, data } = buildAttachPayload(secretName, rows)
  let createdIdentity: SecretIdentity | undefined
  let patched = false
  let affectedConnectors: string[] = []

  if (mode === 'create-new') {
    try {
      const created = await createMcpSecret(secretName, data)
      onSecretWritten()
      if (!created.uid || !created.resourceVersion) {
        throw new CredentialAttachError(
          `Secret "${secretName}" was created without a complete identity. Refresh and review it before retrying.`,
          true
        )
      }
      createdIdentity = { uid: created.uid, resourceVersion: created.resourceVersion }
    } catch (error) {
      if (error instanceof CredentialAttachError) throw error
      const repair = getMcpSecretRollbackRepairIdentity(error, secretName)
      if (repair) {
        onSecretWritten()
        const cleanup = await cleanupCreatedSecret(secretName, repair)
        throw new CredentialAttachError(
          `Secret "${secretName}" was created but its creation could not be completed.${cleanup || ' The unused Secret was removed.'}`,
          Boolean(cleanup)
        )
      }
      if (httpStatus(error) === 409) {
        throw new CredentialAttachError(
          `Secret "${secretName}" already exists. Choose "Use an existing Secret" to attach it without overwriting credentials.`,
          false,
          true
        )
      }
      throw new CredentialAttachError(
        definiteRejection(error)
          ? 'The Secret could not be created. Review its name and keys before retrying.'
          : `Creation of Secret "${secretName}" could not be confirmed. Refresh and review it before retrying; no overwrite or unfenced cleanup was attempted.`,
        !definiteRejection(error)
      )
    }
  } else if (Object.keys(data).length) {
    try {
      const result = await updateMcpSecret(secretName, data)
      patched = true
      affectedConnectors = result.affectedConnectors
      onSecretWritten()
    } catch (error) {
      throw new CredentialAttachError(
        httpStatus(error) === 404
          ? 'This Secret no longer exists. Refresh and select it again.'
          : 'The Secret update could not be confirmed. Refresh and review it before retrying.',
        true
      )
    }
  }

  // Until PUT is attempted, no connector reference can have been written by us.
  let latest: McpServerResource
  try {
    latest = await getMcpServer(serverName)
    if (
      latest.metadata?.uid !== initial.metadata.uid ||
      credentialAttachUnavailable(latest) ||
      !sameCredentialSpec(initial.spec, latest.spec)
    ) {
      throw new CredentialAttachError(
        'The connector changed while credentials were being prepared. Refresh before continuing.',
        true
      )
    }
    if (!latest.metadata?.resourceVersion)
      throw new CredentialAttachError(
        'Connector identity is unavailable. Refresh before continuing.',
        true
      )
  } catch {
    const cleanup = createdIdentity ? await cleanupCreatedSecret(secretName, createdIdentity) : ''
    throw new CredentialAttachError(
      `${patched ? 'Secret values were updated, but ' : ''}the connector could not be attached because its current settings could not be verified. Refresh before continuing.${cleanup}`,
      true
    )
  }
  const nextSpec = { ...latest.spec, envSecret: reference }
  const cutoff = new Date(Date.now() - CLOCK_SKEW_TOLERANCE_MS).toISOString()
  let saved: McpServerResource
  try {
    saved = await updateMcpServer(serverName, {
      metadata: { uid: latest.metadata.uid, resourceVersion: latest.metadata.resourceVersion },
      spec: nextSpec,
    })
  } catch (error) {
    if (definiteRejection(error)) {
      const cleanup = createdIdentity ? await cleanupCreatedSecret(secretName, createdIdentity) : ''
      throw new CredentialAttachError(
        `${patched ? 'Secret values were updated, but the connector could not be attached.' : 'The connector could not be attached.'} ${httpStatus(error) === 409 ? 'Its settings changed; refresh before continuing.' : 'The spec save was rejected; refresh and review its settings.'}${cleanup}`,
        true
      )
    }
    // A failed response is not proof the PUT failed. Keep the Secret unless the
    // write was definitely rejected, even if a read currently sees the old spec.
    try {
      saved = await getMcpServer(serverName)
    } catch {
      throw new CredentialAttachError(
        'The attachment outcome could not be confirmed. Refresh to check the connector. The Secret was retained.',
        true
      )
    }
    if (saved.metadata?.uid !== initial.metadata.uid || !sameCredentialSpec(saved.spec, nextSpec)) {
      throw new CredentialAttachError(
        'The attachment outcome could not be confirmed. Refresh to check the connector. The Secret was retained.',
        true
      )
    }
  }
  return { server: saved, cutoff, affectedConnectors }
}
