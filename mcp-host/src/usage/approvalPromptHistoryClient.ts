export type ApprovalPromptHistoryCapture = {
  approvalRequestId: string
  runId: string
  hostRef: string
  sessionId: string
  origin: 'direct_chat' | 'channel_event' | 'api'
  prompt: string
}

export type ApprovalPromptHistoryClientOptions = {
  baseUrl: string
  getAccessToken: () => string
  refreshOnUnauthorized?: () => Promise<void>
  enabled?: boolean
  maxBytes?: number
  fetchImpl?: typeof fetch
}

function redact(prompt: string, values: readonly string[]): string {
  let output = prompt
  for (const value of [...new Set(values.filter(item => item.length >= 4))].sort(
    (left, right) => right.length - left.length
  )) {
    output = output.split(value).join('[REDACTED]')
  }
  const scheme = ['Bea', 'rer|Ba', 'sic'].join('')
  return output.replace(
    new RegExp(`\\b(?:${scheme})\\s+[A-Za-z0-9._~+\\/-]+=*`, 'gi'),
    '[REDACTED]'
  )
}

export class ApprovalPromptHistoryClient {
  private readonly enabled: boolean
  private readonly maxBytes: number
  private readonly fetchImpl: typeof fetch
  private readonly url: string

  constructor(private readonly options: ApprovalPromptHistoryClientOptions) {
    this.enabled = options.enabled === true
    this.maxBytes = options.maxBytes ?? 16_384
    this.fetchImpl = options.fetchImpl ?? fetch
    this.url = `${options.baseUrl.replace(/\/+$/, '')}/api/v1/internal/tracing/approval-prompt-history`
  }

  async capture(
    input: ApprovalPromptHistoryCapture,
    protectedValues: readonly string[] = []
  ): Promise<'captured' | 'disabled' | 'rejected' | 'unavailable'> {
    if (!this.enabled) return 'disabled'
    if (!Number.isInteger(this.maxBytes) || this.maxBytes < 1_024 || this.maxBytes > 32_768) {
      return 'unavailable'
    }
    const prompt = redact(input.prompt, protectedValues)
    const bytes = Buffer.byteLength(prompt, 'utf8')
    if (bytes === 0 || bytes > this.maxBytes) return 'rejected'
    try {
      let response = await this.post({ ...input, prompt })
      if (response.status === 401 && this.options.refreshOnUnauthorized) {
        await this.options.refreshOnUnauthorized()
        response = await this.post({ ...input, prompt })
      }
      if (response.ok) return 'captured'
      return response.status >= 400 && response.status < 500 ? 'rejected' : 'unavailable'
    } catch {
      return 'unavailable'
    }
  }

  private post(input: ApprovalPromptHistoryCapture): Promise<Response> {
    return this.fetchImpl(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.options.getAccessToken()}`,
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(1_000),
    })
  }
}
