export const GROK_PROXY_COMPLETIONS_PATH = '/internal/runtime/v1/grok/completions'

export class GrokProxyError extends Error {
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
    this.name = 'GrokProxyError'
  }
}

export type GrokProxyFrame =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown> }
  | {
      type: 'done'
      outcome: 'success' | 'canceled' | 'error' | 'unknown'
      usage?: { inputTokens: number; outputTokens: number }
    }
  | { type: 'error'; code: string }

export type GrokProxyStreamResult = {
  text: string
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
  outcome: 'success' | 'canceled' | 'error' | 'unknown'
  /** Present only when the proxy forwarded real upstream token counts. */
  usage?: { inputTokens: number; outputTokens: number }
}

export type GrokLlmProxyClientOptions = {
  runtimeUrl: string
  readPlatformJwt: () => string
  refreshOnUnauthorized?: () => Promise<void>
  fetchFn?: typeof fetch
}

export class GrokLlmProxyClient {
  constructor(private readonly options: GrokLlmProxyClientOptions) {
    if (!options.runtimeUrl.startsWith('http://') && !options.runtimeUrl.startsWith('https://')) {
      throw new Error('[GrokProxy] runtime URL must be an absolute server-owned URL')
    }
  }

  async stream(input: {
    executionTicket: string
    requestHash: string
    request: unknown
    deadlineMs?: number
    signal?: AbortSignal
  }): Promise<GrokProxyStreamResult> {
    if (input.signal?.aborted) {
      throw new GrokProxyError('canceled', 'aborted before proxy stream', false)
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
  ): Promise<GrokProxyStreamResult> {
    const jwt = this.options.readPlatformJwt()
    const fetchFn = this.options.fetchFn ?? fetch
    const response = await fetchFn(this.options.runtimeUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${jwt}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        executionTicket: input.executionTicket,
        requestHash: input.requestHash,
        request: input.request,
        ...(input.deadlineMs !== undefined ? { deadlineMs: input.deadlineMs } : {}),
      }),
      signal: input.signal,
    })
    if (!response.ok) {
      if (response.status === 401 && retryOnUnauthorized && this.options.refreshOnUnauthorized) {
        await this.options.refreshOnUnauthorized()
        return this.streamOnce(input, false)
      }
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>
      const code = typeof payload.error === 'string' ? payload.error : 'provider_unavailable'
      throw new GrokProxyError(code, `proxy stream failed with ${response.status} (${code})`)
    }
    if (!response.body) {
      throw new GrokProxyError('provider_unavailable', 'proxy stream had no body')
    }
    return readProxySse(response.body)
  }
}

export function resolveGrokProxyRuntimeUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, '')
  if (trimmed.endsWith(GROK_PROXY_COMPLETIONS_PATH)) return trimmed
  return `${trimmed}${GROK_PROXY_COMPLETIONS_PATH}`
}

async function readProxySse(body: ReadableStream<Uint8Array>): Promise<GrokProxyStreamResult> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  const toolCalls: GrokProxyStreamResult['toolCalls'] = []
  let outcome: GrokProxyStreamResult['outcome'] = 'unknown'
  let usage: GrokProxyStreamResult['usage']
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      const line = part.split('\n').find(entry => entry.startsWith('data: '))
      if (!line) continue
      const frame = JSON.parse(line.slice(6)) as GrokProxyFrame
      if (frame.type === 'error') {
        throw new GrokProxyError(frame.code, `proxy stream failed with ${frame.code}`)
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
