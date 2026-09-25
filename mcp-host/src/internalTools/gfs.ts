import type { FileReferenceResolution } from '../agent/fileReferenceResolver'
import { inspectImage, validateImage } from '../visualInput/imageValidation'
import { VisualInputError } from '../visualInput/policy'
import type {
  InternalToolCallContext,
  InternalToolDefinition,
  InternalToolExecutionOptions,
  InternalToolResult,
} from '../workflow/types'
import { GfscHttpError } from './gfsClient'
import { normalizeRid } from './gfsContentRead'
import type { GfsFileContent, GfsReadOptions } from './gfsReadTypes'
import { decodeTextContent } from './textContent'

/**
 * Agent gfs READ tools (spec community.md §Operator surfaces, plan P3-S04).
 * clerum__gfs_list/read/stat/resolve let an agent browse and read the Global
 * File System through gfsc, using its dedicated aud=gfs-controller token. P3 is
 * READ-ONLY — write (clerum__gfs_write) lands in P4. Every result carries the
 * stable `gfsUri` so links survive rename/move.
 */

/**
 * Per-call bounds from the tool call that issues the request. `signal` cancels
 * the request and any 429 retry sleep; `deadlineMs` (epoch ms) is when the
 * calling tool's budget ends, so a retry never sleeps past it.
 */
export interface GfscCallOptions {
  signal?: AbortSignal
  deadlineMs?: number
}

/** The gfsc read surface, injected so the tools are unit-tested without gfsc. */
export interface GfscReadClient {
  accessible(args: { drive: string; cursor?: string }, call?: GfscCallOptions): Promise<unknown>
  list(
    args: { drive: string; resourceId: string; cursor?: string },
    call?: GfscCallOptions
  ): Promise<unknown>
  read(
    args: { drive: string; resourceId: string },
    options?: GfsReadOptions
  ): Promise<GfsFileContent>
  stat(args: { drive: string; resourceId: string }, call?: GfscCallOptions): Promise<unknown>
  resolve(args: { uri: string }, call?: GfscCallOptions): Promise<unknown>
}

/** Turns a tool call's execution context into the client's per-call bounds. */
function callOptions(context?: InternalToolCallContext): GfscCallOptions {
  return {
    signal: context?.signal,
    deadlineMs: context?.timeoutMs === undefined ? undefined : Date.now() + context.timeoutMs,
  }
}

function ok(content: unknown): InternalToolResult {
  return { success: true, content: typeof content === 'string' ? content : JSON.stringify(content) }
}
// Read failures get the same redaction floor as mutations (see mutationFail):
// only gfsc's HTTP status and a coarse public category may reach the model —
// never the response body, which could carry paths or server internals.
function fail(error: unknown): InternalToolResult {
  if (error instanceof VisualInputError) return { success: false, error: error.message }
  return redactedFail('GFS read failed', error)
}

function fileReference(file: GfsFileContent, reason: string): InternalToolResult {
  return ok({
    resource: file.source,
    sizeBytes: file.bytes.byteLength,
    delivery: 'reference_only',
    reason,
  })
}

function isSvgText(text: string): boolean {
  let remaining = text.trimStart()
  // Scan each prefix once; do not use a repeated, backtracking XML regex on
  // untrusted file content. This is format recognition, never XML execution.
  for (;;) {
    const end = remaining.startsWith('<?')
      ? remaining.indexOf('?>', 2)
      : remaining.startsWith('<!--')
        ? remaining.indexOf('-->', 4)
        : -1
    if (end < 0) break
    const suffixLength = remaining.startsWith('<?') ? 2 : 3
    remaining = remaining.slice(end + suffixLength).trimStart()
  }
  return /^<svg[\s>/]/i.test(remaining) || /^<!DOCTYPE\s+svg[\s>]/i.test(remaining)
}
// Locally-authored argument-validation messages carry no server data and must
// reach the model verbatim so the agent can correct its call.
function invalidArgs(message: string): InternalToolResult {
  return { success: false, error: message }
}

const driveResourceParams = {
  type: 'object',
  required: ['drive', 'resourceId'],
  properties: {
    drive: { type: 'string', description: 'gfs drive name (e.g. "main").' },
    resourceId: { type: 'string', description: 'Resource id (32-hex rid).' },
  },
} as const

/**
 * #666 — the version a file reference of the turn's message pins, and the
 * version gfsc reported instead when the reference was stale.
 */
export interface ReferencedFilePin {
  version: number
  currentVersion?: number
}

/** Pins keyed by `${drive}/${rid}`, with the rid normalized as gfsc names it. */
export type ReferencedFilePins = ReadonlyMap<string, ReferencedFilePin>

function referencedFileKey(drive: unknown, resourceId: unknown): string | null {
  const rid = normalizeRid(resourceId)
  return typeof drive === 'string' && rid ? `${drive}/${rid}` : null
}

/** The pins of every GFS reference the message carried, whatever its availability. */
export function referencedFilePins(
  resolutions: readonly FileReferenceResolution[] | undefined
): ReferencedFilePins {
  const pins = new Map<string, ReferencedFilePin>()
  for (const { availability, reference, resolvedVersion } of resolutions ?? []) {
    const source = reference.source
    if (source.kind !== 'gfs') continue
    const key = referencedFileKey(source.drive, source.resourceId)
    if (!key) throw new Error('A resolved GFS file reference must carry a 32-hex resourceId')
    pins.set(key, {
      version: source.version,
      ...(availability === 'stale' && resolvedVersion !== undefined
        ? { currentVersion: resolvedVersion }
        : {}),
    })
  }
  return pins
}

function pinnedVersionMessage(pin: ReferencedFilePin): string {
  const base = `This file is referenced in the current message at version ${pin.version}. Omit expectedVersion or pass ${pin.version}`
  return pin.currentVersion === undefined
    ? `${base}.`
    : `${base}, or pass its current_version ${pin.currentVersion} to read the current file.`
}

/**
 * #666 — stat, resolve and list report the live resource, which can be newer
 * than the version a referenced file is pinned to for clerum__gfs_read.
 */
const LIVE_RESOURCE_NOTE =
  'Reports the live resource; a file referenced in the current message is read at its listed version, or at its current_version once the reference is stale.'

export interface GfsReadToolOptions {
  /** Files the turn's message referenced; an empty map when there is no message. */
  referencedFiles: ReferencedFilePins
}

/** The five read tools, bound to a gfsc client. */
export function buildGfsReadTools(
  client: GfscReadClient,
  { referencedFiles }: GfsReadToolOptions
): InternalToolDefinition[] {
  return [
    {
      name: 'clerum__gfs_accessible',
      description:
        'List GFS resources this agent can access, including effective permissions and stable gfsUri links.',
      parameters: {
        type: 'object',
        required: ['drive'],
        properties: {
          drive: { type: 'string', description: 'gfs drive name (e.g. "main").' },
          cursor: { type: 'string', description: 'Opaque pagination cursor.' },
        },
      },
      execute: async (
        args: Record<string, unknown>,
        _outputDir: string,
        context?: InternalToolCallContext
      ): Promise<InternalToolResult> => {
        try {
          return ok(
            await client.accessible(
              args as { drive: string; cursor?: string },
              callOptions(context)
            )
          )
        } catch (err) {
          return fail(err)
        }
      },
    },
    {
      name: 'clerum__gfs_list',
      description: `List the children of a gfs directory. Returns entries with their gfsUri. ${LIVE_RESOURCE_NOTE}`,
      parameters: {
        type: 'object',
        required: ['drive', 'resourceId'],
        properties: {
          ...driveResourceParams.properties,
          cursor: { type: 'string', description: 'Opaque pagination cursor.' },
        },
      },
      execute: async (
        args: Record<string, unknown>,
        _outputDir: string,
        context?: InternalToolCallContext
      ): Promise<InternalToolResult> => {
        try {
          return ok(
            await client.list(
              args as { drive: string; resourceId: string; cursor?: string },
              callOptions(context)
            )
          )
        } catch (err) {
          return fail(err)
        }
      },
    },
    {
      name: 'clerum__gfs_read',
      description:
        'Read a GFS file by drive + resourceId. Returns UTF-8 text, or a bounded JPEG/PNG image when the active model supports image input. Other binary formats return a reference; malformed or unsupported JPEG/PNG returns an error. ' +
        'The Host reads a referenced_file from the turn context at the version the reference names; pass expectedVersion only to read the current_version of a stale reference. If the file changed since it was referenced, the result has availability "stale" and no content.',
      parameters: {
        ...driveResourceParams,
        properties: {
          ...driveResourceParams.properties,
          expectedVersion: {
            type: 'integer',
            minimum: 0,
            description:
              'Read only this version of the file. For a referenced_file, only its version or, when stale, its current_version is accepted.',
          },
        },
      },
      execute: async (
        args: Record<string, unknown>,
        _outputDir: string,
        options?: InternalToolExecutionOptions
      ): Promise<InternalToolResult> => {
        const { expectedVersion: requestedVersion, ...target } = args
        if (requestedVersion !== undefined && !isValidIfMatch(requestedVersion))
          return invalidArgs('expectedVersion must be a non-negative integer.')
        // #666 — a file the message referenced is read at the referenced
        // version, or at the current version gfsc reported for a stale one.
        const key = referencedFileKey(target.drive, target.resourceId)
        const pin = key === null ? undefined : referencedFiles.get(key)
        let expectedVersion = requestedVersion
        if (pin) {
          if (requestedVersion === undefined) expectedVersion = pin.version
          else if (requestedVersion !== pin.version && requestedVersion !== pin.currentVersion)
            return invalidArgs(pinnedVersionMessage(pin))
        }
        let file: GfsFileContent | undefined
        try {
          file = await client.read(target as { drive: string; resourceId: string }, {
            ...callOptions(options),
            timeoutMs: options?.timeoutMs,
            budget: options?.readBudget ?? options?.visualInput?.budget,
            ...(expectedVersion === undefined ? {} : { expectedVersion }),
          })
          if (options?.signal?.aborted) throw new VisualInputError('cancelled')
          const image = inspectImage(file.bytes)
          if (image) {
            const visualInput = options?.visualInput
            if (!visualInput)
              return fileReference(file, 'image_input_unavailable_in_this_execution')
            const capability = await visualInput.resolveCapability(options?.signal)
            if (options?.signal?.aborted) throw new VisualInputError('cancelled')
            if (capability.status !== 'supported')
              return fileReference(file, `model_image_input_${capability.status}`)
            await validateImage(file.bytes, image, {
              signal: options?.signal,
              budget: visualInput.budget,
            })
            if (options?.signal?.aborted) throw new VisualInputError('cancelled')
            const dataBase64 = visualInput.budget.encodeImage(file.bytes)
            return {
              success: true,
              content: JSON.stringify({
                resource: file.source,
                mimeType: image.mimeType,
                width: image.width,
                height: image.height,
                sizeBytes: file.bytes.byteLength,
                delivery: 'image_input',
              }),
              images: [
                { ...image, source: file.source, sizeBytes: file.bytes.byteLength, dataBase64 },
              ],
            }
          }
          if (/\.(?:png|jpe?g)$/i.test(file.source.name))
            throw new VisualInputError('invalid_image')
          // Same fileBytes cap as images (G0); same text rule as clerum__attachment_read.
          const text = decodeTextContent(file.bytes)
          if (text === null) return fileReference(file, 'unsupported_binary_format')
          if (isSvgText(text)) return fileReference(file, 'svg_visual_input_not_supported')
          return ok(text)
        } catch (err) {
          // #666 — with an expected version, a version conflict is an answer about
          // the reference, not a read failure.
          if (
            expectedVersion !== undefined &&
            err instanceof VisualInputError &&
            err.code === 'version_conflict'
          )
            return ok({
              availability: 'stale',
              drive: target.drive,
              resourceId: target.resourceId,
              expectedVersion,
            })
          return fail(err)
        } finally {
          file?.reservation.release()
        }
      },
    },
    {
      name: 'clerum__gfs_stat',
      description: `Stat a gfs resource (name, kind, version, bytes, gfsUri). ${LIVE_RESOURCE_NOTE}`,
      parameters: driveResourceParams,
      execute: async (
        args: Record<string, unknown>,
        _outputDir: string,
        context?: InternalToolCallContext
      ): Promise<InternalToolResult> => {
        try {
          return ok(
            await client.stat(args as { drive: string; resourceId: string }, callOptions(context))
          )
        } catch (err) {
          return fail(err)
        }
      },
    },
    {
      name: 'clerum__gfs_resolve',
      description: `Resolve a gfs:// URI to its current resource + canonical path. ${LIVE_RESOURCE_NOTE}`,
      parameters: {
        type: 'object',
        required: ['uri'],
        properties: { uri: { type: 'string', description: 'A gfs:// URI.' } },
      },
      execute: async (
        args: Record<string, unknown>,
        _outputDir: string,
        context?: InternalToolCallContext
      ): Promise<InternalToolResult> => {
        try {
          return ok(await client.resolve(args as { uri: string }, callOptions(context)))
        } catch (err) {
          return fail(err)
        }
      },
    },
  ]
}

/** The gfsc write surface (P4) — read + write. */
export interface GfscWriteClient extends GfscReadClient {
  write(
    args: {
      drive: string
      resourceId: string
      content: string
      ifMatch: number
    },
    call?: GfscCallOptions
  ): Promise<unknown>
  createFile(
    args: {
      drive: string
      parentResourceId: string
      name: string
      content: string
    },
    call?: GfscCallOptions
  ): Promise<unknown>
  createFolder(
    args: { drive: string; parentResourceId: string; name: string },
    call?: GfscCallOptions
  ): Promise<unknown>
  rename(
    args: {
      drive: string
      resourceId: string
      newName: string
      ifMatch: number
    },
    call?: GfscCallOptions
  ): Promise<unknown>
  copy(
    args: {
      drive: string
      sourceResourceId: string
      destinationParentId: string
      newName?: string
      ifMatch: number
    },
    call?: GfscCallOptions
  ): Promise<unknown>
}

// Preserve only GFSC's HTTP status and a coarse public category. The server
// keeps the detailed correlated evidence; paths, blob keys, SQL details and
// response bodies must not cross into the model-visible tool result. Keeping
// 403 distinguishable is required for immediate-revocation and isolation
// journeys, while still making every failure safe to display.
function redactedFail(label: string, error: unknown): InternalToolResult {
  const message = error instanceof Error ? error.message : String(error)
  const match = /\bgfsc\s+(\d{3})\b/i.exec(message)
  if (!match) return { success: false, error: label }
  const status = Number(match[1])
  const category =
    status === 400
      ? 'invalid_request'
      : status === 401
        ? 'unauthenticated'
        : status === 403
          ? 'forbidden'
          : status === 404
            ? 'not_found'
            : status === 409
              ? 'conflict'
              : status === 412
                ? 'precondition_failed'
                : status === 413
                  ? 'limit_exceeded'
                  : status === 429
                    ? 'rate_limited'
                    : status >= 500
                      ? 'unavailable'
                      : 'failed'
  // The retry hint comes from the typed error's parsed Retry-After header, an
  // integer, never from the response body.
  const hint =
    error instanceof GfscHttpError && error.status === 429 && error.retryAfterSeconds !== undefined
      ? `, retry after ${error.retryAfterSeconds}s`
      : ''
  return { success: false, error: `${label} (gfsc ${status}: ${category}${hint})` }
}

function mutationFail(error: unknown): InternalToolResult {
  return redactedFail('GFS mutation failed', error)
}

function isValidIfMatch(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

/**
 * Agent gfs WRITE tool (plan P4-S04). clerum__gfs_write replaces a file and
 * REQUIRES If-Match (the resource version) — agent writes are writer-routed
 * conditional writes (P4-S01); the mutation is audited server-side. Destructive
 * bits (delete) stay default-denied for agents.
 */
export function buildGfsWriteTools(client: GfscWriteClient): InternalToolDefinition[] {
  return [
    {
      name: 'clerum__gfs_write',
      description:
        'Conditionally replace the complete content of an existing gfs file. Requires If-Match (the current version).',
      parameters: {
        type: 'object',
        required: ['drive', 'resourceId', 'content', 'ifMatch'],
        properties: {
          drive: { type: 'string', description: 'gfs drive name.' },
          resourceId: { type: 'string', description: 'Resource id (32-hex rid).' },
          content: { type: 'string', description: 'New file content.' },
          ifMatch: { type: 'number', description: 'The resource version being replaced.' },
        },
      },
      execute: async (
        args: Record<string, unknown>,
        _outputDir: string,
        context?: InternalToolCallContext
      ): Promise<InternalToolResult> => {
        if (!isValidIfMatch(args.ifMatch)) {
          return invalidArgs('clerum__gfs_write requires a non-negative safe-integer If-Match')
        }
        try {
          return ok(
            await client.write(
              args as { drive: string; resourceId: string; content: string; ifMatch: number },
              callOptions(context)
            )
          )
        } catch (err) {
          return mutationFail(err)
        }
      },
    },
    {
      name: 'clerum__gfs_create_file',
      description: 'Create one file under an existing gfs folder.',
      parameters: {
        type: 'object',
        required: ['drive', 'parentResourceId', 'name', 'content'],
        properties: {
          drive: { type: 'string', description: 'gfs drive name.' },
          parentResourceId: { type: 'string', description: 'Destination folder resource id.' },
          name: {
            type: 'string',
            description:
              'New file name including its file extension, e.g. "report.txt" or "notes.md". Always match the content format.',
          },
          content: { type: 'string', description: 'Initial file content.' },
        },
      },
      execute: async (
        args: Record<string, unknown>,
        _outputDir: string,
        context?: InternalToolCallContext
      ): Promise<InternalToolResult> => {
        try {
          return ok(
            await client.createFile(
              args as { drive: string; parentResourceId: string; name: string; content: string },
              callOptions(context)
            )
          )
        } catch (err) {
          return mutationFail(err)
        }
      },
    },
    {
      name: 'clerum__gfs_create_folder',
      description: 'Create one folder under an existing gfs folder.',
      parameters: {
        type: 'object',
        required: ['drive', 'parentResourceId', 'name'],
        properties: {
          drive: { type: 'string', description: 'gfs drive name.' },
          parentResourceId: { type: 'string', description: 'Destination folder resource id.' },
          name: { type: 'string', description: 'New folder name.' },
        },
      },
      execute: async (
        args: Record<string, unknown>,
        _outputDir: string,
        context?: InternalToolCallContext
      ): Promise<InternalToolResult> => {
        try {
          return ok(
            await client.createFolder(
              args as { drive: string; parentResourceId: string; name: string },
              callOptions(context)
            )
          )
        } catch (err) {
          return mutationFail(err)
        }
      },
    },
    {
      name: 'clerum__gfs_rename',
      description:
        'Rename one gfs resource without moving it. Requires If-Match (the current resource version).',
      parameters: {
        type: 'object',
        required: ['drive', 'resourceId', 'newName', 'ifMatch'],
        properties: {
          drive: { type: 'string', description: 'gfs drive name.' },
          resourceId: { type: 'string', description: 'Resource id to rename.' },
          newName: { type: 'string', description: 'New file or folder name.' },
          ifMatch: { type: 'number', description: 'The observed resource version.' },
        },
      },
      execute: async (
        args: Record<string, unknown>,
        _outputDir: string,
        context?: InternalToolCallContext
      ): Promise<InternalToolResult> => {
        if (!isValidIfMatch(args.ifMatch)) {
          return invalidArgs('clerum__gfs_rename requires a non-negative safe-integer If-Match')
        }
        try {
          return ok(
            await client.rename(
              args as { drive: string; resourceId: string; newName: string; ifMatch: number },
              callOptions(context)
            )
          )
        } catch (err) {
          return mutationFail(err)
        }
      },
    },
  ]
}

/** Recursive copy is advertised only when both read and write scopes exist. */
export function buildGfsCopyTools(client: GfscWriteClient): InternalToolDefinition[] {
  return [
    {
      name: 'clerum__gfs_copy',
      description:
        'Copy one gfs file or folder tree into a destination folder. The original remains at the source; Copy never deletes it. Requires the observed source-root If-Match; file content remains server-side.',
      parameters: {
        type: 'object',
        required: ['drive', 'sourceResourceId', 'destinationParentId', 'ifMatch'],
        properties: {
          drive: { type: 'string', description: 'gfs drive name.' },
          sourceResourceId: { type: 'string', description: 'Source file or folder resource id.' },
          destinationParentId: { type: 'string', description: 'Destination folder resource id.' },
          newName: { type: 'string', description: 'Optional explicit name for the copied root.' },
          ifMatch: { type: 'number', description: 'The observed source-root version.' },
        },
      },
      execute: async (
        args: Record<string, unknown>,
        _outputDir: string,
        context?: InternalToolCallContext
      ): Promise<InternalToolResult> => {
        if (!isValidIfMatch(args.ifMatch)) {
          return invalidArgs('clerum__gfs_copy requires a non-negative safe-integer If-Match')
        }
        try {
          return ok(
            await client.copy(
              args as {
                drive: string
                sourceResourceId: string
                destinationParentId: string
                newName?: string
                ifMatch: number
              },
              callOptions(context)
            )
          )
        } catch (err) {
          return mutationFail(err)
        }
      },
    },
  ]
}
