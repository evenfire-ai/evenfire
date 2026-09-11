import { URL } from 'url'
import { Tool } from '../interfaces'
import { requestPinned, resolvePinnedPublicIp } from '../net/ssrf'
import { ToolOutput } from '../types'

// Re-exported for existing importers (safety.ts, tests). The implementation now
// lives in ../net/ssrf as the single source of truth shared with the guardrail
// hook fetcher.
export { isPrivateIp } from '../net/ssrf'

// Transport bounds (shared requestPinned, §8.1). The timeout is enforced as an
// ABSOLUTE deadline via AbortSignal — Node's socket `timeout` alone is an idle
// timer a trickling server resets forever. The byte ceiling is a safety cap far
// above the 50 KB display-truncation below, so normal responses are unaffected;
// only a multi-MB flood is rejected (destroyed mid-stream, never fully buffered).
const HTTP_REQUEST_TIMEOUT_MS = 30000
const HTTP_REQUEST_MAX_BYTES = 10 * 1024 * 1024 // 10 MiB

export class HttpRequestTool implements Tool {
  constructor(private readonly allowlist: string[]) {}

  name() {
    return 'http_request'
  }
  description() {
    return (
      'Make an HTTP/HTTPS request to an allowed domain. ' +
      'Supports GET, POST, PUT, DELETE methods. ' +
      'This tool requires approval before execution.'
    )
  }
  parametersSchema() {
    return {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to request' },
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'DELETE'],
          description: 'HTTP method (default: GET)',
        },
        headers: {
          type: 'object',
          description: 'Request headers as key-value pairs',
        },
        body: {
          type: 'string',
          description: 'Request body (for POST/PUT)',
        },
      },
      required: ['url'],
    }
  }
  requiresSanitization() {
    return true
  }
  requiresApproval() {
    return true
  } // HIGH RISK

  async execute(params: Record<string, unknown>): Promise<ToolOutput> {
    const startTime = Date.now()
    const urlString = params.url as string
    const method = (params.method as string) || 'GET'
    const headers = (params.headers as Record<string, string>) || {}
    const body = params.body as string | undefined

    // Parse and validate URL
    let url: URL
    try {
      url = new URL(urlString)
    } catch {
      return {
        content: 'Error: Invalid URL',
        duration_ms: Date.now() - startTime,
        is_error: true,
      }
    }

    if (this.allowlist.length > 0) {
      const isAllowed = this.allowlist.some(
        domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`)
      )
      if (!isAllowed) {
        return {
          content: `Error: Domain "${url.hostname}" not in allowlist`,
          duration_ms: Date.now() - startTime,
          is_error: true,
        }
      }
    }

    // SSRF guard: validate the host is public and pin the connect IP (closes the
    // DNS-rebinding window). Preserves the prior error phrasing ("private IP",
    // "DNS resolution failed") via the thrown message.
    let pinnedIp: string
    try {
      pinnedIp = await resolvePinnedPublicIp(url)
    } catch (err) {
      return {
        content: `Error: ${(err as Error).message}`,
        duration_ms: Date.now() - startTime,
        is_error: true,
      }
    }

    try {
      const { statusCode, body: responseBody } = await requestPinned({
        url,
        method,
        headers,
        body,
        pinnedIp,
        timeoutMs: HTTP_REQUEST_TIMEOUT_MS,
        signal: AbortSignal.timeout(HTTP_REQUEST_TIMEOUT_MS),
        maxBytes: HTTP_REQUEST_MAX_BYTES,
      })
      const truncated =
        responseBody.length > 50000
          ? responseBody.substring(0, 50000) + '\n...[truncated]'
          : responseBody
      return {
        content: `HTTP ${statusCode}\n\n${truncated}`,
        duration_ms: Date.now() - startTime,
        is_error: statusCode >= 400,
      }
    } catch (err) {
      return {
        content: `HTTP request failed: ${(err as Error).message}`,
        duration_ms: Date.now() - startTime,
        is_error: true,
      }
    }
  }
}
