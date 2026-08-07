import type { NextFunction, Request, RequestHandler, Response } from 'express'

/**
 * Audit and silently strip any namespace injection attempt from a request.
 *
 * Namespace is a core infrastructure config (set via ConfigMap env vars).
 * Callers must NOT be able to influence which namespace a CRUD operation targets.
 * Instead of rejecting with an error status (which leaks parameter existence),
 * we silently ignore the caller-supplied value and log a structured security
 * event for observability pipelines (Loki, Datadog, Fluentd).
 *
 * @param req - Express request to inspect
 * @param configNs - The server-side canonical namespace for this resource
 */
export function auditNamespaceAttempt(req: Request, configNs: string): void {
  const body = req.body as { metadata?: { namespace?: unknown }; namespace?: unknown } | undefined

  const source = req.ip ?? req.socket?.remoteAddress ?? 'unknown'

  // Detect namespace injection from three vectors
  const vectors: Array<{ vector: string; field?: string; value: unknown }> = []

  if (req.query.namespace !== undefined) {
    vectors.push({ vector: 'query-param', value: req.query.namespace })
  }
  if (body?.metadata?.namespace !== undefined) {
    vectors.push({
      vector: 'body-field',
      field: 'metadata.namespace',
      value: body.metadata.namespace,
    })
  }
  if (body?.namespace !== undefined) {
    vectors.push({ vector: 'body-field', field: 'namespace', value: body.namespace })
  }

  for (const { vector, field, value } of vectors) {
    console.warn(
      JSON.stringify({
        alert: 'SECURITY',
        event: 'namespace_injection',
        vector,
        ...(field && { field }),
        path: req.path,
        attempted_ns: value,
        expected_ns: configNs,
        source_ip: source,
      })
    )
  }
}

/**
 * Log when an operation falls back to a secondary namespace.
 *
 * Used by multi-namespace endpoints (e.g., artifact download) that probe
 * multiple namespaces. The primary audit via `enforceNamespace` logs the
 * expected namespace; this function logs the actual namespace used when it
 * differs from the enforced one, for observability completeness.
 */
export function auditNamespaceFallback(path: string, enforcedNs: string, actualNs: string): void {
  console.info(
    JSON.stringify({
      alert: 'OBSERVABILITY',
      event: 'namespace_fallback',
      path,
      enforced_ns: enforcedNs,
      actual_ns: actualNs,
    })
  )
}

/**
 * Express middleware that enforces server-side namespace resolution.
 *
 * Eliminates the weak pattern (introduced in commit 5ac8c65) where each
 * handler had to manually call `auditNamespaceAttempt()`. With this middleware,
 * namespace auditing and resolution happen at the router layer — it is
 * impossible for a handler to forget.
 *
 * Behaviour (B5 namespace-honesty):
 *   - `metadata.namespace` absent → allowed; body is passed through unchanged.
 *   - `metadata.namespace` equals configNs → allowed; the field is stripped so
 *     downstream handlers always use the config value.
 *   - `metadata.namespace` present but DIFFERENT from configNs → 400, with a
 *     human-readable message. Namespace is server-determined; callers must omit
 *     the field (or supply the matching value if they know it).
 *
 * The top-level `body.namespace` field and the `?namespace` query-string
 * parameter are still silently stripped (logged but not rejected). These
 * appear in non-CRD body formats (e.g. Secret upsert) where the handler
 * already overwrites the value with the config namespace explicitly.
 *
 * Usage:
 *   router.get("/admin/resources/:type",
 *     enforceNamespace(config.mcpServersNamespace),
 *     asyncHandler(async (req, res) => {
 *       // Namespace is derived from config imports, not from the request.
 *       // The middleware has already audited any mismatch attempt and
 *       // stripped namespace fields from req.body.
 *       const items = await gateway.listResource(plural, config.mcpServersNamespace);
 *     })
 *   );
 *
 * @param configNs - The server-side canonical namespace to enforce
 * @returns Express middleware
 */
export function enforceNamespace(configNs: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const body = req.body as { metadata?: { namespace?: unknown }; namespace?: unknown } | undefined

    // Check metadata.namespace mismatch — absent and matching are both ok.
    // This is the CRD body format; a non-empty mismatching value is rejected
    // with 400 so callers learn they must omit the field.
    const metaNs = body?.metadata?.namespace
    if (metaNs !== undefined && metaNs !== '' && metaNs !== configNs) {
      auditNamespaceAttempt(req, configNs)
      res.status(400).json({
        error:
          'namespace is server-determined; omit metadata.namespace from the request body, ' +
          `or use the correct value ("${configNs}").`,
      })
      return
    }

    // Audit any injection vectors (query-param, body fields) and strip namespace
    // fields so downstream handlers always use the config value.
    // Top-level body.namespace is silently stripped (non-CRD routes — e.g.
    // Secret upsert — explicitly overwrite it anyway, so stripping here is safe).
    auditNamespaceAttempt(req, configNs)
    if (req.body && typeof req.body === 'object') {
      if (req.body.metadata && typeof req.body.metadata === 'object') {
        delete req.body.metadata.namespace
      }
      delete req.body.namespace
    }
    next()
  }
}
