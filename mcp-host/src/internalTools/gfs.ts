import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { FileReferenceV1 } from '@clerum/gfs-interaction-policy'
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
import { GfsDownloadError } from './gfsContentDownload'
import type { GfsDownloadOptions, GfsDownloadResult } from './gfsContentDownload'
import { type GfsMetadataSnapshot, normalizeRid } from './gfsContentRead'
import {
  enterGfsDownloadTransfer,
  exitGfsDownloadTransfer,
  recordGfsDownloadAdmission,
  recordGfsDownloadTransfer,
} from './gfsDownloadMetrics'
import { GfsDownloadStore, GfsDownloadStoreError } from './gfsDownloadStore'
import { GFS_FILE_LIMITS } from './gfsFilePolicy'
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
  readMetadata?(
    args: { drive: string; resourceId: string },
    options: {
      signal?: AbortSignal
      timeoutMs?: number
      deadlineMs?: number
      expectedVersion?: number
    }
  ): Promise<GfsMetadataSnapshot>
  download?(
    args: { drive: string; resourceId: string },
    options: GfsDownloadOptions
  ): Promise<GfsDownloadResult>
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
  if (error instanceof GfsDownloadError || error instanceof GfsDownloadStoreError)
    return { success: false, error: error.message }
  return redactedFail('GFS read failed', error)
}

function versionConflict(error: unknown): boolean {
  return (
    (error instanceof VisualInputError && error.code === 'version_conflict') ||
    (error instanceof GfsDownloadError && error.code === 'version_conflict')
  )
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

function workspaceFileUsage(visualDelivery: 'included' | 'not_included', visualReason?: string) {
  return {
    pathSemantics: 'relative-to-caller-workspace',
    nextTool: 'shell_exec_when_local_processing_is_needed',
    visualDelivery,
    ...(visualReason === undefined ? {} : { visualReason }),
    approval: 'user-approval-required',
    writeOutputsTo: 'outputs/',
    processLocally: true,
    boundedOutputOnly: true,
    wholeFileToContextAllowed: false,
  }
}

async function resolveManagedImagePath(receipt: GfsDownloadResult, callerWorkspacePath: string) {
  const realRoot = await fs.realpath(callerWorkspacePath)
  const target = path.resolve(callerWorkspacePath, receipt.path)
  const realTarget = await fs.realpath(target)
  const managedRoot = path.join(realRoot, '.gfs-downloads')
  const relativeToManagedRoot = path.relative(managedRoot, realTarget)
  if (
    relativeToManagedRoot.startsWith('..') ||
    path.isAbsolute(relativeToManagedRoot) ||
    !receipt.path.startsWith('.gfs-downloads/')
  )
    throw new VisualInputError('identity_mismatch')
  return target
}

async function readManagedImageBytes(
  receipt: GfsDownloadResult,
  callerWorkspacePath: string
): Promise<Buffer> {
  const target = await resolveManagedImagePath(receipt, callerWorkspacePath)

  const handle = await fs.open(
    target,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_EXCL
  )
  try {
    const stat = await handle.stat()
    if (
      !stat.isFile() ||
      stat.size !== receipt.sizeBytes ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.nlink !== 1
    )
      throw new VisualInputError('identity_mismatch')
    const bytes = await handle.readFile()
    if (createHash('sha256').update(bytes).digest('hex') !== receipt.sha256)
      throw new VisualInputError('identity_mismatch')
    return bytes
  } finally {
    await handle.close()
  }
}

async function readManagedImagePrefix(
  receipt: GfsDownloadResult,
  callerWorkspacePath: string
): Promise<Buffer> {
  const target = await resolveManagedImagePath(receipt, callerWorkspacePath)
  const handle = await fs.open(
    target,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_EXCL
  )
  try {
    const prefix = Buffer.alloc(16)
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0)
    return prefix.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

async function projectManagedImage(
  receipt: GfsDownloadResult,
  callerWorkspacePath: string,
  options: InternalToolExecutionOptions | undefined,
  knownBytes?: Buffer
): Promise<InternalToolResult> {
  let visualReason = 'not_image'
  try {
    let bytes = knownBytes
    if (bytes === undefined) {
      const prefix = await readManagedImagePrefix(receipt, callerWorkspacePath)
      const hasImageMagic =
        prefix.length >= 3 &&
        ((prefix[0] === 0x89 && prefix[1] === 0x50 && prefix[2] === 0x4e) ||
          (prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff))
      if (!hasImageMagic)
        return {
          success: true,
          content: JSON.stringify({
            delivery: 'workspace_file',
            ...receipt,
            visualDelivery: 'not_included',
            visualReason,
            usage: workspaceFileUsage('not_included', visualReason),
          }),
        }
      bytes = await readManagedImageBytes(receipt, callerWorkspacePath)
    }
    const image = inspectImage(bytes)
    if (image) {
      const visualInput = options?.visualInput
      if (!visualInput) visualReason = 'image_input_unavailable_in_this_execution'
      else {
        const capability = await visualInput.resolveCapability(options?.signal)
        if (options?.signal?.aborted) throw new VisualInputError('cancelled')
        if (capability.status !== 'supported')
          visualReason = `model_image_input_${capability.status}`
        else {
          await validateImage(bytes, image, { signal: options?.signal, budget: visualInput.budget })
          if (options?.signal?.aborted) throw new VisualInputError('cancelled')
          const dataBase64 = visualInput.budget.encodeImage(bytes)
          return {
            success: true,
            content: JSON.stringify({
              delivery: 'workspace_file',
              ...receipt,
              visualDelivery: 'included',
              usage: workspaceFileUsage('included'),
            }),
            images: [
              { ...image, source: receipt.source, sizeBytes: receipt.sizeBytes, dataBase64 },
            ],
          }
        }
      }
    }
  } catch (error) {
    if (error instanceof VisualInputError && error.code !== 'cancelled') visualReason = error.code
    else throw error
  }
  return {
    success: true,
    content: JSON.stringify({
      delivery: 'workspace_file',
      ...receipt,
      visualDelivery: 'not_included',
      visualReason,
      usage: workspaceFileUsage('not_included', visualReason),
    }),
  }
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
  /** Producer-classified payload size; retained without filename inference. */
  byteLength?: FileReferenceV1['byteLength']
  /** Producer byte classification: text, image, or binary. */
  reader?: FileReferenceV1['reader']
  /** Producer-declared visual candidacy, not a provider-capability claim. */
  modelImageInput?: FileReferenceV1['modelImageInput']
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
      byteLength: reference.byteLength,
      reader: reference.reader,
      modelImageInput: reference.modelImageInput,
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
  /** Host-owned durable store; task registries receive a caller-bound handle. */
  downloadStore?: GfsDownloadStore
  /** Trusted identity derived by the Host, never tool arguments. */
  callerIdentity?: string
  /** Caller workspace root derived by the Host, never tool arguments. */
  callerWorkspacePath?: string
}

/** The five read tools, bound to a gfsc client. */
export function buildGfsReadTools(
  client: GfscReadClient,
  { referencedFiles, downloadStore, callerIdentity, callerWorkspacePath }: GfsReadToolOptions
): InternalToolDefinition[] {
  const canDownload = Boolean(
    downloadStore && client.download && callerIdentity && callerWorkspacePath
  )
  const transferToWorkspace = async (
    target: { drive: string; resourceId: string },
    expectedVersion: number | undefined,
    context?: InternalToolExecutionOptions
  ): Promise<GfsDownloadResult> => {
    if (!downloadStore || !client.download || !callerIdentity || !callerWorkspacePath)
      throw new GfsDownloadStoreError('workspace_unavailable')
    const transferStartedAt = Date.now()
    enterGfsDownloadTransfer()
    try {
      const receipt = await client.download(target, {
        store: downloadStore,
        callerIdentity,
        callerWorkspacePath,
        ...callOptions(context),
        timeoutMs: context?.timeoutMs,
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
      })
      recordGfsDownloadTransfer('success', (Date.now() - transferStartedAt) / 1000)
      return receipt
    } catch (error) {
      recordGfsDownloadTransfer('failure', (Date.now() - transferStartedAt) / 1000)
      throw error
    } finally {
      exitGfsDownloadTransfer()
    }
  }
  const downloadToWorkspace = async (
    target: { drive: string; resourceId: string },
    expectedVersion: number | undefined,
    context?: InternalToolExecutionOptions
  ): Promise<InternalToolResult> => {
    const receipt = await transferToWorkspace(target, expectedVersion, context)
    return ok({
      delivery: 'workspace_file',
      ...receipt,
      usage: workspaceFileUsage('not_included'),
    })
  }
  const tools: InternalToolDefinition[] = [
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
        'Read a GFS file by drive + resourceId. Returns bounded UTF-8 text inline; larger admitted sources are delivered as governed workspace files, and a valid JPEG/PNG may additionally become visual input after its workspace receipt is preserved. ' +
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
        let snapshot: GfsMetadataSnapshot | undefined
        try {
          if (client.readMetadata) {
            const metadata = await client.readMetadata(
              target as { drive: string; resourceId: string },
              {
                ...callOptions(options),
                timeoutMs: options?.timeoutMs,
                ...(expectedVersion === undefined ? {} : { expectedVersion }),
              }
            )
            snapshot = metadata
            if (metadata.size > GFS_FILE_LIMITS.inlineTextBytes) {
              if (canDownload) {
                recordGfsDownloadAdmission('workspace_attempt')
                const receipt = await transferToWorkspace(
                  target as { drive: string; resourceId: string },
                  metadata.source.version,
                  options
                )
                return await projectManagedImage(receipt, callerWorkspacePath!, options)
              } else {
                recordGfsDownloadAdmission('workspace_unavailable')
                expectedVersion ??= metadata.source.version
                return ok({
                  availability: 'workspace_delivery_unavailable',
                  resource: metadata.source,
                  sizeBytes: metadata.size,
                  inlineTextBytes: GFS_FILE_LIMITS.inlineTextBytes,
                  reason: 'workspace_delivery_is_required_for_this_file_size',
                })
              }
            }
          }
          recordGfsDownloadAdmission('inline_attempt')
          if (expectedVersion === undefined && snapshot?.source.version !== undefined)
            expectedVersion = snapshot.source.version
          file = await client.read(target as { drive: string; resourceId: string }, {
            ...callOptions(options),
            timeoutMs: options?.timeoutMs,
            budget: options?.readBudget ?? options?.visualInput?.budget,
            ...(snapshot === undefined ? {} : { metadataSnapshot: snapshot }),
            ...((snapshot?.source.version ?? expectedVersion) === undefined
              ? {}
              : { expectedVersion: snapshot?.source.version ?? expectedVersion }),
          })
          if (options?.signal?.aborted) throw new VisualInputError('cancelled')
          const image = inspectImage(file.bytes)
          if (image) {
            if (canDownload) {
              recordGfsDownloadAdmission('workspace_attempt')
              const receipt = await transferToWorkspace(
                target as { drive: string; resourceId: string },
                file.source.version,
                options
              )
              return await projectManagedImage(receipt, callerWorkspacePath!, options, file.bytes)
            }
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
          // Inline text is bounded by the generic GFS policy; larger sources were
          // routed to the workspace before this in-memory read.
          const text = decodeTextContent(file.bytes)
          if (text === null) return fileReference(file, 'unsupported_binary_format')
          if (isSvgText(text)) return fileReference(file, 'svg_visual_input_not_supported')
          return ok(text)
        } catch (err) {
          if (
            snapshot === undefined &&
            err instanceof VisualInputError &&
            err.code === 'limit_exceeded'
          )
            recordGfsDownloadAdmission('limit_exceeded')
          // #666 — with an expected version, a version conflict is an answer about
          // the reference, not a read failure.
          if (expectedVersion !== undefined && versionConflict(err))
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
  if (canDownload) {
    tools.push({
      name: 'clerum__gfs_download',
      description:
        'Download a GFS file to this caller workspace without putting its contents in model context. Returns source metadata, SHA-256, exact size, version, expiry, and a relative workspace path for approved local processing.',
      parameters: {
        ...driveResourceParams,
        properties: {
          ...driveResourceParams.properties,
          expectedVersion: {
            type: 'integer',
            minimum: 0,
            description: 'Download only this version of the file.',
          },
        },
      },
      execute: async (args, _outputDir, options): Promise<InternalToolResult> => {
        const { expectedVersion: requestedVersion, ...target } = args
        if (requestedVersion !== undefined && !isValidIfMatch(requestedVersion))
          return invalidArgs('expectedVersion must be a non-negative integer.')
        const key = referencedFileKey(target.drive, target.resourceId)
        const pin = key === null ? undefined : referencedFiles.get(key)
        let expectedVersion = requestedVersion
        if (pin) {
          if (requestedVersion === undefined) expectedVersion = pin.version
          else if (requestedVersion !== pin.version && requestedVersion !== pin.currentVersion)
            return invalidArgs(pinnedVersionMessage(pin))
        }
        try {
          return await downloadToWorkspace(
            target as { drive: string; resourceId: string },
            expectedVersion as number | undefined,
            options
          )
        } catch (error) {
          if (expectedVersion !== undefined && versionConflict(error))
            return ok({ availability: 'stale', ...target, expectedVersion })
          return fail(error)
        }
      },
    })
  }
  return tools
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
