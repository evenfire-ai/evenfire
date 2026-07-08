/**
 * E7.6–E7.10: MCP tool invocation E2E tests (Phase 7).
 *
 * Validates MCP tools via port-forward to the operator's StreamableHTTP endpoint.
 * Tests list_recipes, get_recipe_status, validate_recipe, and list_policies.
 *
 * Prerequisites: Run scripts/minikube-setup.sh before these tests.
 * These tests run AFTER lifecycle.test.ts (sequential mode).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ChildProcess } from 'node:child_process'
import {
  RECIPE_NAMESPACE,
  WRC_NAMESPACE,
  kubectl,
  sleep,
  startPortForward,
  waitForPortForward,
} from './helpers'

const OPERATOR_DEPLOY = 'deploy/workflow-recipes'
const LOCAL_PORT = 18083 // Different from bootstrap.test.ts (18082) to avoid TCP TIME_WAIT
const REMOTE_PORT = 8082

let portForward: { process: ChildProcess; url: string } | null = null

// Apply a simple recipe so list_recipes returns something
const SAMPLE_RECIPE = 'simple-nginx'
const SAMPLE_FILE = `${__dirname}/../../samples/simple-nginx.yaml`

/**
 * Start port-forward and wait for kubectl to confirm it's active.
 * Waits for the "Forwarding from" message on stdout before resolving.
 */
async function startAndWaitPortForward(): Promise<{ process: ChildProcess; url: string }> {
  return new Promise<{ process: ChildProcess; url: string }>((resolve, reject) => {
    const child = startPortForward(OPERATOR_DEPLOY, WRC_NAMESPACE, LOCAL_PORT, REMOTE_PORT)
    let settled = false

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        child.process.kill()
        reject(new Error("port-forward: timed out waiting for 'Forwarding from' message"))
      }
    }, 30_000)

    child.process.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      if (!settled && text.includes('Forwarding from')) {
        settled = true
        clearTimeout(timer)
        resolve(child)
      }
    })

    child.process.stderr?.on('data', (chunk: Buffer) => {
      console.error(`[port-forward stderr] ${chunk.toString().trim()}`)
    })

    child.process.on('exit', code => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(new Error(`port-forward exited unexpectedly with code ${code}`))
      }
    })
  })
}

beforeAll(async () => {
  // Ensure a recipe exists for testing
  try {
    kubectl(`apply -f ${SAMPLE_FILE}`)
  } catch {
    /* may already exist */
  }
  await sleep(3_000)

  // Wait for operator to be fully ready
  kubectl(
    `wait --for=condition=Ready pod -l app=workflow-recipes -n ${WRC_NAMESPACE} --timeout=60s`
  )

  // Start port-forward and wait for kubectl to confirm
  portForward = await startAndWaitPortForward()
  // Double-check with health endpoint
  await waitForPortForward(portForward.url, 10_000)
})

afterAll(() => {
  if (portForward) {
    portForward.process.kill()
  }
  try {
    kubectl(`delete workflowrecipe ${SAMPLE_RECIPE} -n ${RECIPE_NAMESPACE} --ignore-not-found`)
  } catch {
    /* ignore */
  }
})

/**
 * Call an MCP tool via the StreamableHTTP endpoint.
 * Sends a JSON-RPC request to /mcp/v1.
 */
async function mcpCallTool(
  url: string,
  toolName: string,
  args: Record<string, unknown> = {}
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  // Step 1: Initialize — must include Accept header for StreamableHTTP
  const initRes = await fetch(`${url}/mcp/v1`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'X-Clerum-Agent-Id': 'e2e-test',
      'X-Clerum-Context-Ref': 'default',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'e2e-test', version: '1.0.0' },
      },
    }),
  })

  const initText = await initRes.text().catch(() => '')
  if (initRes.status !== 200) {
    throw new Error(`MCP initialize failed: HTTP ${initRes.status} ${initText}`)
  }
  const initData = initText.trim() ? parseSseOrJson(initText) : null
  if (initData && typeof initData === 'object' && 'error' in initData && initData.error != null) {
    throw new Error(`MCP initialize returned JSON-RPC error: ${JSON.stringify(initData.error)}`)
  }

  // Session ID comes from response HEADERS, not body
  const sessionId = initRes.headers.get('mcp-session-id')

  // Step 2: Call tool with session ID
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'X-Clerum-Agent-Id': 'e2e-test',
    'X-Clerum-Context-Ref': 'default',
  }
  if (sessionId) {
    headers['mcp-session-id'] = sessionId
  }

  const toolRes = await fetch(`${url}/mcp/v1`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  })

  const toolText = await toolRes.text()
  if (toolRes.status !== 200) {
    throw new Error(`MCP tool ${toolName} failed: HTTP ${toolRes.status} ${toolText}`)
  }
  const toolData = parseSseOrJson(toolText)

  const result = requireJsonRpcResult<{ content?: unknown; isError?: boolean }>(
    toolData,
    `tools/call ${toolName}`,
    toolText
  )
  if (!Array.isArray(result.content)) {
    throw new Error(`MCP tool ${toolName} result missing content array: ${toolText}`)
  }
  return result as { content: Array<{ type: string; text: string }>; isError?: boolean }
}

/**
 * Parse an SSE or plain JSON response.
 * StreamableHTTP may respond with `text/event-stream` (SSE) containing
 * `event: message\ndata: {...}\n` lines, or plain JSON. This helper
 * extracts the JSON from either format.
 */
function parseSseOrJson(text: string): unknown {
  // Try plain JSON first
  try {
    return JSON.parse(text)
  } catch {
    // Parse SSE: extract the last `data:` line
    const lines = text.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].startsWith('data: ')) {
        return JSON.parse(lines[i].slice(6))
      }
    }
    return text
  }
}

function requireJsonRpcResult<T>(data: unknown, method: string, rawBody: string): T {
  if (!data || typeof data !== 'object') {
    throw new Error(`MCP ${method} returned non-object response: ${rawBody}`)
  }

  const envelope = data as { error?: unknown; result?: unknown }
  if (envelope.error != null) {
    throw new Error(`MCP ${method} returned JSON-RPC error: ${JSON.stringify(envelope.error)}`)
  }
  if (!('result' in envelope)) {
    throw new Error(`MCP ${method} response missing result: ${rawBody}`)
  }

  return envelope.result as T
}

describe('MCP Tools E2E', () => {
  // E7.6: list_recipes
  it('E7.6 — list_recipes returns recipes via MCP', async () => {
    const result = await mcpCallTool(portForward!.url, 'list_recipes', {})
    expect(result.content).toHaveLength(1)
    const body = JSON.parse(result.content[0].text) as Array<{ name: string }>
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeGreaterThanOrEqual(1)
  })

  // E7.7: get_recipe_status
  it('E7.7 — get_recipe_status returns phase', async () => {
    const result = await mcpCallTool(portForward!.url, 'get_recipe_status', { name: SAMPLE_RECIPE })
    expect(result.content).toHaveLength(1)
    const body = JSON.parse(result.content[0].text) as { name: string; phase: string }
    expect(body.name).toBe(SAMPLE_RECIPE)
    expect(typeof body.phase).toBe('string')
  })

  // E7.8: validate_recipe (valid)
  it('E7.8 — validate_recipe returns valid for correct recipe', async () => {
    const validRecipe = JSON.stringify({
      spec: {
        workloads: [{ id: 'web', type: 'deployment', image: 'nginx:1.30.1-alpine' }],
      },
    })
    const result = await mcpCallTool(portForward!.url, 'validate_recipe', {
      recipe_yaml: validRecipe,
    })
    const body = JSON.parse(result.content[0].text) as { valid: boolean }
    expect(body.valid).toBe(true)
  })

  // E7.9: validate_recipe (invalid)
  it('E7.9 — validate_recipe returns invalid for bad recipe', async () => {
    const invalidRecipe = JSON.stringify({ spec: { workloads: [] } })
    const result = await mcpCallTool(portForward!.url, 'validate_recipe', {
      recipe_yaml: invalidRecipe,
    })
    const body = JSON.parse(result.content[0].text) as { valid: boolean; errors: string[] }
    expect(body.valid).toBe(false)
    expect(body.errors.length).toBeGreaterThan(0)
  })

  // E7.10: list_policies
  it('E7.10 — list_policies returns policies array via MCP', async () => {
    const result = await mcpCallTool(portForward!.url, 'list_policies', {})
    expect(result.content).toHaveLength(1)
    const body = JSON.parse(result.content[0].text) as { policies: unknown[] }
    expect(Array.isArray(body.policies)).toBe(true)
  })
})
