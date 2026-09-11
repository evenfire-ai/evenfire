/**
 * Redact common secret shapes from a free-text diagnostic string before it
 * crosses a trust boundary. Shared by llmPortAdapter's provider-error
 * diagnostics and the `on_error` hook projection (§8.1) — a single source so the
 * two cannot drift.
 */
export function redactDiagnosticField(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/gi, 'sk-[redacted]')
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|secret)=([^\s,;]+)/gi,
      '$1=[redacted]'
    )
}
