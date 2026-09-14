// Isolated custom-coordinator fixture. The SDK owns WRC identity and status.
const fs = require('node:fs/promises')
const { randomUUID } = require('node:crypto')

const ARTIFACT_NAME = 'approved-tools-workflow-result.json'
const ARTIFACT_PATH = `/output/${ARTIFACT_NAME}`

function receiptEndpoint(spec) {
  if (!Array.isArray(spec.mcpServers) || spec.mcpServers.length !== 1) {
    throw new Error('exactly_one_declared_receipt_service_required')
  }
  const endpoint = new URL(spec.mcpServers[0].endpoint)
  if (
    endpoint.protocol !== 'http:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/mcp' ||
    !/^[a-z0-9-]+\.mcp-server\.svc\.cluster\.local$/.test(endpoint.hostname) ||
    !endpoint.port ||
    Number(endpoint.port) < 1024
  )
    throw new Error('receipt_service_must_be_declared_local_mcp_fixture')
  return endpoint.href
}

async function readReceipt(endpoint, fetchImpl = fetch) {
  const rpc = async (method, params, notification = false) => {
    const id = notification ? undefined : randomUUID()
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-03-26',
      },
      body: JSON.stringify({ jsonrpc: '2.0', ...(id && { id }), method, params }),
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) throw new Error('receipt_mcp_request_failed')
    if (notification) return undefined
    const text = await response.text()
    if (Buffer.byteLength(text) > 1048576) throw new Error('receipt_mcp_response_too_large')
    const body = JSON.parse(text)
    if (body.jsonrpc !== '2.0' || body.id !== id || body.error || !body.result)
      throw new Error('invalid_receipt_mcp_response')
    return body.result
  }
  await rpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'approved-tools-workflow-fixture', version: '1.0.0' },
  })
  await rpc('notifications/initialized', {}, true)
  const catalog = await rpc('tools/list', {})
  if (!Array.isArray(catalog.tools)) throw new Error('receipt_catalog_missing')
  const matches = catalog.tools.filter(
    tool =>
      typeof tool.description === 'string' && tool.description.includes('verification receipt')
  )
  if (
    matches.length !== 1 ||
    matches[0].inputSchema?.type !== 'object' ||
    matches[0].inputSchema?.required?.length
  )
    throw new Error('receipt_tool_not_uniquely_resolved')
  const selected = matches[0].name
  // Exactly one business invocation; never retry a request after uncertain execution.
  const result = await rpc('tools/call', { name: selected, arguments: {} })
  if (
    result.isError ||
    !Array.isArray(result.content) ||
    result.content.length !== 1 ||
    result.content[0].type !== 'text'
  )
    throw new Error('invalid_receipt_result')
  const receipt = JSON.parse(result.content[0].text)
  if (
    receipt.tool !== selected ||
    typeof receipt.businessId !== 'string' ||
    typeof receipt.runId !== 'string' ||
    typeof receipt.callId !== 'string'
  )
    throw new Error('receipt_binding_missing')
  return receipt
}

async function main() {
  if (!process.env.CLERUM_WORKFLOW_RUN_ID?.trim())
    throw new Error('triggered_workflow_run_required')
  const { WorkflowSDK, emitLog } = require('@clerum/workflow-sdk')
  const sdk = await WorkflowSDK.fromEnvironment()
  try {
    const spec = await sdk.config.getSpec()
    if (spec.steps?.length !== 1 || spec.steps[0].id !== 'receipt')
      throw new Error('receipt_step_required')
    const endpoint = receiptEndpoint(spec)
    sdk.updatePhase('running')
    await sdk.status.reportWorkflowStatus('running')
    sdk.updateStepState('receipt', { phase: 'running' })
    await sdk.status.reportStepStatus('receipt', 'running', {
      executor: 'custom',
      startedAt: new Date().toISOString(),
    })
    const receipt = await readReceipt(endpoint)
    await fs.mkdir('/output', { recursive: true })
    await fs.writeFile(ARTIFACT_PATH, JSON.stringify(receipt), { flag: 'wx' })
    const { size } = await fs.stat(ARTIFACT_PATH)
    const output = {
      artifacts: [
        {
          name: ARTIFACT_NAME,
          format: 'json',
          sizeBytes: size,
          path: ARTIFACT_PATH,
          createdAt: new Date().toISOString(),
        },
      ],
    }
    sdk.updateStepState('receipt', { phase: 'completed', output })
    await sdk.status.reportStepStatus('receipt', 'completed', {
      executor: 'custom',
      output,
      completedAt: new Date().toISOString(),
    })
    sdk.updatePhase('completed')
    await sdk.status.reportWorkflowStatus('completed', { completedAt: new Date().toISOString() })
    emitLog('info', 'Approved-tools workflow receipt completed')
  } catch {
    sdk.updatePhase('failed')
    await sdk.status.reportWorkflowStatus('failed', {
      failureReason: 'approved_tools_receipt_failed',
    })
    process.exitCode = 1
  } finally {
    await sdk.shutdown()
  }
}

module.exports = { receiptEndpoint, readReceipt }
if (require.main === module)
  main().catch(() => {
    process.exitCode = 1
  })
