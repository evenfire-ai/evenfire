import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import type { DocumentReadLimits } from './types'

const MIB = 1_048_576

// Reserve room for the Host's concurrent growth and the bounded source/outcome
// IPC copies (11 MiB + 32 MiB), including growth between 25 ms samples.
export const DOCUMENT_CGROUP_MARGIN_BYTES = 64 * MIB
// V8's old-space cap excludes Node, pdfjs/canvas, buffers and decoded images.
export const DOCUMENT_NATIVE_ALLOWANCE_BYTES = 64 * MIB
// Admission requires at least 64 MiB of heap plus the native allowance.
export const DOCUMENT_MIN_RESIDENT_BYTES = 128 * MIB

export interface DocumentCgroupMemory {
  maxBytes: number | null
  currentBytes: number
}

function memoryBytes(value: string): number {
  const text = value.trim()
  const bytes = Number(text)
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error('Document reader cgroup memory unavailable')
  }
  return bytes
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
      const [maximum, current] = await Promise.all([
        readFile(resolve(directory, 'memory.max'), 'utf8'),
        readFile(resolve(directory, 'memory.current'), 'utf8'),
      ])
      const maxBytes = maximum.trim() === 'max' ? null : memoryBytes(maximum)
      return { maxBytes, currentBytes: memoryBytes(current) }
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
  const headroom = cgroup.maxBytes - cgroup.currentBytes - DOCUMENT_CGROUP_MARGIN_BYTES
  const maxResidentBytes = Math.min(configuredResidentBytes, headroom)
  const maxHeapMb = Math.min(
    limits.maxHeapMb,
    Math.floor((maxResidentBytes - DOCUMENT_NATIVE_ALLOWANCE_BYTES) / MIB)
  )
  if (maxResidentBytes < DOCUMENT_MIN_RESIDENT_BYTES || maxHeapMb < 64) return null
  return { maxResidentBytes, maxHeapMb }
}
