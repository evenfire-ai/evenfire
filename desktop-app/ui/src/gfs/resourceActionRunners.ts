import {
  GFS_UPLOAD_NAME_EXHAUSTED_MESSAGE,
  GFS_UPLOAD_NAME_RETRY_LIMIT,
  gfsUploadNameRetryDecision,
  normalizeGfsResourceName,
} from '@clerum/gfs-interaction-policy'
import { isGfsSessionGeneration } from '@hooks/domain/queryKeys'
import { assertGfsFileUploadSize } from '@lib/gfsFileUpload'
import { isGfsSessionGenerationConfirmed } from '@lib/gfsSessionAuthority'
import type {
  GfsActionFolder,
  GfsActionResource,
  GfsActionRunResult,
  GfsActionRunnerDeps,
  GfsCreateFolderRunOptions,
  GfsUploadReservations,
} from './resourceActionRunners.types'

interface RunGuards {
  isCurrent: () => boolean
  admitEffect: () => Promise<boolean>
}

/**
 * Guards for one run, bound to the generation published when it started.
 * Revoking access does not change the generation, so the access flag is read
 * synchronously from the cache on every check: the owner's revocation effect
 * may not have rendered yet. Main switches generation before the renderer
 * publishes it, so the last word before a mutation is main's.
 */
function bindGuards(deps: GfsActionRunnerDeps): RunGuards | null {
  const originGen = deps.publishedGeneration()
  if (!isGfsSessionGeneration(originGen)) return null
  const isCurrent = () =>
    deps.publishedGeneration() === originGen &&
    deps.readAccessState() === 'active' &&
    (deps.isCurrent?.() ?? true)
  const admitEffect = async () =>
    isCurrent() &&
    (await isGfsSessionGenerationConfirmed(originGen, deps.publishedGeneration)) &&
    isCurrent()
  return isCurrent() ? { isCurrent, admitEffect } : null
}

const ABORTED = { status: 'aborted' } as const

export async function runGfsRename(
  deps: GfsActionRunnerDeps,
  target: GfsActionResource,
  requestedName: string
): Promise<GfsActionRunResult<{ name: string }>> {
  const trimmed = requestedName.trim()
  if (!trimmed) return ABORTED
  const guards = bindGuards(deps)
  if (!guards) return ABORTED
  if (!(await deps.freshPermissions(target.resourceId, target.name, ['write']))) return ABORTED
  if (!guards.isCurrent()) return ABORTED
  try {
    const name = await normalizeGfsResourceName(trimmed)
    if (!guards.isCurrent()) return ABORTED
    if (name === target.name) return { status: 'unchanged' }
    if (!(await deps.freshPermissions(target.resourceId, target.name, ['write']))) return ABORTED
    if (!(await guards.admitEffect())) return ABORTED
    await deps.ops.renameResource(target.resourceId, name, target.version)
    return { status: 'done', value: { name } }
  } catch (error) {
    return { status: 'failed', error }
  }
}

export async function runGfsCreateFolder(
  deps: GfsActionRunnerDeps,
  parent: GfsActionFolder,
  requestedName: string,
  options: GfsCreateFolderRunOptions = {}
): Promise<GfsActionRunResult<{ name: string }>> {
  const trimmed = requestedName.trim()
  if (!trimmed) return ABORTED
  const guards = bindGuards(deps)
  if (!guards) return ABORTED
  if (!(await deps.freshPermissions(parent.resourceId, parent.name, ['write']))) return ABORTED
  if (!guards.isCurrent()) return ABORTED
  options.onPermitted?.()
  try {
    const name = await normalizeGfsResourceName(trimmed)
    if (!guards.isCurrent()) return ABORTED
    if (!(await deps.freshPermissions(parent.resourceId, parent.name, ['write']))) return ABORTED
    if (!(await guards.admitEffect())) return ABORTED
    await deps.ops.createFolder(parent.resourceId, name)
    return { status: 'done', value: { name } }
  } catch (error) {
    return { status: 'failed', error }
  }
}

export async function runGfsDelete(
  deps: GfsActionRunnerDeps,
  target: GfsActionResource
): Promise<GfsActionRunResult> {
  const guards = bindGuards(deps)
  if (!guards) return ABORTED
  if (!(await deps.freshPermissions(target.resourceId, target.name, ['delete']))) return ABORTED
  if (!(await guards.admitEffect())) return ABORTED
  try {
    await deps.ops.deleteResource(target.resourceId, target.version)
    return { status: 'done', value: undefined }
  } catch (error) {
    return { status: 'failed', error }
  }
}

/**
 * Upload one local file, retrying under the next free name on a conflict.
 * Each retry is a new mutation, so each one re-proves permission and the
 * session before it is sent.
 */
export async function runGfsUpload(
  deps: GfsActionRunnerDeps,
  parent: GfsActionFolder,
  file: File,
  occupiedNames: Set<string>,
  reservations: GfsUploadReservations
): Promise<GfsActionRunResult<{ name: string }>> {
  const guards = bindGuards(deps)
  if (!guards) return ABORTED
  if (!(await deps.freshPermissions(parent.resourceId, parent.name, ['write']))) return ABORTED
  if (!guards.isCurrent()) return ABORTED
  try {
    assertGfsFileUploadSize(file.size)
    const normalizedName = await normalizeGfsResourceName(file.name)
    if (!guards.isCurrent()) return ABORTED
    const filePath = window.clerum.gfs.getPathForFile(file)
    if (!filePath) throw new Error('Could not resolve the selected local file')
    const nameReservation = reservations.begin(parent.resourceId, normalizedName, occupiedNames)
    try {
      for (let attempt = 0; attempt < GFS_UPLOAD_NAME_RETRY_LIMIT; attempt += 1) {
        const name = nameReservation.reserveNext()
        try {
          if (!(await deps.freshPermissions(parent.resourceId, parent.name, ['write']))) {
            return ABORTED
          }
          if (!(await guards.admitEffect())) return ABORTED
          await deps.ops.createFileFromPath(parent.resourceId, name, filePath)
          nameReservation.markSuccess(name)
          return { status: 'done', value: { name } }
        } catch (uploadError) {
          const decision = gfsUploadNameRetryDecision(uploadError, { attempt })
          if (decision === 'terminal') throw uploadError
          nameReservation.markConflict(name)
          if (decision === 'exhausted') throw new Error(GFS_UPLOAD_NAME_EXHAUSTED_MESSAGE)
        }
      }
      throw new Error(GFS_UPLOAD_NAME_EXHAUSTED_MESSAGE)
    } finally {
      nameReservation.release()
    }
  } catch (error) {
    return { status: 'failed', error }
  }
}
