/**
 * Concrete McpHostClient implementation for WRC → mcp_host Pod communication.
 *
 * Implements both the credential-bearing workflow `/configure` call and the
 * identity-only Plugin Workload SDK bootstrap call. This is the WRC-side
 * client (NOT the SDK's McpHostClient which executes steps).
 *
 * Security invariant: workflow model credentials travel only on the
 * WRC→mcp_host configure request and are never returned to the coordinator;
 * the SDK bootstrap request carries provider/model identity only.
 */
import type { McpHostClient } from './modelConfigHandler'

const CONFIGURE_PATH = '/api/v1/workflow/configure'
const PLUGIN_SDK_BOOTSTRAP_PATH = '/api/v1/workflow/plugin-workload-sdk/bootstrap'
const TIMEOUT_MS = 10_000

export class HttpMcpHostClient implements McpHostClient {
  async configure(
    endpoint: string,
    token: string,
    body: Record<string, unknown>
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const url = `${endpoint}${CONFIGURE_PATH}`

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS)

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      // Read body as text first, then parse — Response body is a ReadableStream
      // that can only be consumed once. Calling .json() then .text() would lose
      // the error message on non-JSON responses (e.g., proxy 502 HTML pages).
      let responseBody: Record<string, unknown>
      const text = await response.text()
      try {
        responseBody = JSON.parse(text) as Record<string, unknown>
      } catch {
        responseBody = { raw: text }
      }

      return { status: response.status, body: responseBody }
    } finally {
      clearTimeout(timeoutId)
    }
  }

  async configurePluginWorkloadSdkBootstrap(
    endpoint: string,
    token: string,
    body: { provider: string; model: string }
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const url = `${endpoint}${PLUGIN_SDK_BOOTSTRAP_PATH}`
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const text = await response.text()
      let responseBody: Record<string, unknown>
      try {
        responseBody = JSON.parse(text) as Record<string, unknown>
      } catch {
        responseBody = { raw: text }
      }
      return { status: response.status, body: responseBody }
    } finally {
      clearTimeout(timeoutId)
    }
  }
}
