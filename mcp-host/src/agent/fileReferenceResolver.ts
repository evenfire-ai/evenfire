/**
 * Issue #666 — structured file references on an incoming message.
 *
 * `parseIncomingFileReferences` is the route-level contract check: shape,
 * count, uniqueness and GFS identity, with no I/O. `resolveFileReferences`
 * re-authorizes every GFS reference under the Host principal with gfsc
 * `resolve` (JSON metadata only, never bytes) and reports one availability per
 * reference. The model reads an available file later with `clerum__gfs_read`,
 * which the Host pins to the reference's version.
 */
import { type FileReferenceV1, parseFileReferenceV1 } from '@clerum/gfs-interaction-policy'
import { FileReferenceErrorCode } from '../core/errors'
import type { TurnContextReferencedFile } from '../core/orchestration/turnContext'
import { GfscHttpError } from '../internalTools/gfsClient'
import { VISUAL_INPUT_LIMITS } from '../visualInput/policy'

export type FileReferenceAvailability =
  | 'available'
  | 'not_found'
  | 'denied'
  | 'stale'
  | 'not_a_file'
  | 'too_large'
  | 'unsupported'

export interface FileReferenceResolution {
  availability: FileReferenceAvailability
  reference: FileReferenceV1
  /** The version gfsc reports now, when it differs from the reference's. */
  resolvedVersion?: number
}

/** The code each unavailable reference is reported under (log and turn block). */
export const FILE_REFERENCE_AVAILABILITY_CODES: Record<
  Exclude<FileReferenceAvailability, 'available'>,
  FileReferenceErrorCode
> = {
  not_found: FileReferenceErrorCode.NotFound,
  denied: FileReferenceErrorCode.Denied,
  stale: FileReferenceErrorCode.Stale,
  not_a_file: FileReferenceErrorCode.NotAFile,
  too_large: FileReferenceErrorCode.TooLarge,
  unsupported: FileReferenceErrorCode.Unsupported,
}

/** The `referenced_file` entries for the turn-context block, in message order. */
export function referencedFilesForTurnContext(
  resolutions: readonly FileReferenceResolution[] | undefined
): TurnContextReferencedFile[] {
  return (resolutions ?? []).map(({ availability, reference, resolvedVersion }) => {
    const { source } = reference
    return {
      referenceId: reference.id,
      name: reference.name,
      class: reference.class,
      byteLength: reference.byteLength,
      sourceKind: source.kind,
      ...(source.kind === 'gfs'
        ? { gfs: { drive: source.drive, resourceId: source.resourceId, version: source.version } }
        : {}),
      availability,
      ...(availability === 'available'
        ? {}
        : { code: FILE_REFERENCE_AVAILABILITY_CODES[availability] }),
      ...(resolvedVersion === undefined ? {} : { currentVersion: resolvedVersion }),
    }
  })
}

export type ParsedIncomingFileReferences =
  | { ok: true; references: FileReferenceV1[] }
  | {
      ok: false
      code: FileReferenceErrorCode.SchemaVersionUnsupported | FileReferenceErrorCode.Invalid
      message: string
    }

function normalizeRid(value: string): string | null {
  const normalized = value.replace(/-/g, '').toLowerCase()
  return /^[a-f0-9]{32}$/.test(normalized) ? normalized : null
}

/** `undefined` is a message without references; anything else must be a list. */
export function parseIncomingFileReferences(
  value: unknown,
  maxCount: number
): ParsedIncomingFileReferences {
  if (value === undefined) return { ok: true, references: [] }
  const invalid = (message: string): ParsedIncomingFileReferences => ({
    ok: false,
    code: FileReferenceErrorCode.Invalid,
    message,
  })
  if (!Array.isArray(value)) return invalid('fileReferences must be a list.')
  if (value.length > maxCount) return invalid(`A message can reference at most ${maxCount} files.`)
  const references: FileReferenceV1[] = []
  const ids = new Set<string>()
  const gfsFiles = new Set<string>()
  for (const entry of value) {
    const parsed = parseFileReferenceV1(entry)
    if (!parsed.ok) {
      return {
        ok: false,
        code:
          parsed.code === 'FILE_REFERENCE_SCHEMA_VERSION_UNSUPPORTED'
            ? FileReferenceErrorCode.SchemaVersionUnsupported
            : FileReferenceErrorCode.Invalid,
        message: parsed.message,
      }
    }
    const reference = parsed.value
    // A GFS file is keyed by drive and resource, whatever the version: two
    // references to the same file would leave its read pin ambiguous. The
    // contract guarantees gfsUri is gfs://<drive>/<normalized rid>.
    const key = reference.source.kind === 'gfs' ? reference.source.gfsUri : reference.id
    const seen = reference.source.kind === 'gfs' ? gfsFiles : ids
    if (seen.has(key)) return invalid('Each file reference must appear once.')
    seen.add(key)
    references.push(reference)
  }
  return { ok: true, references }
}

/** The gfsc surface resolution needs: one JSON metadata call. */
export interface FileReferenceGfscClient {
  resolve(
    args: { uri: string },
    call: { signal: AbortSignal; deadlineMs: number }
  ): Promise<unknown>
}

/**
 * Why a check could not produce resolutions.
 * - `transient`: gfsc was unavailable, slow or rate-limited; the client may resend.
 * - `invalid`: gfsc refused the reference as malformed, or it misstates the file's size.
 * - `contract`: gfsc answered with a status or a body the Host does not understand.
 * - `credentials`: the Host's own GFS token is unreadable, undecodable or refused.
 */
export type FileReferenceCheckFailure = 'transient' | 'invalid' | 'contract' | 'credentials'

/** What failed, from a closed set of names; never an error message. */
export type FileReferenceCheckErrorClass =
  | 'GfscHttpError'
  | 'AbortError'
  | 'TimeoutError'
  | 'TypeError'
  | 'SyntaxError'
  | 'TokenReadError'
  | 'TokenDecodeError'
  | 'UnexpectedMetadata'
  | 'SizeMismatch'

export type FileReferenceResolutionResult =
  | { ok: true; resolutions: FileReferenceResolution[] }
  | {
      ok: false
      failure: FileReferenceCheckFailure
      errorClass: FileReferenceCheckErrorClass
      /** The gfsc HTTP status, when gfsc answered. */
      status?: number
    }

class ResolutionFailure extends Error {
  constructor(
    readonly failure: FileReferenceCheckFailure,
    readonly errorClass: FileReferenceCheckErrorClass,
    readonly status?: number
  ) {
    super(`file reference resolution failed: ${failure}`)
    this.name = 'ResolutionFailure'
  }
}

// The error the gfsc client raises for an empty mounted token file.
const EMPTY_TOKEN_FILE_MESSAGE = 'MCP_HOST_GFS_TOKEN_FILE is empty'

function isTokenReadError(error: Error): boolean {
  if (error.message === EMPTY_TOKEN_FILE_MESSAGE) return true
  // A failed read of the mounted token file is a Node system error.
  const { code, syscall } = error as NodeJS.ErrnoException
  return typeof code === 'string' && typeof syscall === 'string'
}

/**
 * Maps a failed gfsc `resolve` call that is not an availability. An error of a
 * class outside this table is rethrown: it is a defect, not a check result.
 * Every gfsc status is classified, because a rethrown GfscHttpError would
 * carry gfsc's response body into the route's 500 answer.
 */
function checkFailure(error: unknown): ResolutionFailure {
  if (error instanceof GfscHttpError) {
    const { status } = error
    if (status === 401) return new ResolutionFailure('credentials', 'GfscHttpError', status)
    if (status === 429 || (status >= 500 && status <= 599))
      return new ResolutionFailure('transient', 'GfscHttpError', status)
    // Any other status, 4xx or the 3xx that redirect:'error' lets through, is
    // one the Host does not understand.
    return new ResolutionFailure('contract', 'GfscHttpError', status)
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError')
      return new ResolutionFailure('transient', error.name)
    if (error instanceof SyntaxError) return new ResolutionFailure('contract', 'SyntaxError')
    if (isTokenReadError(error)) return new ResolutionFailure('credentials', 'TokenReadError')
    // fetch reports a refused, reset or unresolvable connection as a TypeError.
    if (error instanceof TypeError) return new ResolutionFailure('transient', 'TypeError')
  }
  throw error
}

interface ResolvedView {
  kind: 'file' | 'directory'
  version: number
  bytes: number
}

function resolvedView(
  body: unknown,
  source: Extract<FileReferenceV1['source'], { kind: 'gfs' }>
): ResolvedView {
  const envelope = body as { ok?: unknown; data?: unknown } | null
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    envelope.ok !== true ||
    !envelope.data ||
    typeof envelope.data !== 'object'
  )
    throw new ResolutionFailure('contract', 'UnexpectedMetadata')
  const data = envelope.data as Record<string, unknown>
  const rid = normalizeRid(source.resourceId)
  if (
    typeof data.resourceId !== 'string' ||
    normalizeRid(data.resourceId) !== rid ||
    data.rid !== rid ||
    data.drive !== source.drive ||
    data.gfsUri !== source.gfsUri ||
    (data.kind !== 'file' && data.kind !== 'directory') ||
    !Number.isSafeInteger(data.version) ||
    (data.version as number) < 0 ||
    !Number.isSafeInteger(data.bytes) ||
    (data.bytes as number) < 0
  )
    throw new ResolutionFailure('contract', 'UnexpectedMetadata')
  return { kind: data.kind, version: data.version as number, bytes: data.bytes as number }
}

async function resolveOne(
  reference: FileReferenceV1,
  client: FileReferenceGfscClient | null,
  call: { signal: AbortSignal; deadlineMs: number }
): Promise<FileReferenceResolution> {
  const source = reference.source
  if (source.kind !== 'gfs' || !client) return { availability: 'unsupported', reference }
  let body: unknown
  try {
    body = await client.resolve({ uri: source.gfsUri }, call)
  } catch (error) {
    if (error instanceof GfscHttpError) {
      // gfsc checks the grant before the lookup, so a missing resource usually
      // answers 403 too; 404/410 only reach a principal that could read it.
      if (error.status === 403) return { availability: 'denied', reference }
      if (error.status === 404 || error.status === 410)
        return { availability: 'not_found', reference }
      if (error.status === 400) throw new ResolutionFailure('invalid', 'GfscHttpError', 400)
    }
    throw checkFailure(error)
  }
  const view = resolvedView(body, source)
  if (view.kind === 'directory') return { availability: 'not_a_file', reference }
  if (view.version !== source.version)
    return { availability: 'stale', reference, resolvedVersion: view.version }
  // Same version, so the same bytes: a different size is a reference that
  // misstates the file, not a change to it.
  if (view.bytes !== reference.byteLength) throw new ResolutionFailure('invalid', 'SizeMismatch')
  if (view.bytes > VISUAL_INPUT_LIMITS.fileBytes) return { availability: 'too_large', reference }
  return { availability: 'available', reference }
}

/**
 * Resolves every reference in parallel under one deadline. The first failure
 * aborts the calls still in flight.
 */
export async function resolveFileReferences(
  references: readonly FileReferenceV1[],
  client: FileReferenceGfscClient | null,
  timeoutMs: number = VISUAL_INPUT_LIMITS.validationTimeoutMs
): Promise<FileReferenceResolutionResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const call = { signal: controller.signal, deadlineMs: Date.now() + timeoutMs }
  try {
    const resolutions = await Promise.all(
      references.map(reference => resolveOne(reference, client, call))
    )
    return { ok: true, resolutions }
  } catch (error) {
    if (error instanceof ResolutionFailure)
      return {
        ok: false,
        failure: error.failure,
        errorClass: error.errorClass,
        ...(error.status === undefined ? {} : { status: error.status }),
      }
    throw error
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}
