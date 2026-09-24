import { vi } from 'vitest'
import * as logging from '../../observability/logger'

/** Observe the service logging boundary without replacing other log levels. */
export function captureLogger(level: 'info' | 'warn' | 'error') {
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
