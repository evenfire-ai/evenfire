import { vi } from 'vitest'
import { rootLogger } from '../../src/observability/logger.js'

/**
 * Capture route logs. `req.log` is `rootLogger.child(...)` built per request,
 * so a runtime spy on `child` intercepts it without disturbing the module
 * loggers created at import time.
 */
export function captureRequestLogs() {
  const info = vi.fn()
  const warn = vi.fn()
  const debug = vi.fn()
  const fakeChild: Record<string, unknown> = {
    info,
    warn,
    error: vi.fn(),
    debug,
    trace: vi.fn(),
    fatal: vi.fn(),
  }
  fakeChild.child = () => fakeChild
  const spy = vi.spyOn(rootLogger, 'child').mockReturnValue(fakeChild as never)
  return { info, warn, debug, restore: () => spy.mockRestore() }
}
