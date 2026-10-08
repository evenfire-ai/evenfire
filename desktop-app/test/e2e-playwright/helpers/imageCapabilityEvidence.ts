// desktop-app/test/e2e-playwright/helpers/imageCapabilityEvidence.ts
//
// E2E_GUARDIAN_IPC_FLOW: Desktop chat, the model catalog and the agent list all
// travel over Electron IPC, so this module has no renderer request to await. It
// exists to read the OTHER end of the journey: the external provider boundary.
//
// Scope. This module owns three things and nothing else:
//
//   1. the environment contract of the fixture lane (the runner owns the values);
//   2. a read-only, shell-free ledger read of the derived fixture that answers
//      the external provider origin;
//   3. integrity checks that make that ledger usable as an oracle.
//
// It never mutates cluster state, never calls a product API, and never mocks an
// IPC, RPC, database, host or renderer boundary. The read runs a fixed `cat` in
// a fixed deployment through an argument vector (no shell), so no environment
// value can ever become a shell token.
//
// Why the ledger is trustworthy evidence: the derived fixture answers exactly
// one origin (the ZAI OpenAI chat-completions endpoint) and refuses every other
// external origin, so a ledger row proves a real provider call happened, and
// `imageSha256` is the digest of the exact PNG bytes that reached the wire.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

/** The runner-owned opt-in that selects the derived-provider fixture lane. */
export const IMAGE_CAPABILITIES_RUN_ID_PATTERN = /^image-capabilities-[a-f0-9]{12}$/

/**
 * The two model ids the derived fixture answers for. The fixture refuses every
 * other model on the wire, so a mismatch here would produce a refused provider
 * call instead of a usable oracle; the lane fails loud before that can happen.
 */
export const IMAGE_CAPABILITY_FIXTURE_MODELS = {
  supported: 'glm-5.3-flash',
  unsupported: 'glm-5.3',
} as const

/** Where the derived fixture publishes its provider-boundary ledger. */
export const IMAGE_CAPABILITY_EVIDENCE = {
  namespace: 'mcp-host',
  deployment: 'chatllm',
  path: '/tmp/image-capabilities-evidence.json',
} as const

/**
 * Response kinds the fixture records. Declared here rather than imported from
 * the fixture so the oracle stays independent of the producer: if the fixture
 * changes what it emits, this lane must fail, not silently follow.
 */
export const FIXTURE_RESPONSE_KIND = {
  tileColors: 'tile-colors',
  textOnly: 'text-only',
  rejected: 'rejected',
  // Issue #678: the two provider turns of an attachment read. The first asks for
  // the `clerum__attachment_read` tool; the second answers from the text the tool
  // delivered.
  documentReadRequested: 'document-read-requested',
  documentAnswer: 'document-answer',
  // Issue #1022: the legacy processing-lease restart journey. shell_exec first,
  // then clerum__gfs_download, then an answer built from the download receipt;
  // a failed step is answered with the store code it reported.
  legacyLeaseShellRequested: 'legacy-lease-shell-requested',
  legacyLeaseDownloadRequested: 'legacy-lease-download-requested',
  legacyLeaseAnswer: 'legacy-lease-answer',
  legacyLeaseShellFailed: 'legacy-lease-shell-failed',
  legacyLeaseDownloadFailed: 'legacy-lease-download-failed',
} as const

/**
 * Reasons a rejected row may carry: fixed strings, never request content.
 * Declared independently of the fixture for the same reason as the response
 * kinds; `test/imageCapabilityEvidence.test.ts` checks the two lists agree.
 */
export const FIXTURE_REJECTION_REASONS: readonly string[] = Object.freeze([
  'provider-request-form-unsupported',
  'provider-path-not-captured',
  'provider-method-unsupported',
  'provider-auth-mismatch',
  'provider-body-unsupported',
  'provider-body-invalid',
  'unsupported-model',
  'text-model-image-incompatible',
  'image-not-png-data-uri',
  'image-part-count',
  'image-png-malformed',
  'image-png-unsupported-form',
  'image-tile-grid-mismatch',
  'image-pixel-not-a-tile-color',
  'document-byte-length-malformed',
  'document-tool-result-count',
  'document-tool-output-malformed',
  'document-tool-output-unreadable',
  'document-page-range-malformed',
  'document-stream-unsupported',
  'legacy-lease-shell-not-offered',
  'legacy-lease-download-not-offered',
  'legacy-lease-tool-result-unexpected',
  'legacy-lease-tool-result-count',
  'legacy-lease-download-result-malformed',
  'legacy-lease-stream-unsupported',
])

/**
 * Store failure codes a legacy-lease failure row may carry (the
 * `GfsDownloadStoreError` codes plus `unrecognized`). Declared independently of
 * the fixture; `test/imageCapabilityEvidence.test.ts` checks the lists agree.
 */
export const FIXTURE_LEGACY_LEASE_FAILURE_CODES: readonly string[] = Object.freeze([
  'caller_mismatch',
  'caller_quota_exceeded',
  'corrupt_store_ledger',
  'download_expired',
  'download_missing',
  'download_busy',
  'host_quota_exceeded',
  'publication_cancelled',
  'storage_write_failed',
  'unsupported_store_schema',
  'workspace_unavailable',
  'writer_locked',
  'unrecognized',
])

/** The fixture's text-only answer. It names no image and no color. */
export const FIXTURE_TEXT_ONLY_CONTENT = 'IMAGE_FIXTURE_TEXT_OK'

/**
 * Prefix of the fixture's document answer. The answer is this prefix plus the
 * first {@link FIXTURE_DOCUMENT_ANSWER_DIGEST_CHARS} hex characters of the
 * sha256 of the text the Host delivered to the model, so it cannot be produced
 * from the prompt alone.
 */
export const FIXTURE_DOCUMENT_ANSWER_PREFIX = 'DOCUMENT_FIXTURE_SHA256:'
export const FIXTURE_DOCUMENT_ANSWER_DIGEST_CHARS = 16

const SHA256_HEX = /^[a-f0-9]{64}$/
const MINIKUBE_PROFILE_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

/** Bounded read: the command must never hang a verification run. */
const KUBECTL_TIMEOUT_MS = 20_000
const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024

export type ImageCapabilitiesMode = 'fixture' | 'real'

/**
 * Selects the lane from the environment alone.
 *
 * An unset run id means the caller is running the real-provider smoke journey.
 * A malformed run id is never treated as "unset": that would silently downgrade
 * a fixture run into a paid one.
 */
export function resolveImageCapabilitiesMode(
  env: NodeJS.ProcessEnv = process.env
): ImageCapabilitiesMode {
  const runId = (env.IMAGE_CAPABILITIES_RUN_ID ?? '').trim()
  if (!runId) return 'real'
  if (!IMAGE_CAPABILITIES_RUN_ID_PATTERN.test(runId)) {
    throw new Error(
      `IMAGE_CAPABILITIES_RUN_ID="${runId}" is not a fixture run id: expected ` +
        'image-capabilities-<12 hex>. Unset it to run the real-provider smoke journey.'
    )
  }
  return 'fixture'
}

function configured(value: string | undefined): string {
  return (value ?? '').trim()
}

/** Every binding the fixture lane needs, after validation. */
export interface ImageCapabilitiesFixtureEnv {
  runId: string
  profile: string
  hostRef: string
  externalRestApiBaseUrl: string
  rpcProxyBaseUrl: string
  supportedModel: string
  unsupportedModel: string
  unknownModel: string
}

function requireLoopbackTarget(label: string, rawUrl: string): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error(`${label} must be an absolute URL; received "${rawUrl}".`)
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(
      `${label} targets a non-loopback host "${url.hostname}"; this lane runs only against the ` +
        'branch-owned local stack.'
    )
  }
  return url
}

/**
 * Resolves and validates the fixture lane's environment. Every problem is
 * collected and reported together, because a half-configured run must fail at
 * the gate rather than after an Electron launch.
 *
 * Deliberate strictness, each with a reason:
 *   - the run id selects the lane and is matched against the pod's own ledger;
 *   - the minikube profile must equal the real-PostgreSQL context, which is the
 *     binding the fixture container itself validates;
 *   - the host ref must be the deployment whose ledger is read, or the journey
 *     would talk to a different pod than the oracle;
 *   - both base URLs must be loopback, and the remote escape hatch is refused
 *     outright: this lane's oracle is a pod on this cluster;
 *   - the login identity is required instead of falling back to the shared
 *     defaults, so the journey can never run as a different user than the one
 *     the runner seeded;
 *   - the two wire models must be exactly the ids the fixture answers.
 */
export function requireImageCapabilitiesFixtureEnv(
  env: NodeJS.ProcessEnv = process.env
): ImageCapabilitiesFixtureEnv {
  const problems: string[] = []

  const runId = configured(env.IMAGE_CAPABILITIES_RUN_ID)
  if (!IMAGE_CAPABILITIES_RUN_ID_PATTERN.test(runId)) {
    problems.push(
      `IMAGE_CAPABILITIES_RUN_ID must match image-capabilities-<12 hex> (received "${runId || '<unset>'}")`
    )
  }

  const profile = configured(env.MINIKUBE_PROFILE)
  const context = configured(env.CONTROL_API_REAL_PG_CONTEXT)
  if (!MINIKUBE_PROFILE_PATTERN.test(profile)) {
    problems.push(
      `MINIKUBE_PROFILE must be a valid profile name (received "${profile || '<unset>'}")`
    )
  }
  if (profile !== context) {
    problems.push(
      `MINIKUBE_PROFILE must equal CONTROL_API_REAL_PG_CONTEXT ` +
        `(received "${profile || '<unset>'}" vs "${context || '<unset>'}")`
    )
  }

  const hostRef = configured(env.E2E_HOST_REF)
  if (hostRef !== IMAGE_CAPABILITY_EVIDENCE.deployment) {
    problems.push(
      `E2E_HOST_REF must be "${IMAGE_CAPABILITY_EVIDENCE.deployment}" so the journey and the ` +
        `fixture ledger describe the same pod (received "${hostRef || '<unset>'}")`
    )
  }

  if (configured(env.QA_RECORDER_ALLOW_REMOTE) === '1') {
    problems.push('QA_RECORDER_ALLOW_REMOTE=1 is not available for this lane (loopback only)')
  }

  const externalRestApiBaseUrl = configured(env.EXTERNAL_REST_API_BASE_URL)
  const rpcProxyBaseUrl = configured(env.RPC_PROXY_BASE_URL)
  for (const [label, rawUrl] of [
    ['EXTERNAL_REST_API_BASE_URL', externalRestApiBaseUrl],
    ['RPC_PROXY_BASE_URL', rpcProxyBaseUrl],
  ] as const) {
    if (!rawUrl) {
      problems.push(`${label} is required`)
      continue
    }
    try {
      requireLoopbackTarget(label, rawUrl)
    } catch (error) {
      problems.push((error as Error).message)
    }
  }

  const email = configured(env.E2E_DEV_LOGIN_EMAIL)
  if (!email) problems.push('E2E_DEV_LOGIN_EMAIL is required')

  const desktopSecret = configured(env.E2E_DESKTOP_PASSWORD)
  if (!desktopSecret) problems.push('E2E_DESKTOP_PASSWORD is required')

  const supportedModel = configured(env.QA_RECORDER_IMAGE_MODEL_SUPPORTED)
  const unsupportedModel = configured(env.QA_RECORDER_IMAGE_MODEL_UNSUPPORTED)
  const unknownModel = configured(env.QA_RECORDER_IMAGE_MODEL_UNKNOWN)
  if (supportedModel !== IMAGE_CAPABILITY_FIXTURE_MODELS.supported) {
    problems.push(
      `QA_RECORDER_IMAGE_MODEL_SUPPORTED must be the fixture's image model ` +
        `"${IMAGE_CAPABILITY_FIXTURE_MODELS.supported}" (received "${supportedModel || '<unset>'}")`
    )
  }
  if (unsupportedModel !== IMAGE_CAPABILITY_FIXTURE_MODELS.unsupported) {
    problems.push(
      `QA_RECORDER_IMAGE_MODEL_UNSUPPORTED must be the fixture's text model ` +
        `"${IMAGE_CAPABILITY_FIXTURE_MODELS.unsupported}" (received "${unsupportedModel || '<unset>'}")`
    )
  }
  if (!unknownModel) {
    problems.push('QA_RECORDER_IMAGE_MODEL_UNKNOWN is required (the model with no image evidence)')
  }
  const modelIds = [supportedModel, unsupportedModel, unknownModel].filter(Boolean)
  if (new Set(modelIds).size !== modelIds.length) {
    problems.push('the three QA_RECORDER_IMAGE_MODEL_* ids must be distinct')
  }

  if (problems.length > 0) {
    throw new Error(
      'image-capabilities fixture lane is not configured:\n' +
        problems.map(problem => `  - ${problem}`).join('\n') +
        '\nThe runner that starts this lane must export these exact bindings; this lane never ' +
        'reads .env.qa-recorder or the repository .env.'
    )
  }

  return {
    runId,
    profile,
    hostRef,
    externalRestApiBaseUrl,
    rpcProxyBaseUrl,
    supportedModel,
    unsupportedModel,
    unknownModel,
  }
}

/** One provider-boundary attempt, exactly as the derived fixture records it. */
export interface FixtureProviderAttempt {
  /** Model id, or null when the request was refused before its body was parsed. */
  model: string | null
  /** Digest of the exact PNG bytes that reached the wire, or null when none did. */
  imageSha256: string | null
  responseKind: string
  /**
   * Digest of the document text that reached the wire in a tool-result message.
   * The fixture omits the field on image rows, so it is `undefined` there and
   * `null` on the read-request row, which carries no document yet.
   */
  documentSha256?: string | null
  /**
   * Byte length the Host listed for the attached file (`attached_file … bytes=`).
   * Present only on the read-request row.
   */
  documentByteLength?: number
  /**
   * The page of the file the Host's read tool delivered. Present only on the
   * answer row, so the oracle can hash exactly that slice of the file.
   */
  byteRange?: { offset: number; length: number }
  /** Whether the Host delivered less than the whole file. Answer row only. */
  truncated?: boolean
  /** One of {@link FIXTURE_REJECTION_REASONS}. Present only on rejected rows. */
  reason?: string
  /** One of {@link FIXTURE_LEGACY_LEASE_FAILURE_CODES}. Legacy-lease failure rows only. */
  failureCode?: string
  /** sha256 the download receipt reported. Legacy-lease answer row only. */
  downloadSha256?: string
  /** Byte count the download receipt reported. Legacy-lease answer row only. */
  downloadBytes?: number
}

export interface FixtureEvidenceCounters {
  totalAttempts: number
  imageAttempts: number
  textAttempts: number
  rejectedAttempts: number
  tileColorResponses: number
  textOnlyResponses: number
  textModelImageRefusals: number
  blockedEgress: number
  documentReadRequests: number
  documentAnswers: number
  documentFailures: number
  legacyLeaseShellRequests: number
  legacyLeaseDownloadRequests: number
  legacyLeaseAnswers: number
  legacyLeaseFailures: number
}

export interface ImageCapabilityEvidenceSnapshot {
  runId: string
  profile: string
  pid: number
  counters: FixtureEvidenceCounters
  attempts: FixtureProviderAttempt[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const COUNTER_KEYS: readonly (keyof FixtureEvidenceCounters)[] = [
  'totalAttempts',
  'imageAttempts',
  'textAttempts',
  'rejectedAttempts',
  'tileColorResponses',
  'textOnlyResponses',
  'textModelImageRefusals',
  'blockedEgress',
  'documentReadRequests',
  'documentAnswers',
  'documentFailures',
  'legacyLeaseShellRequests',
  'legacyLeaseDownloadRequests',
  'legacyLeaseAnswers',
  'legacyLeaseFailures',
]

function requireCounters(value: unknown, source: string): FixtureEvidenceCounters {
  if (!isRecord(value)) throw new Error(`${source}: counters must be an object`)
  const counters = {} as FixtureEvidenceCounters
  for (const key of COUNTER_KEYS) {
    const raw = value[key]
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
      throw new Error(
        `${source}: counters.${key} must be a non-negative integer (received ${JSON.stringify(raw)})`
      )
    }
    counters[key] = raw
  }
  return counters
}

const KNOWN_RESPONSE_KINDS: readonly string[] = Object.values(FIXTURE_RESPONSE_KIND)

function requireAttemptRow(value: unknown, index: number, source: string): FixtureProviderAttempt {
  if (!isRecord(value)) throw new Error(`${source}: attempts[${index}] must be an object`)

  const model = value.model
  if (model !== null && typeof model !== 'string') {
    throw new Error(`${source}: attempts[${index}].model must be a string or null`)
  }

  const imageSha256 = value.imageSha256
  if (imageSha256 !== null && !(typeof imageSha256 === 'string' && SHA256_HEX.test(imageSha256))) {
    throw new Error(`${source}: attempts[${index}].imageSha256 must be a sha256 hex digest or null`)
  }

  const responseKind = value.responseKind
  if (typeof responseKind !== 'string' || !KNOWN_RESPONSE_KINDS.includes(responseKind)) {
    throw new Error(
      `${source}: attempts[${index}].responseKind must be one of ${KNOWN_RESPONSE_KINDS.join(', ')} ` +
        `(received ${JSON.stringify(responseKind)})`
    )
  }

  const row: FixtureProviderAttempt = { model, imageSha256, responseKind }

  // Present on every rejected row and on no other row.
  if (responseKind === FIXTURE_RESPONSE_KIND.rejected) {
    const reason = value.reason
    if (typeof reason !== 'string' || !FIXTURE_REJECTION_REASONS.includes(reason)) {
      throw new Error(
        `${source}: attempts[${index}].reason must be one of ${FIXTURE_REJECTION_REASONS.join(', ')} ` +
          `on a ${FIXTURE_RESPONSE_KIND.rejected} row`
      )
    }
    row.reason = reason
  } else if ('reason' in value) {
    throw new Error(
      `${source}: attempts[${index}].reason is only valid on a ${FIXTURE_RESPONSE_KIND.rejected} row`
    )
  }

  // Present on every answer row and on no other row.
  if (responseKind === FIXTURE_RESPONSE_KIND.documentAnswer) {
    const byteRange = value.byteRange
    if (!isRecord(byteRange) || !isByteCount(byteRange.offset) || !isByteCount(byteRange.length)) {
      throw new Error(
        `${source}: attempts[${index}].byteRange must be { offset, length } of non-negative ` +
          `integers on a ${FIXTURE_RESPONSE_KIND.documentAnswer} row`
      )
    }
    if (typeof value.truncated !== 'boolean') {
      throw new Error(
        `${source}: attempts[${index}].truncated must be a boolean on a ` +
          `${FIXTURE_RESPONSE_KIND.documentAnswer} row`
      )
    }
    row.byteRange = { offset: byteRange.offset, length: byteRange.length }
    row.truncated = value.truncated
  } else if ('byteRange' in value || 'truncated' in value) {
    throw new Error(
      `${source}: attempts[${index}].byteRange and truncated are only valid on a ` +
        `${FIXTURE_RESPONSE_KIND.documentAnswer} row`
    )
  }

  // failureCode is present on every legacy-lease failure row and on no other row.
  const legacyFailure =
    responseKind === FIXTURE_RESPONSE_KIND.legacyLeaseShellFailed ||
    responseKind === FIXTURE_RESPONSE_KIND.legacyLeaseDownloadFailed
  if (legacyFailure) {
    const failureCode = value.failureCode
    if (
      typeof failureCode !== 'string' ||
      !FIXTURE_LEGACY_LEASE_FAILURE_CODES.includes(failureCode)
    ) {
      throw new Error(
        `${source}: attempts[${index}].failureCode must be one of ` +
          `${FIXTURE_LEGACY_LEASE_FAILURE_CODES.join(', ')} on a ${responseKind} row`
      )
    }
    row.failureCode = failureCode
  } else if ('failureCode' in value) {
    throw new Error(
      `${source}: attempts[${index}].failureCode is only valid on a legacy-lease failure row`
    )
  }

  // downloadSha256 and downloadBytes are present on every legacy-lease answer row only.
  if (responseKind === FIXTURE_RESPONSE_KIND.legacyLeaseAnswer) {
    const downloadSha256 = value.downloadSha256
    const downloadBytes = value.downloadBytes
    if (typeof downloadSha256 !== 'string' || !SHA256_HEX.test(downloadSha256)) {
      throw new Error(
        `${source}: attempts[${index}].downloadSha256 must be a sha256 hex digest on a ` +
          `${FIXTURE_RESPONSE_KIND.legacyLeaseAnswer} row`
      )
    }
    if (!isByteCount(downloadBytes)) {
      throw new Error(
        `${source}: attempts[${index}].downloadBytes must be a non-negative integer on a ` +
          `${FIXTURE_RESPONSE_KIND.legacyLeaseAnswer} row`
      )
    }
    row.downloadSha256 = downloadSha256
    row.downloadBytes = downloadBytes
  } else if ('downloadSha256' in value || 'downloadBytes' in value) {
    throw new Error(
      `${source}: attempts[${index}].downloadSha256 and downloadBytes are only valid on a ` +
        `${FIXTURE_RESPONSE_KIND.legacyLeaseAnswer} row`
    )
  }

  // Present only on document rows; an image row must not grow the field.
  if ('documentSha256' in value) {
    const documentSha256 = value.documentSha256
    if (
      documentSha256 !== null &&
      !(typeof documentSha256 === 'string' && SHA256_HEX.test(documentSha256))
    ) {
      throw new Error(
        `${source}: attempts[${index}].documentSha256 must be a sha256 hex digest or null`
      )
    }
    row.documentSha256 = documentSha256
    // Present only on the read-request row.
    if ('documentByteLength' in value) {
      const documentByteLength = value.documentByteLength
      if (
        responseKind !== FIXTURE_RESPONSE_KIND.documentReadRequested ||
        typeof documentByteLength !== 'number' ||
        !Number.isSafeInteger(documentByteLength) ||
        documentByteLength <= 0
      ) {
        throw new Error(
          `${source}: attempts[${index}].documentByteLength must be a positive integer on a ` +
            `${FIXTURE_RESPONSE_KIND.documentReadRequested} row`
        )
      }
      row.documentByteLength = documentByteLength
    }
    return row
  }
  if ('documentByteLength' in value) {
    throw new Error(
      `${source}: attempts[${index}].documentByteLength is only valid on a document row`
    )
  }

  return row
}

function isByteCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Parses and validates the ledger; fixture fields this lane does not use are ignored. */
export function parseEvidenceSnapshot(
  rawText: string,
  source: string,
  expected: { runId: string; profile: string }
): ImageCapabilityEvidenceSnapshot {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawText)
  } catch (error) {
    throw new Error(`${source}: evidence is not valid JSON (${(error as Error).message})`)
  }
  if (!isRecord(parsed)) throw new Error(`${source}: evidence must be a JSON object`)

  const runId = parsed.runId
  if (typeof runId !== 'string' || !runId) {
    throw new Error(`${source}: runId must be a non-empty string`)
  }
  if (runId !== expected.runId) {
    throw new Error(
      `${source}: the pod ledger belongs to run "${runId}" but this lane is configured for ` +
        `"${expected.runId}"; refusing to use another run's evidence.`
    )
  }

  const profile = parsed.profile
  if (typeof profile !== 'string' || !profile) {
    throw new Error(`${source}: profile must be a non-empty string`)
  }
  if (profile !== expected.profile) {
    throw new Error(
      `${source}: the pod ledger was written under profile "${profile}" but this lane runs ` +
        `"${expected.profile}".`
    )
  }

  const pid = parsed.pid
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    throw new Error(`${source}: pid must be a positive integer`)
  }

  const counters = requireCounters(parsed.counters, source)

  const attemptsRaw = parsed.attempts
  if (!Array.isArray(attemptsRaw)) {
    throw new Error(
      `${source}: attempts must be an array. The derived fixture publishes one row per ` +
        'provider-boundary attempt under "attempts".'
    )
  }
  const attempts = attemptsRaw.map((row, index) => requireAttemptRow(row, index, source))

  if (attempts.length !== counters.totalAttempts) {
    throw new Error(
      `${source}: attempts.length (${attempts.length}) must equal counters.totalAttempts ` +
        `(${counters.totalAttempts}); the ledger is not internally consistent.`
    )
  }

  return { runId, profile, pid, counters, attempts }
}

function describeExecFailure(error: unknown): string {
  const stderr = isRecord(error) && typeof error.stderr === 'string' ? error.stderr.trim() : ''
  const message = error instanceof Error ? error.message : String(error)
  return stderr ? `${message}\n${stderr}` : message
}

/**
 * Reads the derived fixture's provider-boundary ledger, read-only.
 *
 * The namespace, deployment and path are fixed constants, the context is the
 * validated profile, and the call is bounded by a request timeout, so this can
 * neither reach another cluster nor hang a verification run. Arguments are
 * passed as a vector, never through a shell.
 */
export function readImageCapabilityEvidence(target: {
  runId: string
  profile: string
}): ImageCapabilityEvidenceSnapshot {
  const args = [
    '--context',
    target.profile,
    '--request-timeout=20s',
    '-n',
    IMAGE_CAPABILITY_EVIDENCE.namespace,
    'exec',
    `deploy/${IMAGE_CAPABILITY_EVIDENCE.deployment}`,
    '--',
    'cat',
    IMAGE_CAPABILITY_EVIDENCE.path,
  ]
  const command = `kubectl ${args.join(' ')}`

  let stdout: string
  try {
    stdout = execFileSync('kubectl', args, {
      encoding: 'utf8',
      timeout: KUBECTL_TIMEOUT_MS,
      maxBuffer: MAX_EVIDENCE_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    throw new Error(
      `[image-capabilities] read-only evidence read failed: ${command}\n${describeExecFailure(error)}`
    )
  }

  return parseEvidenceSnapshot(stdout, command, target)
}

/**
 * Returns the rows appended between two reads of the same fixture process.
 *
 * Both invariants matter: the ledger must only ever grow, and the process id
 * must be unchanged. A pod restart between the two reads would otherwise let a
 * stale row satisfy the oracle.
 */
export function appendedAttempts(
  before: ImageCapabilityEvidenceSnapshot,
  after: ImageCapabilityEvidenceSnapshot
): FixtureProviderAttempt[] {
  if (after.pid !== before.pid) {
    throw new Error(
      `[image-capabilities] the fixture process changed between reads (${before.pid} -> ` +
        `${after.pid}); the ledger cannot be correlated across a restart.`
    )
  }
  if (after.attempts.length < before.attempts.length) {
    throw new Error(
      `[image-capabilities] the ledger shrank between reads (${before.attempts.length} -> ` +
        `${after.attempts.length}); it must only ever grow.`
    )
  }
  for (const [index, row] of before.attempts.entries()) {
    const current = after.attempts[index]
    if (
      !current ||
      current.model !== row.model ||
      current.imageSha256 !== row.imageSha256 ||
      current.responseKind !== row.responseKind ||
      current.documentSha256 !== row.documentSha256 ||
      current.documentByteLength !== row.documentByteLength ||
      current.reason !== row.reason ||
      current.byteRange?.offset !== row.byteRange?.offset ||
      current.byteRange?.length !== row.byteRange?.length ||
      current.truncated !== row.truncated ||
      current.failureCode !== row.failureCode ||
      current.downloadSha256 !== row.downloadSha256 ||
      current.downloadBytes !== row.downloadBytes
    ) {
      throw new Error(
        `[image-capabilities] ledger row ${index} changed between reads; the ledger must be append-only.`
      )
    }
  }
  return after.attempts.slice(before.attempts.length)
}

/** Lowercase sha256 of the exact bytes a caller handed to the composer. */
export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}
