import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * One sample of a reader child. `vmDataBytes` is the non-resident part of the
 * address space that RLIMIT_DATA also counts; it is null while the address
 * space is being released, and on platforms without procfs.
 */
export interface ResidentMemorySample {
  rssBytes: number
  vmDataBytes: number | null
}

/**
 * Both callers sample every 25 ms, so Linux derives RSS and VmData from the
 * same `/proc/<pid>/status` read instead of opening the file twice. Failure
 * never disables the resident-memory cap.
 */
export function residentMemorySampler(
  platform: NodeJS.Platform
): (pid: number) => Promise<ResidentMemorySample> {
  switch (platform) {
    case 'linux':
      return async pid => {
        const status = await readFile(`/proc/${pid}/status`, 'utf8')
        // A zombie has already released its resident pages; exit delivery can
        // race the sample while the parent still has the child's PID.
        if (/^State:\s+Z\b/m.test(status)) return { rssBytes: 0, vmDataBytes: null }
        // An exiting process releases its address space before it becomes a
        // zombie; in that window the kernel prints no Vm* lines at all.
        if (/^Name:/m.test(status) && /^State:/m.test(status) && !/^Vm/m.test(status)) {
          return { rssBytes: 0, vmDataBytes: null }
        }
        const rss = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status)
        if (!rss) throw new Error('Document reader resident memory unavailable')
        const vmData = /^VmData:\s+(\d+)\s+kB$/m.exec(status)
        return {
          rssBytes: kilobytesToBytes(rss[1]),
          vmDataBytes: vmData === null ? null : kilobytesToBytes(vmData[1]),
        }
      }
    case 'darwin':
      return async pid => {
        const { stdout } = await execFileAsync('/bin/ps', ['-o', 'rss=,stat=', '-p', String(pid)], {
          env: {},
          encoding: 'utf8',
          timeout: 1_000,
          maxBuffer: 1_024,
        })
        const sample = /^(\d+)\s+(\S+)$/.exec(stdout.trim())
        if (!sample) throw new Error('Document reader resident memory unavailable')
        if (sample[2].startsWith('Z')) return { rssBytes: 0, vmDataBytes: null }
        // macOS has no procfs, so it cannot report VmData from this sample.
        return { rssBytes: kilobytesToBytes(sample[1]), vmDataBytes: null }
      }
    default:
      throw new Error('Unsupported document reader resident memory platform')
  }
}

function kilobytesToBytes(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error('Document reader resident memory unavailable')
  const bytes = Number(value) * 1_024
  if (!Number.isSafeInteger(bytes)) {
    throw new Error('Document reader resident memory unavailable')
  }
  return bytes
}
