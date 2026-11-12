import type { FileReferenceV1 } from '@clerum/gfs-interaction-policy'
import type { FileReferenceResolution } from '../agent/fileReferenceResolver'
import { attachmentSaveName } from '../core/attachments/attachmentSave'
import type { Attachment } from '../core/types'
import { logger } from '../logger'
import { inspectImage, validateImage } from '../visualInput/imageValidation'
import { VisualInputError } from '../visualInput/policy'
import type { MemoryReservation } from '../visualInput/policy'
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
import {
  GFS_LOCAL_PROCESSING_GUIDANCE,
  type GfsFileContent,
  type GfsReadOptions,
} from './gfsReadTypes'
import { gfsStoreSpaceGuidance } from './gfsSpaceGuidance'
import {
  FILE_CONTAINS_SECRET,
  KEPT_FILES_UNAVAILABLE,
  type KeptFileDeletion,
  type KeptFileEntry,
  type KeptFileSources,
  type KeptFileToDelete,
  KeptFilesUnavailableError,
  type ResolvedSourceFile,
  deleteKeptFiles,
  isSourceRefusal,
  listKeptFiles,
  resolveGeneratedFile,
  resolveKeptUpload,
  resolveSourcePath,
} from './keptFiles'
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
// A store space refusal keeps its fixed envelope as the first line and adds the
// fixed guidance for its code as a second line; gfsFilePreparation accepts that
// exact second line and nothing else. Every other store code, including
// `volume_unmeasurable`, is the bare envelope.
function fail(error: unknown): InternalToolResult {
  if (error instanceof VisualInputError) return { success: false, error: error.message }
  if (error instanceof GfsDownloadStoreError) {
    const guidance = gfsStoreSpaceGuidance(error.code)
    return {
      success: false,
      error: guidance === undefined ? error.message : `${error.message}\n${guidance}`,
    }
  }
  if (error instanceof GfsDownloadError) return { success: false, error: error.message }
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
    saveChangedFileWith: 'clerum__gfs_write or clerum__gfs_create_file with sourcePath',
    sourcePathMustBeOutside: '.gfs-downloads',
    processLocally: true,
    boundedOutputOnly: true,
    wholeFileToContextAllowed: false,
    processingInstructions: GFS_LOCAL_PROCESSING_GUIDANCE,
  }
}

function workspaceFileWithoutImage(receipt: GfsDownloadResult, reason: string): InternalToolResult {
  return ok({
    delivery: 'workspace_file',
    ...receipt,
    visualDelivery: 'not_included',
    visualReason: reason,
    usage: workspaceFileUsage('not_included', reason),
  })
}

async function projectManagedImage(
  receipt: GfsDownloadResult,
  downloadStore: GfsDownloadStore,
  callerIdentity: string,
  options: InternalToolExecutionOptions | undefined,
  knownBytes?: Buffer
): Promise<InternalToolResult> {
  let readReservation: MemoryReservation | undefined
  try {
    let bytes = knownBytes
    const prefix =
      bytes?.subarray(0, 16) ??
      (await downloadStore.readManagedFilePrefix(receipt.path, callerIdentity))
    const hasImageMagic =
      prefix.length >= 3 &&
      ((prefix[0] === 0x89 && prefix[1] === 0x50 && prefix[2] === 0x4e) ||
        (prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff))
    if (!hasImageMagic) return workspaceFileWithoutImage(receipt, 'not_image')
    const visualInput = options?.visualInput
    if (!visualInput)
      return workspaceFileWithoutImage(receipt, 'image_input_unavailable_in_this_execution')
    const capability = await visualInput.resolveCapability(options?.signal)
    if (options?.signal?.aborted) throw new VisualInputError('cancelled')
    if (capability.status !== 'supported')
      return workspaceFileWithoutImage(receipt, `model_image_input_${capability.status}`)
    const profile = capability.deliveryLimits
    if (!profile) return workspaceFileWithoutImage(receipt, 'provider_visual_profile_unavailable')
    if (
      (profile.maxImageBytes !== undefined && receipt.sizeBytes > profile.maxImageBytes) ||
      (profile.maxImageEncodedBytes !== undefined &&
        4 * Math.ceil(receipt.sizeBytes / 3) > profile.maxImageEncodedBytes)
    )
      return workspaceFileWithoutImage(receipt, 'provider_visual_limit_exceeded')
    if (bytes === undefined) {
      if (receipt.sizeBytes > visualInput.budget.remainingReadBytes)
        throw new VisualInputError('limit_exceeded')
      // Reserve before the physical read. Inline classification bytes already
      // carry their read reservation and are not charged twice.
      readReservation = visualInput.budget.reserve(receipt.sizeBytes)
      visualInput.budget.consumeRead(receipt.sizeBytes)
      bytes = await downloadStore.readManagedFile(receipt.path, callerIdentity)
    }
    if (options?.signal?.aborted) throw new VisualInputError('cancelled')
    const limits = {
      maxFileBytes: profile.maxImageBytes ?? GFS_FILE_LIMITS.maxFileBytes,
      maxDimension: profile.maxDimension,
      maxPixels: profile.maxPixels,
    }
    const image = inspectImage(bytes, limits)
    if (!image) return workspaceFileWithoutImage(receipt, 'not_image')
    if (
      (profile.maxDimension !== undefined &&
        (image.width > profile.maxDimension || image.height > profile.maxDimension)) ||
      (profile.maxPixels !== undefined && image.width * image.height > profile.maxPixels)
    )
      return workspaceFileWithoutImage(receipt, 'provider_visual_limit_exceeded')
    await validateImage(bytes, image, {
      signal: options?.signal,
      budget: visualInput.budget,
      limits,
    })
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
      images: [{ ...image, source: receipt.source, sizeBytes: receipt.sizeBytes, dataBase64 }],
    }
  } catch (error) {
    if (error instanceof VisualInputError && error.code !== 'cancelled')
      return workspaceFileWithoutImage(
        receipt,
        error.code === 'limit_exceeded' ? 'local_visual_resources_exceeded' : error.code
      )
    throw error
  } finally {
    readReservation?.release()
  }
}

const driveResourceParams = {
  type: 'object',
  required: ['drive', 'resourceId'],
  properties: {
    drive: { type: 'string', description: 'gfs drive name (e.g. "main").' },
    resourceId: {
      type: 'string',
      description:
        'The resourceId returned by GFS discovery (32-hex rid or UUID). A filename, path, or UUID embedded in a filename is not the resourceId. For a human path, find the accessible folder and list its children first.',
    },
  },
} as const

const DOWNLOAD_RESOURCE_ID_PATTERN =
  '^(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$'
const DOWNLOAD_RESOURCE_ID = new RegExp(DOWNLOAD_RESOURCE_ID_PATTERN)
const downloadDriveResourceParams = {
  ...driveResourceParams,
  properties: {
    ...driveResourceParams.properties,
    resourceId: {
      ...driveResourceParams.properties.resourceId,
      pattern: DOWNLOAD_RESOURCE_ID_PATTERN,
    },
  },
} as const

function downloadTargetError(args: Record<string, unknown>): string | null {
  if (typeof args.drive !== 'string' || args.drive.length === 0)
    return 'drive must be the non-empty GFS drive name returned by discovery.'
  if (typeof args.resourceId !== 'string' || !DOWNLOAD_RESOURCE_ID.test(args.resourceId))
    return 'resourceId must be the observed 32-hex or dashed UUID from clerum__gfs_accessible/clerum__gfs_list; filenames, paths, and gfs:// URIs are not resource IDs.'
  return null
}

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
  /** Trusted task lifetime identity; never accepted from model arguments. */
  retentionOwnerId?: string
}

/** The five read tools, bound to a gfsc client. */
export function buildGfsReadTools(
  client: GfscReadClient,
  {
    referencedFiles,
    downloadStore,
    callerIdentity,
    callerWorkspacePath,
    retentionOwnerId,
  }: GfsReadToolOptions
): InternalToolDefinition[] {
  const canDownload = Boolean(
    downloadStore && client.download && callerIdentity && callerWorkspacePath && retentionOwnerId
  )
  const transferToWorkspace = async (
    target: { drive: string; resourceId: string },
    expectedVersion: number | undefined,
    context?: InternalToolExecutionOptions
  ): Promise<GfsDownloadResult> => {
    if (
      !downloadStore ||
      !client.download ||
      !callerIdentity ||
      !callerWorkspacePath ||
      !retentionOwnerId
    )
      throw new GfsDownloadStoreError('workspace_unavailable')
    const transferStartedAt = Date.now()
    enterGfsDownloadTransfer()
    try {
      const receipt = await client.download(target, {
        store: downloadStore,
        callerIdentity,
        callerWorkspacePath,
        retentionOwnerId,
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
        'List directly accessible GFS resources, including effective permissions and stable gfsUri links. A directory with coversDescendants grants access to its children; discover those children with clerum__gfs_list before reading or downloading a named file.',
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
                return await projectManagedImage(receipt, downloadStore!, callerIdentity!, options)
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
          const image = inspectImage(file.bytes, { maxFileBytes: GFS_FILE_LIMITS.maxFileBytes })
          if (image) {
            if (canDownload) {
              recordGfsDownloadAdmission('workspace_attempt')
              const receipt = await transferToWorkspace(
                target as { drive: string; resourceId: string },
                file.source.version,
                options
              )
              return await projectManagedImage(
                receipt,
                downloadStore!,
                callerIdentity!,
                options,
                file.bytes
              )
            }
            const visualInput = options?.visualInput
            if (!visualInput)
              return fileReference(file, 'image_input_unavailable_in_this_execution')
            const capability = await visualInput.resolveCapability(options?.signal)
            if (options?.signal?.aborted) throw new VisualInputError('cancelled')
            if (capability.status !== 'supported')
              return fileReference(file, `model_image_input_${capability.status}`)
            const profile = capability.deliveryLimits
            if (!profile) return fileReference(file, 'provider_visual_profile_unavailable')
            if (
              profile.maxImageEncodedBytes !== undefined &&
              4 * Math.ceil(file.bytes.byteLength / 3) > profile.maxImageEncodedBytes
            )
              return fileReference(file, 'provider_visual_limit_exceeded')
            await validateImage(file.bytes, image, {
              signal: options?.signal,
              budget: visualInput.budget,
              limits: {
                maxFileBytes: profile.maxImageBytes ?? GFS_FILE_LIMITS.maxFileBytes,
                maxDimension: profile.maxDimension,
                maxPixels: profile.maxPixels,
              },
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
          if (text === null || isSvgText(text)) {
            if (canDownload) {
              recordGfsDownloadAdmission('workspace_attempt')
              return await downloadToWorkspace(
                target as { drive: string; resourceId: string },
                file.source.version,
                options
              )
            }
            return fileReference(
              file,
              text === null ? 'unsupported_binary_format' : 'svg_visual_input_not_supported'
            )
          }
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
        ...downloadDriveResourceParams,
        properties: {
          ...downloadDriveResourceParams.properties,
          expectedVersion: {
            type: 'integer',
            minimum: 0,
            description: 'Download only this version of the file.',
          },
        },
      },
      execute: async (args, _outputDir, options): Promise<InternalToolResult> => {
        const inputError = downloadTargetError(args)
        if (inputError) return invalidArgs(inputError)
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
          // Traces omit tool arguments; retain only public target identifiers
          // and a bounded failure category, never GFSC bodies or raw errors.
          const drive =
            typeof target.drive === 'string' &&
            target.drive.length > 0 &&
            target.drive.length <= 64 &&
            !/[^a-z0-9_-]/.test(target.drive)
              ? target.drive
              : undefined
          const resourceId = normalizeRid(target.resourceId)
          const status =
            error instanceof GfscHttpError
              ? error.status
              : error instanceof Error
                ? Number(/^gfsc (\d{3}):/.exec(error.message)?.[1])
                : Number.NaN
          logger.warn(
            {
              component: 'GfsDownload',
              ...(drive === undefined ? {} : { drive }),
              ...(resourceId?.length === 32 ? { resourceId } : {}),
              ...(Number.isInteger(status) && status >= 100 && status <= 599
                ? { httpStatus: status }
                : {}),
              errorClass:
                error instanceof GfscHttpError
                  ? 'GfscHttpError'
                  : error instanceof GfsDownloadError
                    ? 'GfsDownloadError'
                    : error instanceof GfsDownloadStoreError
                      ? 'GfsDownloadStoreError'
                      : error instanceof VisualInputError
                        ? 'VisualInputError'
                        : error instanceof Error
                          ? 'Error'
                          : 'unknown',
            },
            'GFS workspace download failed'
          )
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
  /** Replaces a file's content with bytes, as the create route accepts them. */
  writeBytes(
    args: {
      drive: string
      resourceId: string
      contentBase64: string
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
  createFileFromBytes(
    args: { drive: string; parentResourceId: string; name: string; contentBase64: string },
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

/** The file sources a chat caller may save from, besides text the model wrote. */
const FILE_SOURCE_FIELDS = ['generatedFile', 'sourcePath', 'uploadedFileId'] as const
const SOURCE_FIELDS = ['content', ...FILE_SOURCE_FIELDS] as const
const EXACTLY_ONE_SOURCE = 'give exactly one of content, generatedFile, sourcePath, uploadedFileId'

const SOURCE_PROPERTIES = {
  generatedFile: {
    type: 'string',
    description:
      'Name of a file a document generator made in this chat, as its result or clerum__kept_files_list names it. Pass its Save id as generatedFileId; a listed file with no id is saved by generatedFile alone. Give every generated file its own descriptive file name; a file generated under an existing name replaces it.',
  },
  generatedFileId: {
    type: 'string',
    description:
      'The Save id of the generatedFile, from the generator result or clerum__kept_files_list. Only together with generatedFile.',
  },
  sourcePath: {
    type: 'string',
    description:
      'Relative path of a file in your workspace, such as outputs/report.csv; the Host uploads its bytes. Reserved folders and a path whose first part starts with a dot are refused. To save a changed copy of a download, write it outside .gfs-downloads and pass that path. Not for memory notes (MEMORY.md, daily/, the notes in memory/): use the memory tools.',
  },
  uploadedFileId: {
    type: 'string',
    description:
      'The id of a file or image the user attached in chat, from clerum__kept_files_list (kind upload); it works in a later turn or conversation. Unlike clerum__gfs_save_attachment in the same turn, this save scans the file and refuses one that holds a protected value of this Host.',
  },
} as const

const FILE_SOURCE_NOTICE =
  ' Exactly one source: content (short text you wrote, never a whole file), generatedFile with generatedFileId, sourcePath, or uploadedFileId. The result has source and secretScan. When source is source_path or kept_upload, or generated_file with no Save id, and secretScan is not_scanned, tell the user the file was saved without a secret scan. A generated file with a Save id passed its check when it was generated and needs no such notice.'

type ChosenSource =
  | { kind: 'content'; content: string }
  | { kind: 'generatedFile'; name: string; id?: string }
  | { kind: 'sourcePath'; path: string }
  | { kind: 'uploadedFileId'; id: string }

/** The one source of a write call, or the argument error that refuses the call. */
function chosenSource(args: Record<string, unknown>): ChosenSource | InternalToolResult {
  const given = SOURCE_FIELDS.filter(field => args[field] !== undefined)
  if (given.length !== 1) return invalidArgs(EXACTLY_ONE_SOURCE)
  if (args.generatedFileId !== undefined && given[0] !== 'generatedFile') {
    return invalidArgs(EXACTLY_ONE_SOURCE)
  }
  switch (given[0]) {
    case 'content':
      return typeof args.content === 'string'
        ? { kind: 'content', content: args.content }
        : invalidArgs('content must be a string')
    case 'generatedFile':
      if (typeof args.generatedFile !== 'string' || args.generatedFile === '') {
        return invalidArgs('generatedFile must be a file name')
      }
      if (args.generatedFileId !== undefined && typeof args.generatedFileId !== 'string') {
        return invalidArgs('generatedFileId must be a string')
      }
      return {
        kind: 'generatedFile',
        name: args.generatedFile,
        ...(args.generatedFileId === undefined ? {} : { id: args.generatedFileId }),
      }
    case 'uploadedFileId':
      return typeof args.uploadedFileId === 'string'
        ? { kind: 'uploadedFileId', id: args.uploadedFileId }
        : invalidArgs('uploadedFileId must be a string')
    default:
      return typeof args.sourcePath === 'string' && args.sourcePath !== ''
        ? { kind: 'sourcePath', path: args.sourcePath }
        : invalidArgs('sourcePath must be a relative path')
  }
}

function isToolResult(value: unknown): value is InternalToolResult {
  return typeof value === 'object' && value !== null && 'success' in value
}

/** Reads a file source of the caller; the refusal is a tool error, never an upload. */
function resolvedFileSource(
  sources: KeptFileSources,
  chosen: Exclude<ChosenSource, { kind: 'content' }>,
  createName?: string
): ResolvedSourceFile | InternalToolResult {
  const resolved =
    chosen.kind === 'generatedFile'
      ? resolveGeneratedFile(sources, chosen.name, chosen.id, createName)
      : chosen.kind === 'uploadedFileId'
        ? resolveKeptUpload(sources, chosen.id)
        : resolveSourcePath(sources, chosen.path)
  if (isSourceRefusal(resolved)) {
    return resolved.argument
      ? invalidArgs(resolved.error)
      : { success: false, error: resolved.error }
  }
  if (resolved.secretScan.state === 'secret_found')
    return { success: false, error: FILE_CONTAINS_SECRET }
  return resolved
}

/**
 * Agent gfs WRITE tool (plan P4-S04). clerum__gfs_write replaces a file and
 * REQUIRES If-Match (the resource version) — agent writes are writer-routed
 * conditional writes (P4-S01); the mutation is audited server-side. Destructive
 * bits (delete) stay default-denied for agents.
 *
 * With `sources` (the chat registry), the write and create tools also save a
 * file of the caller's own folders: a generated file, or a workspace file. The
 * Host reads and scans the bytes; the model never carries them. Without it
 * (the workflow runtime) only `content` exists, as before.
 */
export function buildGfsWriteTools(
  client: GfscWriteClient,
  sources?: KeptFileSources
): InternalToolDefinition[] {
  return [
    {
      name: 'clerum__gfs_write',
      description:
        'Conditionally replace the complete content of an existing gfs file. Requires If-Match (the current version).' +
        (sources ? FILE_SOURCE_NOTICE : ''),
      parameters: {
        type: 'object',
        required: sources
          ? ['drive', 'resourceId', 'ifMatch']
          : ['drive', 'resourceId', 'content', 'ifMatch'],
        properties: {
          drive: { type: 'string', description: 'gfs drive name.' },
          resourceId: { type: 'string', description: 'Resource id (32-hex rid).' },
          content: { type: 'string', description: 'New file content.' },
          ifMatch: { type: 'number', description: 'The resource version being replaced.' },
          ...(sources ? SOURCE_PROPERTIES : {}),
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
        if (sources) {
          const chosen = chosenSource(args)
          if (isToolResult(chosen)) return chosen
          if (chosen.kind !== 'content') {
            const file = resolvedFileSource(sources, chosen)
            if (isToolResult(file)) return file
            try {
              const resource = await client.writeBytes(
                {
                  drive: args.drive as string,
                  resourceId: args.resourceId as string,
                  contentBase64: file.bytes.toString('base64'),
                  ifMatch: args.ifMatch,
                },
                callOptions(context)
              )
              return ok({
                source: file.source,
                bytes: file.bytes.byteLength,
                secretScan: file.secretScan,
                resource,
              })
            } catch (err) {
              return mutationFail(err)
            }
          }
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
      description:
        'Create one file under an existing gfs folder.' + (sources ? FILE_SOURCE_NOTICE : ''),
      parameters: {
        type: 'object',
        required: sources
          ? ['drive', 'parentResourceId', 'name']
          : ['drive', 'parentResourceId', 'name', 'content'],
        properties: {
          drive: { type: 'string', description: 'gfs drive name.' },
          parentResourceId: { type: 'string', description: 'Destination folder resource id.' },
          name: {
            type: 'string',
            description:
              'New file name including its file extension, e.g. "report.txt" or "notes.md". Always match the content format.',
          },
          content: { type: 'string', description: 'Initial file content.' },
          ...(sources ? SOURCE_PROPERTIES : {}),
        },
      },
      execute: async (
        args: Record<string, unknown>,
        _outputDir: string,
        context?: InternalToolCallContext
      ): Promise<InternalToolResult> => {
        if (sources) {
          const chosen = chosenSource(args)
          if (isToolResult(chosen)) return chosen
          if (chosen.kind !== 'content') {
            const file = resolvedFileSource(sources, chosen, args.name as string)
            if (isToolResult(file)) return file
            try {
              const resource = await client.createFileFromBytes(
                {
                  drive: args.drive as string,
                  parentResourceId: args.parentResourceId as string,
                  name: args.name as string,
                  contentBase64: file.bytes.toString('base64'),
                },
                callOptions(context)
              )
              return ok({
                source: file.source,
                bytes: file.bytes.byteLength,
                secretScan: file.secretScan,
                resource,
              })
            } catch (err) {
              return mutationFail(err)
            }
          }
        }
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

export const GFS_SAVE_ATTACHMENT_TOOL = 'clerum__gfs_save_attachment'

/**
 * Saves an attachment of the turn's own message into a gfs folder. The Host
 * resolves the id against that message only and forwards the admitted base64
 * unchanged, so the model never carries the bytes and cannot write bytes it
 * was not given. The file is named by attachmentSaveName, the name its
 * turn-context line shows; rename afterwards with clerum__gfs_rename.
 */
export function buildGfsAttachmentSaveTools(
  client: GfscWriteClient,
  attachments: readonly Attachment[]
): InternalToolDefinition[] {
  return [
    {
      name: GFS_SAVE_ATTACHMENT_TOOL,
      description:
        'Save a file or image attached to the current message into an existing gfs folder, byte for byte. ' +
        'Pass the id of its attached_file or attached_image line. The new file is named as that line shows. ' +
        'If a file with that name already ' +
        'exists in the folder the save fails with conflict: tell the user and do not rename or replace ' +
        'their files unless they ask.',
      parameters: {
        type: 'object',
        required: ['drive', 'parentResourceId', 'attachmentId'],
        properties: {
          drive: { type: 'string', description: 'gfs drive name.' },
          parentResourceId: { type: 'string', description: 'Destination folder resource id.' },
          attachmentId: {
            type: 'string',
            description: 'The id of an attached_file or attached_image line in the turn context.',
          },
        },
      },
      execute: async (
        args: Record<string, unknown>,
        _outputDir: string,
        context?: InternalToolCallContext
      ): Promise<InternalToolResult> => {
        const { drive, parentResourceId, attachmentId } = args
        if (typeof drive !== 'string' || typeof parentResourceId !== 'string') {
          return invalidArgs(
            'clerum__gfs_save_attachment requires string drive and parentResourceId'
          )
        }
        const attachment = attachments.find(candidate => candidate.id === attachmentId)
        if (!attachment) {
          return invalidArgs(
            'attachment_not_found: no attachment with this id is part of the current message'
          )
        }
        if (typeof attachment.dataBase64 !== 'string') {
          return invalidArgs(
            'bytes_unavailable_after_restart: ask the user to attach the file again in a new message. ' +
              `Files attached earlier are kept for ${Math.round(GFS_FILE_LIMITS.retentionMs / 3_600_000)} hours, see clerum__kept_files_list`
          )
        }
        const name = attachmentSaveName(attachment)
        if (name === null) {
          return invalidArgs(
            'attachment_name_missing: this attachment has no name to save it under'
          )
        }
        const bytes = Buffer.byteLength(attachment.dataBase64, 'base64')
        // No local size check: gfsc bounds the write body with a per-deployment
        // GFS_MAX_WRITE_BODY_BYTES the Host cannot see, and answers 413, which
        // mutationFail reports as limit_exceeded.
        try {
          const resource = await client.createFileFromBytes(
            { drive, parentResourceId, name, contentBase64: attachment.dataBase64 },
            callOptions(context)
          )
          return ok({ attachmentId: attachment.id, name, bytes, resource })
        } catch (err) {
          return mutationFail(err)
        }
      },
    },
  ]
}

/** The most entries the listing tool returns; the delete and the saves read the uncut list. */
export const KEPT_FILES_LIST_LIMIT = 100

/**
 * `clerum__kept_files_list`: the caller's kept files, oldest first, at most
 * 100, optionally only those whose name contains `nameContains`. Its output
 * never goes to spillover storage, so no file name rests there.
 */
export function buildKeptFilesListTool(callerRoot: string | undefined): InternalToolDefinition {
  const hours = Math.round(GFS_FILE_LIMITS.retentionMs / 3_600_000)
  return {
    name: 'clerum__kept_files_list',
    description:
      'List the files this Host keeps for this user: files the document generators made in chat, with their Save id, and files the user attached in chat (kind upload). ' +
      'Save one with clerum__gfs_create_file or clerum__gfs_write: a generated file with generatedFile plus generatedFileId, an entry without id by generatedFile alone, an upload with uploadedFileId; canSave false means it cannot be saved (reason). ' +
      'The list starts with the oldest files and the newest file is the last entry; at most 100 entries. ' +
      'When truncated is true and the user asks for a recent file, ask the user for part of its name and pass it as nameContains, or use the Save id of the generation. ' +
      `Each file is deleted ${hours} hours after its createdAt; tell the user the date when they say they will save a file later. ` +
      'Give every generated file its own descriptive file name; a file generated under an existing name replaces it.',
    parameters: {
      type: 'object',
      properties: {
        nameContains: {
          type: 'string',
          minLength: 1,
          maxLength: 255,
          description: 'Only files whose name contains this text, in any case.',
        },
      },
    },
    spilloverExempt: true,
    execute: async (args: Record<string, unknown>): Promise<InternalToolResult> => {
      const filter = args.nameContains
      if (
        filter !== undefined &&
        (typeof filter !== 'string' || filter.length < 1 || filter.length > 255)
      ) {
        return invalidArgs('nameContains must be 1 to 255 characters')
      }
      if (!callerRoot) return { success: false, error: KEPT_FILES_UNAVAILABLE }
      let entries: KeptFileEntry[]
      try {
        entries = listKeptFiles(callerRoot)
      } catch (err) {
        if (err instanceof KeptFilesUnavailableError) {
          return { success: false, error: KEPT_FILES_UNAVAILABLE }
        }
        throw err
      }
      const needle = typeof filter === 'string' ? filter.toLowerCase() : undefined
      const matching = needle
        ? entries.filter(entry => entry.name.toLowerCase().includes(needle))
        : entries
      return ok({
        files: matching.slice(0, KEPT_FILES_LIST_LIMIT).map(entry => ({
          kind: entry.kind,
          name: entry.name,
          ...(entry.id === undefined ? {} : { id: entry.id }),
          format: entry.format,
          createdAt: entry.createdAt,
          sizeBytes: entry.sizeBytes,
          canSave: entry.canSave,
          ...(entry.reason === undefined ? {} : { reason: entry.reason }),
        })),
        truncated: matching.length > KEPT_FILES_LIST_LIMIT,
      })
    },
  }
}

/** Bounds of one partial edit; a call past them is refused before anything is read. */
const EDIT_LIMITS = { maxEdits: 50, maxOldTextBytes: 4096, maxNewTextBytes: 65_536 }
/** The largest diff returned; a longer one is cut and marked truncated. */
const EDIT_DIFF_MAX_CHARS = 16_384
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])

export const EDIT_SCOPE_SENTENCE =
  'for small changes; to rewrite or translate a whole file, write the new file with an approved shell command outside .gfs-downloads and save it with clerum__gfs_write and sourcePath'

interface TextEdit {
  oldText: string
  newText: string
  replaceAll?: boolean
}

function occurrences(text: string, needle: string): number[] {
  const at: number[] = []
  for (
    let index = text.indexOf(needle);
    index !== -1;
    index = text.indexOf(needle, index + needle.length)
  )
    at.push(index)
  return at
}

/**
 * `clerum__gfs_edit_text`: replaces parts of a text file in GFS and returns a
 * diff built from the edits themselves. Edits apply in order, each to the
 * result of the previous one; each must match exactly once (at least once
 * with `replaceAll`) in that intermediate text, or nothing is written. A
 * leading byte order mark is kept and line endings are untouched.
 */
export function buildGfsEditTools(client: GfscWriteClient): InternalToolDefinition[] {
  return [
    {
      name: 'clerum__gfs_edit_text',
      description:
        `Replace parts of a text file in gfs and get a diff, ${EDIT_SCOPE_SENTENCE}. ` +
        'A small change (a typo, a sentence, a paragraph) is one or more edits; for a file above 8 KiB take oldText from a bounded excerpt of the downloaded copy with an approved shell command, and pass the downloaded version as ifMatch. ' +
        'Edits apply in order, each to the result of the previous one; each oldText must match exactly once unless replaceAll. dryRun returns the diff without writing.',
      parameters: {
        type: 'object',
        required: ['drive', 'resourceId', 'ifMatch', 'edits'],
        properties: {
          drive: { type: 'string', description: 'gfs drive name.' },
          resourceId: { type: 'string', description: 'Resource id (32-hex rid).' },
          ifMatch: { type: 'number', description: 'The version being edited.' },
          edits: {
            type: 'array',
            description: '1 to 50 edits; each oldText at most 4,096 bytes.',
            items: {
              type: 'object',
              required: ['oldText', 'newText'],
              properties: {
                oldText: { type: 'string', description: 'Exact text to replace.' },
                newText: { type: 'string', description: 'Replacement text.' },
                replaceAll: { type: 'boolean', description: 'Replace every match.' },
              },
            },
          },
          dryRun: { type: 'boolean', description: 'Return the diff only; write nothing.' },
        },
      },
      execute: async (
        args: Record<string, unknown>,
        _outputDir: string,
        options?: InternalToolExecutionOptions
      ): Promise<InternalToolResult> => {
        if (!isValidIfMatch(args.ifMatch)) {
          return invalidArgs('clerum__gfs_edit_text requires a non-negative safe-integer ifMatch')
        }
        const edits = args.edits
        const valid =
          Array.isArray(edits) &&
          edits.length >= 1 &&
          edits.length <= EDIT_LIMITS.maxEdits &&
          edits.every(
            (edit): edit is TextEdit =>
              typeof edit === 'object' &&
              edit !== null &&
              typeof (edit as TextEdit).oldText === 'string' &&
              typeof (edit as TextEdit).newText === 'string' &&
              ((edit as TextEdit).replaceAll === undefined ||
                typeof (edit as TextEdit).replaceAll === 'boolean') &&
              Buffer.byteLength((edit as TextEdit).oldText) >= 1 &&
              Buffer.byteLength((edit as TextEdit).oldText) <= EDIT_LIMITS.maxOldTextBytes
          ) &&
          (edits as TextEdit[]).reduce((sum, edit) => sum + Buffer.byteLength(edit.newText), 0) <=
            EDIT_LIMITS.maxNewTextBytes
        if (!valid) {
          return invalidArgs(
            `edits must be 1 to 50, each oldText 1 to 4096 bytes and all newText at most 65536 bytes: this tool is ${EDIT_SCOPE_SENTENCE}`
          )
        }
        const target = { drive: args.drive as string, resourceId: args.resourceId as string }
        let file: GfsFileContent | undefined
        try {
          file = await client.read(target, {
            ...callOptions(options),
            timeoutMs: options?.timeoutMs,
            budget: options?.readBudget ?? options?.visualInput?.budget,
            expectedVersion: args.ifMatch,
          })
          const decoded = decodeTextContent(file.bytes)
          if (decoded === null) {
            return {
              success: false,
              error: 'not_a_text_file: this file is not text, so it cannot be edited in parts',
            }
          }
          const bom = file.bytes.subarray(0, 3).equals(UTF8_BOM)
          let text = decoded
          const hunks: Array<{ edit: number; line: number; removed: string[]; added: string[] }> =
            []
          for (const [index, edit] of (edits as TextEdit[]).entries()) {
            const found = occurrences(text, edit.oldText)
            if (edit.replaceAll ? found.length < 1 : found.length !== 1) {
              return {
                success: false,
                error: `edit ${index} matched ${found.length} times; it must match ${
                  edit.replaceAll ? 'at least once' : 'exactly once'
                }. Nothing was written`,
              }
            }
            hunks.push({
              edit: index,
              line: text.slice(0, found[0]).split('\n').length,
              removed: edit.oldText.split('\n'),
              added: edit.newText.split('\n'),
            })
            text = edit.replaceAll
              ? text.split(edit.oldText).join(edit.newText)
              : text.slice(0, found[0]) + edit.newText + text.slice(found[0]! + edit.oldText.length)
          }
          const content = (bom ? '﻿' : '') + text
          let diff = hunks
            .map(
              hunk =>
                `@@ edit ${hunk.edit} line ${hunk.line}\n` +
                hunk.removed.map(line => `-${line}`).join('\n') +
                '\n' +
                hunk.added.map(line => `+${line}`).join('\n')
            )
            .join('\n')
          const truncated = diff.length > EDIT_DIFF_MAX_CHARS
          if (truncated) diff = diff.slice(0, EDIT_DIFF_MAX_CHARS)
          const summary = {
            bytesBefore: file.bytes.byteLength,
            bytesAfter: Buffer.byteLength(content),
            diff,
            truncated,
          }
          if (args.dryRun === true) return ok({ dryRun: true, version: args.ifMatch, ...summary })
          const written = (await client.write(
            { ...target, content, ifMatch: args.ifMatch },
            callOptions(options)
          )) as { version?: unknown } | undefined
          return ok({ version: written?.version, ...summary })
        } catch (err) {
          if (err instanceof GfscHttpError) return mutationFail(err)
          return fail(err)
        } finally {
          file?.reservation.release()
        }
      },
    },
  ]
}

export const KEPT_FILES_DELETE_TOOL = 'clerum__kept_files_delete'

/** The sentence a delete adds when this turn's attachments could not be kept. */
export const ATTACH_AGAIN_SENTENCE =
  'the attachments of this message were not kept; ask the user to attach them again'

/**
 * `clerum__kept_files_delete`: deletes files the Host keeps for this user,
 * named by kind, id and name from the listing, after the user approves the
 * call. It cannot name a GFS file, a download copy, a workspace file, a file
 * with no record or another user's file: it has no path and no GFS client.
 */
export function buildKeptFilesDeleteTool(
  callerRoot: string | undefined,
  options: { keepRefused: boolean }
): InternalToolDefinition {
  return {
    name: KEPT_FILES_DELETE_TOOL,
    description:
      'Delete files this Host keeps for this user, to make room. Name each file by kind, id and name exactly as clerum__kept_files_list gives them; only files with an id can be deleted. ' +
      'Call it only with the files the user agreed to delete; the user approves the call itself on an approval card that lists every name. Deleted files cannot be recovered.',
    requiresApproval: true,
    parameters: {
      type: 'object',
      required: ['files'],
      properties: {
        files: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: {
            type: 'object',
            required: ['kind', 'id', 'name'],
            properties: {
              kind: { type: 'string', enum: ['generated', 'upload'] },
              id: { type: 'string', pattern: '^[0-9a-f]{12}$' },
              name: { type: 'string', minLength: 1, maxLength: 255 },
            },
          },
        },
      },
    },
    execute: async (args: Record<string, unknown>): Promise<InternalToolResult> => {
      const files = args.files
      if (
        !Array.isArray(files) ||
        files.length < 1 ||
        files.length > 20 ||
        !files.every(
          (file): file is KeptFileToDelete =>
            typeof file === 'object' &&
            file !== null &&
            ((file as KeptFileToDelete).kind === 'generated' ||
              (file as KeptFileToDelete).kind === 'upload') &&
            typeof (file as KeptFileToDelete).id === 'string' &&
            /^[0-9a-f]{12}$/.test((file as KeptFileToDelete).id) &&
            typeof (file as KeptFileToDelete).name === 'string'
        )
      ) {
        return invalidArgs(
          'files must be 1 to 20 entries of kind, id and name from clerum__kept_files_list'
        )
      }
      if (!callerRoot) return { success: false, error: KEPT_FILES_UNAVAILABLE }
      let outcome: KeptFileDeletion
      try {
        outcome = deleteKeptFiles(callerRoot, files)
      } catch (err) {
        if (err instanceof KeptFilesUnavailableError) {
          return { success: false, error: KEPT_FILES_UNAVAILABLE }
        }
        throw err
      }
      if (outcome.status === 'mismatch') {
        return {
          success: false,
          error:
            'kept_file_mismatch: a name does not match its id; nothing was deleted. Call clerum__kept_files_list and use its names and ids',
        }
      }
      return ok({
        files: outcome.files.map(file => ({
          kind: file.kind,
          id: file.id,
          name: file.name,
          result: file.result,
        })),
        freedBytes: outcome.freedBytes,
        ...(options.keepRefused ? { note: ATTACH_AGAIN_SENTENCE } : {}),
      })
    },
  }
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
