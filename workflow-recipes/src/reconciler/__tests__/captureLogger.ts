import { type Mock, vi } from 'vitest'
import * as logging from '../../observability/logger'

type CapturedLevel = 'debug' | 'info' | 'warn' | 'error'

/** Observe the service logging boundary without replacing other log levels. */
export function captureLogger(level: CapturedLevel) {
  const original = logging.createLogger
  const calls = vi.fn()
  const factory = vi.spyOn(logging, 'createLogger').mockImplementation((...args) => ({
    ...original(...args),
    [level]: calls,
  }))
  calls.mockRestore = () => {
    factory.mockRestore()
  }
  return calls
}

/**
 * Observe several levels through one spy on the logger factory; a second
 * `captureLogger` call would replace the first one's implementation.
 */
export function captureLoggerLevels<L extends CapturedLevel>(
  levels: readonly L[]
): { calls: Record<L, Mock>; restore: () => void } {
  const original = logging.createLogger
  const calls = Object.fromEntries(levels.map(level => [level, vi.fn()])) as Record<L, Mock>
  const factory = vi.spyOn(logging, 'createLogger').mockImplementation((...args) => ({
    ...original(...args),
    ...calls,
  }))
  return { calls, restore: () => factory.mockRestore() }
}
