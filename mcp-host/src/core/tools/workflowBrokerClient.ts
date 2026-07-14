import type { EnvGetter } from './workflowShared'
import { trimTrailingSlash } from './workflowShared'
import type { WorkflowControlTokenProvider } from './workflowTokenProvider'

export class WorkflowBrokerClient {
  private readonly tokenProvider: WorkflowControlTokenProvider

  constructor(
    private readonly getEnv: EnvGetter,
    tokenProvider: WorkflowControlTokenProvider
  ) {
    this.tokenProvider = tokenProvider
  }

  private baseUrl(): string {
    const value = this.getEnv('MCP_HOST_GATEWAY_URL')?.trim()
    if (!value) {
      throw new Error('MCP_HOST_GATEWAY_URL is required for workflow broker tools')
    }
    return trimTrailingSlash(value)
  }

  private accessToken(): Promise<string> {
    return this.tokenProvider.getWorkflowControlToken()
  }

  private async send(path: string, init: RequestInit, token: string): Promise<Response> {
    return fetch(`${this.baseUrl()}${path}`, {
      ...init,
      signal: AbortSignal.timeout(15_000),
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
        ...(init.method === 'GET' && init.body === undefined
          ? {}
          : { 'Content-Type': 'application/json' }),
      },
    })
  }

  async request(path: string, init: RequestInit = {}): Promise<unknown> {
    let response = await this.send(path, init, await this.accessToken())
    if (response.status === 401 && this.tokenProvider.refreshWorkflowControlToken) {
      const refreshedToken = await this.tokenProvider.refreshWorkflowControlToken()
      response = await this.send(path, init, refreshedToken)
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(formatBrokerError(response.status, body))
    }

    return response.json()
  }

  async download(
    path: string,
    options: { maxBytes: number }
  ): Promise<{ body: Buffer; headers: Record<string, string> }> {
    let response = await this.send(path, { method: 'GET' }, await this.accessToken())
    if (response.status === 401 && this.tokenProvider.refreshWorkflowControlToken) {
      const refreshedToken = await this.tokenProvider.refreshWorkflowControlToken()
      response = await this.send(path, { method: 'GET' }, refreshedToken)
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(formatBrokerError(response.status, body))
    }

    const contentLength = response.headers.get('content-length')?.trim() || ''
    const expectedBytes = Number(contentLength)
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) {
      throw new Error('Workflow broker download failed: missing content length')
    }
    if (expectedBytes > options.maxBytes) {
      throw new Error('Workflow broker download failed: artifact exceeds byte cap')
    }

    const buffer = await readBodyWithCap(response, options.maxBytes)
    if (buffer.byteLength !== expectedBytes) {
      throw new Error('Workflow broker download failed: content length mismatch')
    }

    return {
      body: buffer,
      headers: {
        'content-disposition': response.headers.get('content-disposition') || '',
        'content-type': response.headers.get('content-type') || '',
        'content-length': contentLength,
      },
    }
  }
}

async function readBodyWithCap(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength > maxBytes) {
      throw new Error('Workflow broker download failed: artifact exceeds byte cap')
    }
    return buffer
  }

  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = Buffer.from(value)
      totalBytes += chunk.byteLength
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error('Workflow broker download failed: artifact exceeds byte cap')
      }
      chunks.push(chunk)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, totalBytes)
}

export function safeErrorCodeFromBody(body: string): string | null {
  const trimmed = body.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as { error?: unknown }
    if (typeof parsed.error !== 'string') return null
    const code = parsed.error.trim()
    return /^[a-zA-Z0-9_.:-]{1,120}$/.test(code) ? code : null
  } catch {
    return null
  }
}

export function formatBrokerError(status: number, body: string): string {
  const code = safeErrorCodeFromBody(body)
  return code
    ? `Workflow broker request failed (${status}): ${code}`
    : `Workflow broker request failed (${status})`
}
