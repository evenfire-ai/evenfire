import { vi } from 'vitest'

/** Shared log filter for the no-op-gate suites. Every needle must match. */
export function updatedLogs(log: ReturnType<typeof vi.spyOn>, ...needles: string[]): string[] {
  return log.mock.calls
    .map((call: unknown[]) => {
      const line = String(call[0])
      // Some untouched producers still use the legacy presentation. Project the
      // structured shared-helper event into the same test vocabulary so both
      // no-op and real-write assertions keep measuring actual emitted events.
      try {
        const entry = JSON.parse(line)
        if (entry.msg === 'Kubernetes resource updated' && typeof entry.description === 'string') {
          const suffix = entry.attempt > 1 ? ` (after ${entry.attempt} attempts)` : ''
          return `${entry.scope} Updated ${entry.description}${suffix}`
        }
      } catch {
        /* Legacy plain-text producer. */
      }
      return line
    })
    .filter((line: string) => needles.every(needle => line.includes(needle)))
}
