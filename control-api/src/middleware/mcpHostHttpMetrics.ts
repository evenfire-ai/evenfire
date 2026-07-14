import { NextFunction, Request, Response } from 'express'
import { mcpHostHttpDurationSeconds, mcpHostHttpTotal } from '../observability/metrics.js'

/**
 * HTTP instrumentation for mcp-host endpoints.
 *
 * Emits per-response:
 *   - mcp_host_http_total{route, method, status_code}
 *   - mcp_host_http_duration_seconds{route, method, status_code}
 *
 * Also emits structured logs for:
 *   - 5xx responses (always)
 *   - 4xx except routine 401 (we log 401 at INFO level via `auth_denied` in
 *     the handlers themselves; here we don't double-log).
 *
 * `routeLabel` is supplied explicitly to avoid the cardinality explosion that
 * `req.route?.path` would cause on unmatched URLs.
 */
export function mcpHostHttpMetrics(routeLabel: string) {
  return function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
    const start = process.hrtime.bigint()

    res.on('finish', () => {
      const durationSec = Number(process.hrtime.bigint() - start) / 1e9
      const labels = {
        route: routeLabel,
        method: req.method,
        status_code: String(res.statusCode),
      }
      mcpHostHttpTotal.inc(labels, 1)
      mcpHostHttpDurationSeconds.observe(labels, durationSec)

      const status = res.statusCode
      const log = req.log
      if (!log) return
      if (status >= 500) {
        log.error(
          {
            event: 'http_response_5xx',
            route: routeLabel,
            method: req.method,
            status,
            durationSec,
          },
          'mcp-host 5xx'
        )
      } else if (status >= 400 && status !== 401) {
        log.warn(
          {
            event: 'http_response_4xx',
            route: routeLabel,
            method: req.method,
            status,
            durationSec,
          },
          'mcp-host 4xx'
        )
      }
    })

    next()
  }
}
