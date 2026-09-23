import {
  buildCodexProxyEnvelope,
  parseCodexCompletionRequest,
} from '@clerum/llm-provider-attempt-contract'

export const CODEX_PROXY_COMPLETIONS_PATH = '/internal/runtime/v1/codex/completions'

export class CodexProxyError extends Error {
  /**
   * `dispatched` records whether a request had already left this process when
   * the error was raised. It defaults to `true` because every construction
   * site except the pre-stream abort happens after the fetch was issued, and
   * the safe default is the one that keeps the attempt fenced.
   */
  constructor(
    readonly code: string,
    message: string,
    readonly dispatched: boolean = true
  ) {
    super(message)
    this.name = 'CodexProxyError'
  }
}

export type CodexProxyFrame =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown> }
  | {
      type: 'done'
      outcome: 'success' | 'canceled' | 'error' | 'unknown'
      usage?: { inputTokens: number; outputTokens: number }
    }
  | { type: 'error'; code: string }

export type CodexProxyStreamResult = {
  text: string
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
  outcome: 'success' | 'canceled' | 'error' | 'unknown'
  /** Present only when the proxy forwarded real upstream token counts. */
  usage?: { inputTokens: number; outputTokens: number }
}

export type CodexLlmProxyClientOptions = {
  runtimeUrl: string
  readPlatformJwt: () => string
  refreshOnUnauthorized?: () => Promise<void>
  fetchFn?: typeof fetch
}

export class CodexLlmProxyClient {
  constructor(private readonly options: CodexLlmProxyClientOptions) {
    if (!options.runtimeUrl.startsWith('http://') && !options.runtimeUrl.startsWith('https://')) {
      throw new Error('[CodexProxy] runtime URL must be an absolute server-owned URL')
    }
  }

  async stream(input: {
    executionTicket: string
    requestHash: string
    request: unknown
    deadlineMs?: number
    signal?: AbortSignal
  }): Promise<CodexProxyStreamResult> {
    if (input.signal?.aborted) {
      throw new CodexProxyError('canceled', 'aborted before proxy stream', false)
    }
    return this.streamOnce(input, Boolean(this.options.refreshOnUnauthorized))
  }

  private async streamOnce(
    input: {
      executionTicket: string
      requestHash: string
      request: unknown
      deadlineMs?: number
      signal?: AbortSignal
    },
    retryOnUnauthorized: boolean
  ): Promise<CodexProxyStreamResult> {
    let body: unknown = {
      executionTicket: input.executionTicket,
      requestHash: input.requestHash,
      request: input.request,
      ...(input.deadlineMs !== undefined ? { deadlineMs: input.deadlineMs } : {}),
    }
    if (
      (input.request as { schemaVersion?: string } | null)?.schemaVersion ===
      'codex-completion-request.v2'
    ) {
      const parsed = parseCodexCompletionRequest(input.request)
      if (!parsed.ok) throw new CodexProxyError('invalid_request', parsed.message, false)
      if (input.deadlineMs !== undefined && input.deadlineMs !== parsed.value.deadlineMs) {
        throw new CodexProxyError(
          'invalid_request',
          'Codex deadline must match the authorized request',
          false
        )
      }
      const envelope = buildCodexProxyEnvelope({
        executionTicket: input.executionTicket,
        requestHash: input.requestHash,
        request: parsed.value,
      })
      if (!envelope.ok) {
        const code =
          envelope.code === 'limit'
            ? 'payload_too_large'
            : envelope.code === 'request_hash_mismatch'
              ? 'request_hash_mismatch'
              : 'invalid_request'
        throw new CodexProxyError(code, envelope.message, false)
      }
      body = envelope.value
    }
    const jwt = this.options.readPlatformJwt()
    const fetchFn = this.options.fetchFn ?? fetch
    const response = await fetchFn(this.options.runtimeUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${jwt}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: input.signal,
    })
    if (!response.ok) {
      if (response.status === 401 && retryOnUnauthorized && this.options.refreshOnUnauthorized) {
        await this.options.refreshOnUnauthorized()
        return this.streamOnce(input, false)
      }
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>
      const code =
        response.status === 413
          ? 'payload_too_large'
          : typeof payload.error === 'string'
            ? payload.error
            : 'provider_unavailable'
      throw new CodexProxyError(
        code,
        code === 'payload_too_large'
          ? 'Codex request is too large; use fewer or smaller images, or reduce context'
          : `proxy stream failed with ${response.status} (${code})`
      )
    }
    if (!response.body) {
      throw new CodexProxyError('provider_unavailable', 'proxy stream had no body')
    }
    return readProxySse(response.body)
  }
}

export function resolveCodexProxyRuntimeUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, '')
  if (trimmed.endsWith(CODEX_PROXY_COMPLETIONS_PATH)) return trimmed
  return `${trimmed}${CODEX_PROXY_COMPLETIONS_PATH}`
}

async function readProxySse(body: ReadableStream<Uint8Array>): Promise<CodexProxyStreamResult> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  const toolCalls: CodexProxyStreamResult['toolCalls'] = []
  let outcome: CodexProxyStreamResult['outcome'] = 'unknown'
  let usage: CodexProxyStreamResult['usage']
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      const line = part.split('\n').find(entry => entry.startsWith('data: '))
      if (!line) continue
      const frame = JSON.parse(line.slice(6)) as CodexProxyFrame
      if (frame.type === 'error') {
        throw new CodexProxyError(frame.code, `proxy stream failed with ${frame.code}`)
      }
      if (frame.type === 'text') text += frame.text
      if (frame.type === 'tool_call') toolCalls.push(frame)
      if (frame.type === 'done') {
        outcome = frame.outcome
        if (frame.usage) usage = frame.usage
      }
    }
  }
  return { text, toolCalls, outcome, ...(usage ? { usage } : {}) }
}
