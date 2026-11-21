/**
 * Issue #666 — structured file references on an incoming message.
 *
 * `parseIncomingFileReferences` is the route-level contract check: shape,
 * count, uniqueness and GFS identity, with no I/O. `resolveFileReferences`
 * re-authorizes every GFS reference under the Host principal with gfsc
 * `resolve` (JSON metadata only, never bytes) and reports one availability per
 * reference. The model reads an available file later with `clerum__gfs_read`,
 * which the Host pins to the reference's version.
 *
 * Location references (a folder the turn is about) follow the same two steps:
 * `parseIncomingLocationReferences` at the route, and `resolveMessageReferences`
 * resolves them together with the file references under the same deadline.
 */
import {
  type FileReferenceV1,
  type LocationReferenceV1,
  parseFileReferenceV1,
  parseLocationReferenceV1,
  resourceNameProblem,
} from '@clerum/gfs-interaction-policy'
import { FileReferenceErrorCode } from '../core/errors'
import type { TurnContextReferencedFile } from '../core/orchestration/turnContext'
import { GfscHttpError } from '../internalTools/gfsClient'
import { GFS_FILE_LIMITS } from '../internalTools/gfsFilePolicy'
import { logger } from '../logger'
import { VISUAL_INPUT_LIMITS } from '../visualInput/policy'
import {
  type GfsSurfaceRuntimeCapability,
  classifyGfsReferenceSurfaces,
} from './gfsReferenceSurfaces'

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
  /** Delivery surfaces proven for this Host/runtime; absent on old resolutions. */
  surfaces?: ReturnType<typeof classifyGfsReferenceSurfaces>
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

export type LocationReferenceAvailability =
  | 'available'
  | 'not_found'
  | 'denied'
  | 'not_a_folder'
  | 'unsupported'

export interface LocationReferenceResolution {
  availability: LocationReferenceAvailability
  reference: LocationReferenceV1
  /**
   * The name the model sees: gfsc's current name when it reports a valid one
   * (the folder may have been renamed or moved since Desktop took the
   * reference), otherwise the name Desktop sent.
   */
  name: string
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

export type ParsedIncomingLocationReferences =
  | { ok: true; references: LocationReferenceV1[] }
  | Extract<ParsedIncomingFileReferences, { ok: false }>

/** `undefined` is a message without locations; anything else must be a list. */
export function parseIncomingLocationReferences(
  value: unknown,
  maxCount: number
): ParsedIncomingLocationReferences {
  if (value === undefined) return { ok: true, references: [] }
  const invalid = (message: string): ParsedIncomingLocationReferences => ({
    ok: false,
    code: FileReferenceErrorCode.Invalid,
    message,
  })
  if (!Array.isArray(value)) return invalid('locationReferences must be a list.')
  if (value.length > maxCount)
    return invalid(
      `A message can reference at most ${maxCount} folder${maxCount === 1 ? '' : 's'}.`
    )
  const references: LocationReferenceV1[] = []
  const folders = new Set<string>()
  for (const entry of value) {
    const parsed = parseLocationReferenceV1(entry)
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
    // Keyed by gfsUri, which carries the normalized rid: a dashed and an
    // undashed resourceId name the same folder under different ids.
    if (folders.has(parsed.value.source.gfsUri))
      return invalid('Each location reference must appear once.')
    folders.add(parsed.value.source.gfsUri)
    references.push(parsed.value)
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

export interface FileReferenceCheckFailureResult {
  ok: false
  failure: FileReferenceCheckFailure
  errorClass: FileReferenceCheckErrorClass
  /** The gfsc HTTP status, when gfsc answered. */
  status?: number
}

export type FileReferenceResolutionResult =
  | { ok: true; resolutions: FileReferenceResolution[] }
  | FileReferenceCheckFailureResult

export type MessageReferenceResolutionResult =
  | {
      ok: true
      resolutions: FileReferenceResolution[]
      locationResolutions: LocationReferenceResolution[]
    }
  | FileReferenceCheckFailureResult

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
    // fetch reports every transport or URL failure as a TypeError carrying the
    // underlying failure as its cause: a Node system error with a code, or a
    // port/address/URL failure that carries only a message ("bad port",
    // ERR_INVALID_URL). With redirect:'error' it reports a 3xx as a cause
    // saying "unexpected redirect". A TypeError without an Error cause is a
    // Host defect and falls through to the rethrow below.
    if (error instanceof TypeError) {
      const cause = (error as { cause?: unknown }).cause
      if (cause instanceof Error) {
        if (cause.message === 'unexpected redirect')
          return new ResolutionFailure('contract', 'TypeError')
        return new ResolutionFailure('transient', 'TypeError')
      }
    }
  }
  throw error
}

interface ResolvedView {
  kind: 'file' | 'directory'
  version: number
  bytes: number
}

type GfsIdentity = Pick<LocationReferenceV1['source'], 'drive' | 'resourceId' | 'gfsUri'>

/**
 * The resolve body's data, once it is proven to describe the resource the
 * reference names, as a file or a directory.
 */
function resolvedIdentity(
  body: unknown,
  source: GfsIdentity
): Record<string, unknown> & { kind: 'file' | 'directory' } {
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
    (data.kind !== 'file' && data.kind !== 'directory')
  )
    throw new ResolutionFailure('contract', 'UnexpectedMetadata')
  return data as Record<string, unknown> & { kind: 'file' | 'directory' }
}

function resolvedView(body: unknown, source: GfsIdentity): ResolvedView {
  const data = resolvedIdentity(body, source)
  if (
    !Number.isSafeInteger(data.version) ||
    (data.version as number) < 0 ||
    !Number.isSafeInteger(data.bytes) ||
    (data.bytes as number) < 0
  )
    throw new ResolutionFailure('contract', 'UnexpectedMetadata')
  return { kind: data.kind, version: data.version as number, bytes: data.bytes as number }
}

/** Calls gfsc `resolve`; a 403/404/410 is an availability, 400 an invalid reference. */
async function resolveGfs(
  gfsUri: string,
  client: FileReferenceGfscClient,
  call: { signal: AbortSignal; deadlineMs: number }
): Promise<{ body: unknown } | { availability: 'denied' | 'not_found' }> {
  try {
    return { body: await client.resolve({ uri: gfsUri }, call) }
  } catch (error) {
    if (error instanceof GfscHttpError) {
      // gfsc checks the grant before the lookup, so a missing resource usually
      // answers 403 too; 404/410 only reach a principal that could read it.
      if (error.status === 403) return { availability: 'denied' }
      if (error.status === 404 || error.status === 410) return { availability: 'not_found' }
      if (error.status === 400) throw new ResolutionFailure('invalid', 'GfscHttpError', 400)
    }
    throw checkFailure(error)
  }
}

async function resolveOne(
  reference: FileReferenceV1,
  client: FileReferenceGfscClient | null,
  call: { signal: AbortSignal; deadlineMs: number },
  runtimeSurfaces: GfsSurfaceRuntimeCapability
): Promise<FileReferenceResolution> {
  const source = reference.source
  if (source.kind !== 'gfs' || !client) return { availability: 'unsupported', reference }
  const answer = await resolveGfs(source.gfsUri, client, call)
  if ('availability' in answer) return { availability: answer.availability, reference }
  const view = resolvedView(answer.body, source)
  if (view.kind === 'directory') return { availability: 'not_a_file', reference }
  if (view.version !== source.version)
    return { availability: 'stale', reference, resolvedVersion: view.version }
  // Same version, so the same bytes: a different size is a reference that
  // misstates the file, not a change to it.
  if (view.bytes !== reference.byteLength) throw new ResolutionFailure('invalid', 'SizeMismatch')
  if (view.bytes > GFS_FILE_LIMITS.maxFileBytes) return { availability: 'too_large', reference }
  return {
    availability: 'available',
    reference,
    surfaces: classifyGfsReferenceSurfaces(reference, runtimeSurfaces),
  }
}

async function resolveLocationOne(
  reference: LocationReferenceV1,
  client: FileReferenceGfscClient | null,
  call: { signal: AbortSignal; deadlineMs: number }
): Promise<LocationReferenceResolution> {
  const fallback = { reference, name: reference.name }
  if (!client) return { availability: 'unsupported', ...fallback }
  const answer = await resolveGfs(reference.source.gfsUri, client, call)
  if ('availability' in answer) return { availability: answer.availability, ...fallback }
  // A folder has no version or size the reference pins, so only its identity
  // and kind are checked.
  const data = resolvedIdentity(answer.body, reference.source)
  const name =
    typeof data.name === 'string' && resourceNameProblem(data.name) === null
      ? data.name
      : reference.name
  return {
    availability: data.kind === 'directory' ? 'available' : 'not_a_folder',
    reference,
    name,
  }
}

/**
 * Resolves every file and location reference in parallel under one deadline.
 * The first failure, from either list, aborts the calls still in flight.
 */
export async function resolveMessageReferences(
  references: readonly FileReferenceV1[],
  locations: readonly LocationReferenceV1[],
  client: FileReferenceGfscClient | null,
  timeoutMs: number = VISUAL_INPUT_LIMITS.validationTimeoutMs,
  runtimeSurfaces: GfsSurfaceRuntimeCapability = {
    workspaceFile: false,
    localExecutor: false,
    visual: false,
  }
): Promise<MessageReferenceResolutionResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const call = { signal: controller.signal, deadlineMs: Date.now() + timeoutMs }
  try {
    const [resolutions, locationResolutions] = await Promise.all([
      Promise.all(
        references.map(reference => resolveOne(reference, client, call, runtimeSurfaces))
      ),
      Promise.all(locations.map(location => resolveLocationOne(location, client, call))),
    ])
    return { ok: true, resolutions, locationResolutions }
  } catch (error) {
    if (error instanceof ResolutionFailure)
      return {
        ok: false,
        failure: error.failure,
        errorClass: error.errorClass,
        ...(error.status === undefined ? {} : { status: error.status }),
      }
    // R4-M3 — undici puts the header value or a credentialed URL in the message
    // of a causeless TypeError, and the message route answers error.message
    // verbatim. Wrap the rethrow so only this fixed text can leave the Host;
    // the cause keeps the original error for a caller that inspects it. The
    // route logs the wrapper through the Host logger, whose serializer keeps only
    // name, code and status of an Error and does not follow `cause`, so the
    // original class would be lost. Log the original here instead: the same
    // serializer reduces it to name, code and status and drops its message.
    logger.error({ err: error }, '[FileReferences] unexpected error while resolving references')
    throw new Error('file reference resolution failed: unexpected Host error', { cause: error })
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

/** {@link resolveMessageReferences} for a message that carries no locations. */
export async function resolveFileReferences(
  references: readonly FileReferenceV1[],
  client: FileReferenceGfscClient | null,
  timeoutMs?: number,
  runtimeSurfaces?: GfsSurfaceRuntimeCapability
): Promise<FileReferenceResolutionResult> {
  const result = await resolveMessageReferences(references, [], client, timeoutMs, runtimeSurfaces)
  return result.ok ? { ok: true, resolutions: result.resolutions } : result
}
