import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import type { DocumentReadLimits } from './types'

const MIB = 1_048_576

// Reserve room for the Host's own concurrent growth, including growth between
// 25 ms samples. The transient IPC copies are accounted for separately below.
export const DOCUMENT_CGROUP_MARGIN_BYTES = 64 * MIB
// One job's transient Host-side copies: the base64 source decode (11 MiB), the
// job serialization (11 MiB), the received outcome (32 MiB), the control
// re-serialization (32 MiB) and the base64 of a 20 MiB PNG (27 MiB). Estimated
// from the specified caps, not measured.
export const DOCUMENT_IPC_RESERVE_BYTES = 113 * MIB
// Cross-architecture drift around the measured child VmData. It is added to
// each per-architecture reserve below and also discounted from the cgroup
// headroom: the reserve is part of RLIMIT_DATA, so an admission that ignored
// it would grant resident room the container does not have. A 2048 MiB
// container with a 1113 MiB working set only has 935 MiB left, and the reserve
// would let a reader claim more than that before the RLIMIT_DATA ceiling binds.
export const DOCUMENT_VIRTUAL_DRIFT_RESERVE_BYTES = 128 * MIB

/**
 * The non-resident part of the child's base VmData that RLIMIT_DATA must also
 * admit: V8's code-range/pointer-cage reservations, native mappings and shared
 * libraries, measured with the worker idle after loading its modules in the
 * pinned `node:24.16.0-alpine@sha256:21f403…` image:
 *
 * - x64: VmData 2052 MiB, RSS 89 MiB, so V = 1963 MiB.
 * - arm64: VmData 1348 MiB, RSS 66 MiB, so V = 1282 MiB.
 *
 * `DOCUMENT_VIRTUAL_DRIFT_RESERVE_BYTES` is added to both. The amd64 figure
 * was measured through Rosetta, so CI amd64 (G1) is the durable confirmation
 * of this reserve. Too small starves legitimate reads with allocation
 * failures; too large weakens the resident bound by the excess. An
 * uncalibrated architecture has no reserve, and Linux refuses to spawn rather
 * than guess one.
 */
export function childVirtualReserveBytes(arch: string): number | null {
  switch (arch) {
    case 'x64':
      return (1_963 + 128) * MIB
    case 'arm64':
      return (1_282 + 128) * MIB
    default:
      return null
  }
}

// V8's old-space cap excludes Node, pdfjs/canvas, buffers and decoded images.
export const DOCUMENT_NATIVE_ALLOWANCE_BYTES = 64 * MIB
// Admission requires at least 64 MiB of heap plus the native allowance.
export const DOCUMENT_MIN_RESIDENT_BYTES = 128 * MIB

export interface DocumentCgroupMemory {
  maxBytes: number | null
  currentBytes: number
  /** File-backed pages on the inactive LRU: reclaimable page cache. */
  inactiveFileBytes: number
}

function memoryBytes(value: string): number {
  const text = value.trim()
  const bytes = Number(text)
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error('Document reader cgroup memory unavailable')
  }
  return bytes
}

/** One flat-keyed `memory.stat` counter; a missing or duplicated key is a defect. */
function statBytes(stat: string, key: string): number {
  let value: number | undefined
  for (const line of stat.split('\n')) {
    const match = /^([a-z_]+) (\S+)$/.exec(line)
    if (match?.[1] !== key) continue
    if (value !== undefined) throw new Error('Document reader cgroup memory unavailable')
    value = memoryBytes(match[2]!)
  }
  if (value === undefined) throw new Error('Document reader cgroup memory unavailable')
  return value
}

/**
 * The kubelet working set: `memory.current` minus file pages on the inactive
 * LRU. Those pages are reclaimable cache, so counting them as used refuses
 * readers on a warm Host whose anonymous memory is small. `file` is not
 * subtracted because it includes shmem, and `active_file` is not subtracted
 * because kubelet counts it. `memory.current` and `memory.stat` are separate
 * reads, so a concurrent write can grow inactive_file past the earlier current
 * snapshot; the clamp keeps that race from becoming a defect (cadvisor does the
 * same).
 */
export function documentCgroupWorkingSetBytes(memory: DocumentCgroupMemory): number {
  return Math.max(0, memory.currentBytes - memory.inactiveFileBytes)
}

/**
 * Linux requires a readable unified cgroup-v2 memory controller. A v1,
 * missing or malformed controller is an infrastructure defect: without a
 * measured bound we cannot protect the Host, and must never remove the cap.
 * macOS has no cgroup and retains the configured heap/RSS limits.
 */
export function documentCgroupSampler(
  platform: NodeJS.Platform,
  membershipFile = '/proc/self/cgroup',
  cgroupRoot = '/sys/fs/cgroup'
): () => Promise<DocumentCgroupMemory | null> {
  if (platform === 'darwin') return async () => null
  if (platform !== 'linux') throw new Error('Document reader cgroup memory unavailable')
  return async () => {
    try {
      const membership = await readFile(membershipFile, 'utf8')
      const unified = /^0::(\/[^\r\n]*)$/m.exec(membership)
      if (!unified || unified[1].split('/').includes('..')) {
        throw new Error('Document reader cgroup memory unavailable')
      }
      const root = resolve(cgroupRoot)
      const directory = resolve(root, '.' + unified[1])
      if (directory !== root && !directory.startsWith(root + sep)) {
        throw new Error('Document reader cgroup memory unavailable')
      }
      const [maximum, current, stat] = await Promise.all([
        readFile(resolve(directory, 'memory.max'), 'utf8'),
        readFile(resolve(directory, 'memory.current'), 'utf8'),
        readFile(resolve(directory, 'memory.stat'), 'utf8'),
      ])
      const maxBytes = maximum.trim() === 'max' ? null : memoryBytes(maximum)
      return {
        maxBytes,
        currentBytes: memoryBytes(current),
        inactiveFileBytes: statBytes(stat, 'inactive_file'),
      }
    } catch {
      // File errors are fixed-message defects and cannot expose Host paths.
      throw new Error('Document reader cgroup memory unavailable')
    }
  }
}

export interface DocumentMemoryCaps {
  maxResidentBytes: number
  maxHeapMb: number
}

/** null means measured/configured headroom is too small to start a reader. */
export function effectiveDocumentMemoryCaps(
  limits: Pick<DocumentReadLimits, 'maxResidentMb' | 'maxHeapMb'>,
  cgroup: DocumentCgroupMemory | null
): DocumentMemoryCaps | null {
  const configuredResidentBytes = limits.maxResidentMb * MIB
  if (cgroup?.maxBytes === null || cgroup === null) {
    return { maxResidentBytes: configuredResidentBytes, maxHeapMb: limits.maxHeapMb }
  }
  const headroom =
    cgroup.maxBytes -
    documentCgroupWorkingSetBytes(cgroup) -
    DOCUMENT_CGROUP_MARGIN_BYTES -
    DOCUMENT_IPC_RESERVE_BYTES -
    DOCUMENT_VIRTUAL_DRIFT_RESERVE_BYTES
  const maxResidentBytes = Math.min(configuredResidentBytes, headroom)
  const maxHeapMb = Math.min(
    limits.maxHeapMb,
    Math.floor((maxResidentBytes - DOCUMENT_NATIVE_ALLOWANCE_BYTES) / MIB)
  )
  if (maxResidentBytes < DOCUMENT_MIN_RESIDENT_BYTES || maxHeapMb < 64) return null
  return { maxResidentBytes, maxHeapMb }
}

/**
 * The closed list of allocation failures that mean a memory ceiling, not a
 * document defect: V8's fatal allocation flag, the RangeError messages Node
 * and the platform raise for a failed buffer, and the wrapper pdf.js uses.
 * A wrapper may carry the original error as `cause` up to three levels deep.
 * This module is the shared, side-effect-free memory boundary for both the
 * worker and `pdfLoad.ts`.
 */
export function isAllocationError(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth <= 3; depth += 1) {
    if (!(current instanceof Error)) return false
    if ((current as NodeJS.ErrnoException).code === 'ERR_MEMORY_ALLOCATION_FAILED') return true
    if (
      current.name === 'RangeError' &&
      (current.message === 'Array buffer allocation failed' ||
        current.message === 'Failed to allocate memory')
    ) {
      return true
    }
    if (
      current.name === 'UnknownErrorException' &&
      (current.message.includes('allocation failed') ||
        current.message.includes('Failed to allocate memory'))
    ) {
      return true
    }
    current = current.cause
  }
  return false
}
