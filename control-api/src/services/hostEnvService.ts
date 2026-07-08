import * as k8s from '@kubernetes/client-node'

/**
 * Per-Host operator-managed env var management.
 *
 * Two K8s resources per Host:
 *   - ConfigMap `host-<hostRef>-env`         (non-secret values)
 *   - Secret    `host-<hostRef>-env-secret`  (secret values)
 *
 * Resources are created on demand at first write and persist after
 * delete-all. mcp-host ConfigStore watches both via the Kubernetes API
 * and merges them into the runtime env keyspace, so writes here propagate
 * to running pods within ~1 second without restart.
 */

export const RESERVED_PROVIDER_KEYS: ReadonlySet<string> = new Set([
  'OPENAI_API_KEY',
  'CLAUDE_API_KEY',
  'ZAI_API_KEY',
  'BAILIAN_API_KEY',
])

const MAX_KEYS_PER_HOST = 100
const MAX_KEY_NAME_LENGTH = 256
const MAX_NON_SECRET_VALUE_BYTES = 8 * 1024
const MAX_SECRET_VALUE_BYTES = 16 * 1024
const MAX_PAYLOAD_BYTES = 128 * 1024
const KEY_NAME_RE = /^[A-Z][A-Z0-9_]*$/

const SCOPE_LABEL = 'clerum.io/scope'
const HOST_LABEL = 'clerum.io/host'
const MANAGED_BY_LABEL = 'clerum.io/managed-by'

export interface HostEnvEntry {
  key: string
  secret: boolean
  updatedAt?: string
}

export interface HostEnvWriteEntry {
  key: string
  value: string
  secret: boolean
}

export interface HostEnvWriteResult {
  keys: HostEnvEntry[]
  /** Plaintext echo for newly-created/updated secrets in this PUT only. */
  showOnce: Record<string, string>
}

export class HostEnvServiceError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly hint?: string
  ) {
    super(message)
    this.name = 'HostEnvServiceError'
  }
}

function badRequest(message: string, hint?: string): never {
  throw new HostEnvServiceError(400, message, hint)
}

function isErrorCode(err: unknown, code: number): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: number; statusCode?: number; response?: { statusCode?: number } }
  return e.code === code || e.statusCode === code || e.response?.statusCode === code
}

function utcNow(): string {
  return new Date().toISOString()
}

function validateKey(name: string): void {
  if (typeof name !== 'string') badRequest('key must be a string')
  if (name.length === 0 || name.length > MAX_KEY_NAME_LENGTH) {
    badRequest(`key length must be 1-${MAX_KEY_NAME_LENGTH}`)
  }
  if (!KEY_NAME_RE.test(name)) {
    badRequest(
      `Invalid key name "${name}". Must match [A-Z][A-Z0-9_]* (uppercase shell-style env var).`
    )
  }
  if (RESERVED_PROVIDER_KEYS.has(name)) {
    badRequest(
      `"${name}" is a reserved LLM provider-key name`,
      'Manage LLM provider keys via the LLM Secrets tab; do not set them through per-Host env.'
    )
  }
  if (name.startsWith('CLERUM_')) {
    badRequest(
      `"${name}" uses the reserved CLERUM_* prefix`,
      'CLERUM_* is reserved for infrastructure variables injected by HCC. Pick a different prefix.'
    )
  }
}

function utf8ByteLength(s: string): number {
  return Buffer.byteLength(s, 'utf-8')
}

function isUtf8(s: string): boolean {
  // String type already guarantees UTF-16 in memory; reject values that
  // contain the U+FFFD replacement char typical of bad transcodes. Plain
  // ASCII / UTF-8 text passes through cleanly.
  return !/�/.test(s)
}

export class HostEnvService {
  constructor(
    private readonly coreApi: k8s.CoreV1Api,
    private readonly namespace: string
  ) {}

  // ─── Naming helpers ───────────────────────────────────────────────

  private cmName(hostRef: string): string {
    return `host-${hostRef}-env`
  }

  private secretName(hostRef: string): string {
    return `host-${hostRef}-env-secret`
  }

  private commonLabels(hostRef: string): Record<string, string> {
    return {
      [MANAGED_BY_LABEL]: 'control-api',
      [SCOPE_LABEL]: 'host-env',
      [HOST_LABEL]: hostRef,
    }
  }

  // ─── Reads ────────────────────────────────────────────────────────

  /**
   * List names + metadata of all per-Host env vars. Never returns values.
   */
  async list(hostRef: string): Promise<HostEnvEntry[]> {
    const [cm, secret] = await Promise.all([
      this.readCm(hostRef),
      this.readSecret(hostRef),
    ])
    const entries: HostEnvEntry[] = []
    const cmTimestamp =
      cm?.metadata?.annotations?.['clerum.io/last-updated'] ||
      (cm?.metadata?.creationTimestamp ? String(cm.metadata.creationTimestamp) : undefined)
    const secretTimestamp =
      secret?.metadata?.annotations?.['clerum.io/last-updated'] ||
      (secret?.metadata?.creationTimestamp
        ? String(secret.metadata.creationTimestamp)
        : undefined)
    for (const k of Object.keys(cm?.data ?? {})) {
      entries.push({ key: k, secret: false, updatedAt: cmTimestamp })
    }
    for (const k of Object.keys(secret?.data ?? {})) {
      entries.push({ key: k, secret: true, updatedAt: secretTimestamp })
    }
    entries.sort((a, b) => a.key.localeCompare(b.key))
    return entries
  }

  // ─── Writes ───────────────────────────────────────────────────────

  /**
   * Upsert: keys not in the body are left alone (use deleteKey to remove).
   * Validates guardrails; rejects reserved/CLERUM_ names; enforces size
   * limits; refuses overlap between CM and Secret for the same Host.
   * Returns showOnce only for secrets created or updated by this call.
   */
  async putMany(hostRef: string, entries: HostEnvWriteEntry[]): Promise<HostEnvWriteResult> {
    if (!Array.isArray(entries) || entries.length === 0) {
      badRequest('Body must be a non-empty array of {key, value, secret}.')
    }

    // Per-entry validation.
    for (const e of entries) {
      if (!e || typeof e !== 'object') badRequest('Each entry must be an object.')
      validateKey(e.key)
      if (typeof e.value !== 'string') badRequest(`value for "${e.key}" must be a string`)
      if (typeof e.secret !== 'boolean') badRequest(`secret for "${e.key}" must be a boolean`)
      if (!isUtf8(e.value)) badRequest(`value for "${e.key}" must be UTF-8 (no binary)`)
      const max = e.secret ? MAX_SECRET_VALUE_BYTES : MAX_NON_SECRET_VALUE_BYTES
      if (utf8ByteLength(e.value) > max) {
        badRequest(`value for "${e.key}" exceeds ${max / 1024} KB`)
      }
    }

    // Reject duplicate keys within the body itself.
    const seen = new Set<string>()
    for (const e of entries) {
      if (seen.has(e.key)) badRequest(`Duplicate key in body: "${e.key}"`)
      seen.add(e.key)
    }

    // Read current state to merge against.
    const [existingCm, existingSecret] = await Promise.all([
      this.readCm(hostRef),
      this.readSecret(hostRef),
    ])
    const cmData: Record<string, string> = { ...(existingCm?.data ?? {}) }
    const secretRaw: Record<string, string> = { ...(existingSecret?.data ?? {}) }
    // existingSecret data is base64; decode for our cross-resource overlap
    // check and re-encode on write below via stringData (server-side).
    const decodedSecret: Record<string, string> = {}
    for (const [k, v] of Object.entries(secretRaw)) {
      decodedSecret[k] = Buffer.from(v, 'base64').toString('utf-8')
    }

    // Apply incoming writes, ensuring no key spans both kinds for the host.
    const showOnce: Record<string, string> = {}
    for (const e of entries) {
      if (e.secret) {
        if (cmData[e.key] !== undefined) {
          badRequest(
            `"${e.key}" already exists as a non-secret. Delete it first or change its kind.`
          )
        }
        decodedSecret[e.key] = e.value
        showOnce[e.key] = e.value
      } else {
        if (decodedSecret[e.key] !== undefined) {
          badRequest(`"${e.key}" already exists as a secret. Delete it first or change its kind.`)
        }
        cmData[e.key] = e.value
      }
    }

    // Aggregate guardrails.
    const totalKeys = Object.keys(cmData).length + Object.keys(decodedSecret).length
    if (totalKeys > MAX_KEYS_PER_HOST) {
      badRequest(`Per-Host env limit is ${MAX_KEYS_PER_HOST} keys; this write would exceed it.`)
    }
    const cmBytes = Object.values(cmData).reduce((acc, v) => acc + utf8ByteLength(v), 0)
    if (cmBytes > MAX_PAYLOAD_BYTES) {
      badRequest(`ConfigMap payload exceeds ${MAX_PAYLOAD_BYTES / 1024} KB`)
    }
    const secretBytes = Object.values(decodedSecret).reduce((acc, v) => acc + utf8ByteLength(v), 0)
    if (secretBytes > MAX_PAYLOAD_BYTES) {
      badRequest(`Secret payload exceeds ${MAX_PAYLOAD_BYTES / 1024} KB`)
    }

    // Persist. ConfigMap stores plaintext under .data. Secret stores values
    // under .stringData (K8s base64-encodes them server-side).
    const now = utcNow()
    await this.upsertCm(hostRef, cmData, now)
    await this.upsertSecret(hostRef, decodedSecret, now)

    const keys = await this.list(hostRef)
    return { keys, showOnce }
  }

  /**
   * Remove a single key from whichever resource holds it. 404 if absent.
   */
  async deleteKey(hostRef: string, key: string): Promise<void> {
    if (typeof key !== 'string' || !key) badRequest('key path param is required')
    const [cm, secret] = await Promise.all([this.readCm(hostRef), this.readSecret(hostRef)])
    const cmData: Record<string, string> = { ...(cm?.data ?? {}) }
    const secretData: Record<string, string> = { ...(secret?.data ?? {}) }
    let removed = false
    if (cmData[key] !== undefined) {
      delete cmData[key]
      removed = true
      await this.upsertCm(hostRef, cmData, utcNow())
    }
    if (secretData[key] !== undefined) {
      const decoded: Record<string, string> = {}
      for (const [k, v] of Object.entries(secretData)) {
        if (k === key) continue
        decoded[k] = Buffer.from(v, 'base64').toString('utf-8')
      }
      removed = true
      await this.upsertSecret(hostRef, decoded, utcNow())
    }
    if (!removed) {
      throw new HostEnvServiceError(404, `Key "${key}" not found on Host "${hostRef}"`)
    }
  }

  // ─── Internal CM/Secret persistence ──────────────────────────────

  private async readCm(hostRef: string): Promise<k8s.V1ConfigMap | null> {
    try {
      return await this.coreApi.readNamespacedConfigMap({
        namespace: this.namespace,
        name: this.cmName(hostRef),
      })
    } catch (err) {
      if (isErrorCode(err, 404)) return null
      throw err
    }
  }

  private async readSecret(hostRef: string): Promise<k8s.V1Secret | null> {
    try {
      return await this.coreApi.readNamespacedSecret({
        namespace: this.namespace,
        name: this.secretName(hostRef),
      })
    } catch (err) {
      if (isErrorCode(err, 404)) return null
      throw err
    }
  }

  private async upsertCm(
    hostRef: string,
    data: Record<string, string>,
    timestamp: string
  ): Promise<void> {
    const name = this.cmName(hostRef)
    const body: k8s.V1ConfigMap = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name,
        namespace: this.namespace,
        labels: this.commonLabels(hostRef),
        annotations: { 'clerum.io/last-updated': timestamp },
      },
      data,
    }
    try {
      await this.coreApi.createNamespacedConfigMap({ namespace: this.namespace, body })
      return
    } catch (err) {
      if (!isErrorCode(err, 409)) throw err
    }
    const existing = await this.coreApi.readNamespacedConfigMap({
      namespace: this.namespace,
      name,
    })
    body.metadata!.resourceVersion = existing.metadata?.resourceVersion
    await this.coreApi.replaceNamespacedConfigMap({ namespace: this.namespace, name, body })
  }

  private async upsertSecret(
    hostRef: string,
    decodedData: Record<string, string>,
    timestamp: string
  ): Promise<void> {
    const name = this.secretName(hostRef)
    const body: k8s.V1Secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name,
        namespace: this.namespace,
        labels: this.commonLabels(hostRef),
        annotations: { 'clerum.io/last-updated': timestamp },
      },
      type: 'Opaque',
      stringData: decodedData,
    }
    try {
      await this.coreApi.createNamespacedSecret({ namespace: this.namespace, body })
      return
    } catch (err) {
      if (!isErrorCode(err, 409)) throw err
    }
    const existing = await this.coreApi.readNamespacedSecret({
      namespace: this.namespace,
      name,
    })
    body.metadata!.resourceVersion = existing.metadata?.resourceVersion
    await this.coreApi.replaceNamespacedSecret({ namespace: this.namespace, name, body })
  }
}
