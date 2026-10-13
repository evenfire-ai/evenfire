import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Both samplers return bytes; failure never disables the resident-memory cap. */
export function residentMemorySampler(platform: NodeJS.Platform): (pid: number) => Promise<number> {
  switch (platform) {
    case 'linux':
      return async pid => {
        const status = await readFile(`/proc/${pid}/status`, 'utf8')
        // A zombie has already released its resident pages; exit delivery can
        // race the sample while the parent still has the child's PID.
        if (/^State:\s+Z\b/m.test(status)) return 0
        const rss = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status)
        if (!rss) throw new Error('Document reader resident memory unavailable')
        return kilobytesToBytes(rss[1])
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
        if (sample[2].startsWith('Z')) return 0
        return kilobytesToBytes(sample[1])
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
