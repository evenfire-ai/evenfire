import { vi } from 'vitest'

/** Shared log filter for the no-op-gate suites. Every needle must match. */
export function updatedLogs(log: ReturnType<typeof vi.spyOn>, ...needles: string[]): string[] {
  return log.mock.calls
    .map((call: unknown[]) => String(call[0]))
    .filter((line: string) => needles.every(needle => line.includes(needle)))
}
