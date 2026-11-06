import pino from 'pino'
import { statusMessageOf } from '../http/k8sError.js'
import { TOKEN_LEAK_REDACT_PATHS } from '../utils/log/redact.js'

/**
 * Serializer for the `err` log field. A @kubernetes/client-node ApiException
 * builds its `.message` (and so its `.stack`) from the full apiserver response,
 * every response header included (Audit-Id, x-kubernetes-pf-*), so the standard
 * serializer would write those headers to the log. Such an error is logged as
 * its name, HTTP status and metav1.Status message only; any other error keeps
 * pino's standard serialization.
 */
export function serializeLogError(err: unknown): unknown {
  if (
    err instanceof Error &&
    'body' in err &&
    'headers' in err &&
    typeof (err as { headers?: unknown }).headers === 'object' &&
    (err as { headers?: unknown }).headers !== null
  ) {
    const code = (err as { code?: unknown }).code
    return {
      type: err.name,
      status: typeof code === 'number' ? code : undefined,
      message: statusMessageOf(err) ?? `K8s error ${typeof code === 'number' ? code : 'unknown'}`,
    }
  }
  return err instanceof Error ? pino.stdSerializers.err(err) : err
}

/**
 * Root logger. Audit-only emission (4xx/5xx, denied attempts, approval
 * transitions, cron runs) — no per-request INFO.
 */
export const rootLogger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  base: { svc: 'control-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
  serializers: { err: serializeLogError },
  redact: {
    paths: [...TOKEN_LEAK_REDACT_PATHS],
    remove: true,
  },
})

export type Logger = typeof rootLogger
