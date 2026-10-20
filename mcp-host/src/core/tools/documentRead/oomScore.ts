import { writeFile } from 'node:fs/promises'

/**
 * Marks a reader child as the kernel's first OOM victim, so a container OOM
 * that the 25 ms sampled cap did not prevent kills the child, not the Host.
 * Raising a child's score needs no privilege. It does not help where
 * `memory.oom.group=1`: the kernel then kills every process in the cgroup.
 * macOS has no OOM score; its sampled resident cap is the only fence.
 */
export function oomVictimMarker(platform: NodeJS.Platform): (pid: number) => Promise<void> {
  switch (platform) {
    case 'linux':
      return pid => writeFile(`/proc/${pid}/oom_score_adj`, '1000')
    case 'darwin':
      return async () => undefined
    default:
      throw new Error('Unsupported document reader OOM platform')
  }
}
