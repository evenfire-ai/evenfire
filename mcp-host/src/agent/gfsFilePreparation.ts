import { randomUUID } from 'node:crypto'
import { FILE_REFERENCE_MAX_COUNT } from '@clerum/gfs-interaction-policy'
import type { FileReferenceV1 } from '@clerum/gfs-interaction-policy'
import type { LoopConfig } from '../core/orchestration/loopConfig'
import { admitToolCall, executeAdmittedTool } from '../core/orchestration/toolCallPolicy'
import type {
  GfsPreparationFailure,
  PreparedGfsFile,
  PreparedGfsUsage,
} from '../core/orchestration/turnContext'
import type { ToolOutput } from '../core/types'
import { normalizeRid } from '../internalTools/gfsContentRead'
import { GFS_FILE_LIMITS } from '../internalTools/gfsFilePolicy'
import { GFS_LOCAL_PROCESSING_GUIDANCE } from '../internalTools/gfsReadTypes'
import { gfsStoreSpaceGuidance } from '../internalTools/gfsSpaceGuidance'
import type { FileReferenceResolution } from './fileReferenceResolver'
import type { TaskExecutionBudget } from './taskExecutionBudget'

const DOWNLOAD_TOOL = 'clerum__gfs_download'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA256_RE = /^[0-9a-f]{64}$/

export function hasLargeAvailableGfsReferences(
  resolutions?: readonly FileReferenceResolution[]
): boolean {
  return (
    resolutions?.some(
      ({ availability, reference }) =>
        availability === 'available' &&
        reference.source.kind === 'gfs' &&
        reference.byteLength > GFS_FILE_LIMITS.inlineTextBytes
    ) === true
  )
}

function failureCode(content: string): GfsPreparationFailure {
  // Read only the producer's fixed public error envelope; never forward its text.
  if (Buffer.byteLength(content, 'utf8') > GFS_FILE_LIMITS.errorBytes) return 'download_failed'
  const http = /^Error: GFS read failed \(gfsc (\d{3}): [a-z_]+(?:, retry after \d+s)?\)$/.exec(
    content
  )
  if (http) {
    const status = Number(http[1])
    if (status === 401) return 'unauthenticated'
    if (status === 403) return 'denied'
    if (status === 404 || status === 410) return 'missing'
    if (status === 409 || status === 412) return 'stale'
    if (status === 413) return 'limit_exceeded'
    return 'download_failed'
  }
  // A store space refusal carries its fixed guidance as an exact second line;
  // any other second line is not a recognised envelope.
  const space = /^Error: GFS download store failed \((disk_full|host_quota_exceeded)\)\n/.exec(
    content
  )
  if (space) {
    const code = space[1] as 'disk_full' | 'host_quota_exceeded'
    if (content.slice(space[0].length) !== gfsStoreSpaceGuidance(code)) return 'download_failed'
    return code === 'disk_full' ? 'disk_full' : 'quota_exceeded'
  }
  const fixed = /^Error: GFS (?:download(?: store)?|read) failed \(([a-z_]+)\)$/.exec(content)?.[1]
  if (fixed === 'version_conflict') return 'stale'
  if (fixed === 'download_missing' || fixed === 'download_expired') return 'missing'
  if (fixed === 'disk_full') return 'disk_full'
  if (fixed === 'host_quota_exceeded') return 'quota_exceeded'
  // Carries no guidance: only the bare envelope maps here; with any second line
  // the anchored envelope does not match and the result is download_failed.
  if (fixed === 'volume_unmeasurable') return 'volume_unmeasurable'
  if (fixed === 'workspace_unavailable') return 'workspace_unavailable'
  if (fixed === 'limit_exceeded') return 'limit_exceeded'
  if (fixed === 'timeout') return 'timeout'
  if (fixed === 'invalid_response' || fixed === 'identity_mismatch') return 'invalid_response'
  return 'download_failed'
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function checkedPreparation(
  output: ToolOutput,
  reference: FileReferenceV1
): PreparedGfsFile | undefined {
  if (
    reference.source.kind !== 'gfs' ||
    output.attachments?.length ||
    Buffer.byteLength(output.content, 'utf8') > GFS_FILE_LIMITS.metadataBytes
  )
    return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(output.content)
  } catch {
    return undefined
  }
  const receipt = record(parsed)
  // The native tool reports a pinned-version conflict as a successful metadata
  // availability result, not as a downloaded file or an error string.
  if (
    receipt?.availability === 'stale' &&
    receipt.drive === reference.source.drive &&
    receipt.resourceId === reference.source.resourceId &&
    receipt.expectedVersion === reference.source.version
  )
    return { referenceId: reference.id, status: 'unavailable', code: 'stale' }
  const source = record(receipt?.source)
  const usage = record(receipt?.usage)
  if (
    !receipt ||
    !source ||
    !usage ||
    receipt.delivery !== 'workspace_file' ||
    typeof receipt.id !== 'string' ||
    !UUID_RE.test(receipt.id) ||
    receipt.path !== `.gfs-downloads/input-${receipt.id}/source` ||
    receipt.sizeBytes !== reference.byteLength ||
    typeof receipt.sha256 !== 'string' ||
    !SHA256_RE.test(receipt.sha256) ||
    (reference.digest !== undefined && receipt.sha256 !== reference.digest.hex) ||
    typeof receipt.expiresAt !== 'string' ||
    receipt.expiresAt.length > 32 ||
    !Number.isFinite(Date.parse(receipt.expiresAt)) ||
    Date.parse(receipt.expiresAt) <= Date.now() ||
    source.kind !== 'gfs' ||
    source.drive !== reference.source.drive ||
    source.resourceId !== normalizeRid(reference.source.resourceId) ||
    source.gfsUri !== reference.source.gfsUri ||
    source.version !== reference.source.version ||
    typeof source.name !== 'string' ||
    source.name.length === 0 ||
    source.name.length > 1024 ||
    usage.pathSemantics !== 'relative-to-caller-workspace' ||
    usage.nextTool !== 'shell_exec_when_local_processing_is_needed' ||
    usage.visualDelivery !== 'not_included' ||
    usage.approval !== 'user-approval-required' ||
    usage.writeOutputsTo !== 'outputs/' ||
    usage.processLocally !== true ||
    usage.boundedOutputOnly !== true ||
    usage.wholeFileToContextAllowed !== false
  )
    return undefined
  // Explicit projection excludes unexpected bytes, image parts and transport data.
  const projectedUsage: PreparedGfsUsage = {
    pathSemantics: 'relative-to-caller-workspace',
    nextTool: 'shell_exec_when_local_processing_is_needed',
    visualDelivery: 'not_included',
    approval: 'user-approval-required',
    writeOutputsTo: 'outputs/',
    processLocally: true,
    boundedOutputOnly: true,
    wholeFileToContextAllowed: false,
    // Publish our trusted instructions, never instruction text from a tool result.
    processingInstructions: GFS_LOCAL_PROCESSING_GUIDANCE,
  }
  return {
    referenceId: reference.id,
    status: 'ready',
    receipt: {
      delivery: 'workspace_file',
      id: receipt.id,
      path: receipt.path,
      sizeBytes: reference.byteLength,
      sha256: receipt.sha256,
      expiresAt: receipt.expiresAt,
      source: {
        kind: 'gfs',
        drive: reference.source.drive,
        resourceId: source.resourceId as string,
        gfsUri: reference.source.gfsUri,
        version: reference.source.version,
        name: source.name,
      },
      usage: projectedUsage,
    },
  }
}

/** Use the cached, caller-bound native tool and its effective approval gate. */
export async function prepareGfsFiles(
  resolutions: readonly FileReferenceResolution[],
  context: {
    config: LoopConfig
    callerIdentity?: string
    toolTimeoutMs: number
    budget: Pick<TaskExecutionBudget, 'assertTime' | 'remainingDurationMs'>
  }
): Promise<PreparedGfsFile[]> {
  if (resolutions.length > FILE_REFERENCE_MAX_COUNT)
    throw new Error('Too many GFS file references to prepare')
  const prepared: PreparedGfsFile[] = []
  for (const { availability, reference, surfaces } of resolutions) {
    if (
      availability !== 'available' ||
      reference.source.kind !== 'gfs' ||
      reference.byteLength <= GFS_FILE_LIMITS.inlineTextBytes
    )
      continue
    context.config.abortSignal?.throwIfAborted()
    context.budget.assertTime()
    const unavailable = (code: GfsPreparationFailure): PreparedGfsFile => ({
      referenceId: reference.id,
      status: 'unavailable',
      code,
    })
    const tool = context.config.toolRegistry.get(DOWNLOAD_TOOL)
    if (!context.callerIdentity || surfaces?.workspace !== true || !tool) {
      prepared.push(unavailable('workspace_unavailable'))
      continue
    }
    const params = {
      drive: reference.source.drive,
      resourceId: reference.source.resourceId,
      expectedVersion: reference.source.version,
    }
    const timeoutMs = Math.max(
      1,
      Math.floor(Math.min(context.toolTimeoutMs, context.budget.remainingDurationMs))
    )
    try {
      const admission = await admitToolCall(
        { id: randomUUID(), name: DOWNLOAD_TOOL, arguments: params },
        context.config,
        0
      )
      if (admission.kind !== 'execute') {
        prepared.push(
          unavailable(admission.kind === 'result' ? 'policy_denied' : 'approval_required')
        )
        continue
      }
      const boundedConfig: LoopConfig = {
        ...context.config,
        toolTimeout: Math.min(context.config.toolTimeout, timeoutMs),
      }
      const toolResult = await executeAdmittedTool(admission, boundedConfig, 0)
      const output: ToolOutput = {
        content: toolResult.content,
        duration_ms: 0,
        is_error: toolResult.is_error ?? false,
        attachments: toolResult.attachments,
      }
      context.config.abortSignal?.throwIfAborted()
      context.budget.assertTime()
      prepared.push(
        output.is_error
          ? unavailable(failureCode(output.content))
          : (checkedPreparation(output, reference) ?? unavailable('invalid_response'))
      )
    } catch {
      context.config.abortSignal?.throwIfAborted()
      context.budget.assertTime()
      prepared.push(unavailable('download_failed'))
    }
  }
  return prepared
}
