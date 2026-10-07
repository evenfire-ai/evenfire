import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import {
  RECEIPT_TOOL,
  businessReceiptProblem,
  createBusinessReceipt,
  isJsonRpcRequestId,
} from './business-receipt.mjs'
import { createApprovedToolsFixture } from './server.mjs'

const valid = {
  runId: 'receipt-contract',
  tool: RECEIPT_TOOL,
  callId: 7,
  businessId: '12345678-1234-4234-8234-123456789abc',
}

test('JSON-RPC request ids are non-empty strings up to 128 characters or safe integers', () => {
  for (const id of [0, 1, 7, -3, Number.MAX_SAFE_INTEGER, 'a', 'x'.repeat(128), valid.businessId])
    assert.equal(isJsonRpcRequestId(id), true, `accepts ${String(id)}`)
  for (const id of [
    null,
    undefined,
    '',
    'x'.repeat(129),
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    true,
    {},
    [],
  ])
    assert.equal(isJsonRpcRequestId(id), false, `rejects ${String(id)}`)
})

test('an mcp receipt has exactly the four fields and any JSON-RPC callId', () => {
  assert.equal(businessReceiptProblem(valid, 'mcp'), null)
  assert.equal(businessReceiptProblem({ ...valid, callId: 'request-1' }, 'mcp'), null)
  for (const [value, problem] of [
    [null, 'receipt_not_object'],
    [[valid], 'receipt_not_object'],
    ['{}', 'receipt_not_object'],
    [{ ...valid, extra: 1 }, 'receipt_fields_mismatch'],
    [{ runId: valid.runId, tool: valid.tool, callId: valid.callId }, 'receipt_fields_mismatch'],
    [{ ...valid, runId: '../foreign' }, 'invalid_run_id'],
    [{ ...valid, runId: 'x'.repeat(129) }, 'invalid_run_id'],
    [{ ...valid, tool: 'other-tool' }, 'invalid_tool'],
    [{ ...valid, callId: null }, 'invalid_call_id'],
    [{ ...valid, callId: 1.5 }, 'invalid_call_id'],
    [{ ...valid, callId: '' }, 'invalid_call_id'],
    [{ ...valid, businessId: 'not-a-business-id' }, 'invalid_business_id'],
    [{ ...valid, businessId: valid.businessId.toUpperCase() }, 'invalid_business_id'],
  ])
    assert.equal(businessReceiptProblem(value, 'mcp'), problem, JSON.stringify(value))
})

test('a host-workflow-result receipt carries the coordinator UUID callId and may carry extra fields', () => {
  const uuidCall = { ...valid, callId: '87654321-4321-4321-8321-cba987654321' }
  assert.equal(businessReceiptProblem(uuidCall, 'host-workflow-result'), null)
  assert.equal(
    businessReceiptProblem({ ...uuidCall, remoteExtra: 'projected away' }, 'host-workflow-result'),
    null
  )
  for (const callId of [7, 'request-1', '', null])
    assert.equal(
      businessReceiptProblem({ ...uuidCall, callId }, 'host-workflow-result'),
      'invalid_call_id'
    )
  assert.throws(() => businessReceiptProblem(valid, 'other'), /unknown_receipt_context/)
})

test('createBusinessReceipt returns only the four fields and refuses a violation', () => {
  assert.deepEqual(createBusinessReceipt({ ...valid, extra: 'dropped' }), valid)
  assert.throws(() => createBusinessReceipt({ ...valid, callId: 1.5 }), /invalid_call_id/)
  assert.throws(() => createBusinessReceipt({ ...valid, callId: null }), /invalid_call_id/)
})

test('the MCP fixture answers -32600 to an id outside the contract and records nothing', async t => {
  const runId = 'receipt-id-contract'
  const server = createApprovedToolsFixture({ catalogSize: 83, runId })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    const closed = once(server, 'close')
    server.close()
    server.closeAllConnections()
    await closed
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = id =>
    fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: RECEIPT_TOOL, arguments: {} },
      }),
    }).then(response => response.json())
  const calls = () =>
    fetch(`${base}/evidence?runId=${runId}`)
      .then(response => response.json())
      .then(evidence => evidence.calls)
  for (const id of [null, 1.5, '', 'x'.repeat(129), true, {}]) {
    const answer = await call(id)
    assert.deepEqual(answer, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Invalid Request' },
    })
  }
  assert.deepEqual(await calls(), [])
  // Liveness witness: integer and string ids reach the business operation.
  for (const id of [11, 'request-12']) {
    const answer = await call(id)
    assert.equal(answer.id, id)
    const receipt = JSON.parse(answer.result.content[0].text)
    assert.equal(receipt.callId, id)
    assert.equal(businessReceiptProblem(receipt, 'mcp'), null)
  }
  const recorded = await calls()
  assert.deepEqual(
    recorded.map(receipt => receipt.callId),
    [11, 'request-12']
  )
  for (const receipt of recorded) assert.equal(businessReceiptProblem(receipt, 'mcp'), null)
})
