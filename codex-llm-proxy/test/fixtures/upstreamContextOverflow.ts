// The two SSE events the Codex upstream sends when a request exceeds the
// model's context window. Recorded on 2026-09-23 with `codex exec` 0.154.0
// against `gpt-5.6-luna` over HTTPS (1,040,000 CJK characters of input); the
// trace was filtered to these events, so no message text or account data is
// kept. #731: the proxy used to discard the code and answer 503.
export const UPSTREAM_CONTEXT_ERROR_EVENT = {
  type: 'error',
  error: {
    type: 'invalid_request_error',
    code: 'context_length_exceeded',
    param: 'input',
  },
}

export const UPSTREAM_CONTEXT_FAILED_EVENT = {
  type: 'response.failed',
  response: { status: 'failed', error: { code: 'context_length_exceeded' } },
}

export function sseFrame(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

export const UPSTREAM_CONTEXT_OVERFLOW_FRAMES = [
  sseFrame(UPSTREAM_CONTEXT_ERROR_EVENT),
  sseFrame(UPSTREAM_CONTEXT_FAILED_EVENT),
]
