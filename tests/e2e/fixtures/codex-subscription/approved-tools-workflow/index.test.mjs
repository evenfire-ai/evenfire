import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createApprovedToolsFixture } from '../approved-tools/server.mjs'
import coordinator from './index.js'

test('receipt artifacts contain only bounded validated business fields', () => {
  const receipt = {
    runId: 'workflow-fixture',
    tool: 'workitem_read_receipt',
    callId: '12345678-1234-4234-8234-123456789abc',
    businessId: 'abcdef12-1234-4234-8234-123456789abc',
  }
  assert.deepEqual(
    coordinator.validatedReceipt({ ...receipt, remoteExtra: 'must not persist' }, receipt.tool),
    receipt
  )
  for (const invalid of [
    { ...receipt, tool: 'other_tool' },
    { ...receipt, businessId: 'not-a-business-id' },
    { ...receipt, callId: '' },
    { ...receipt, runId: '../other-artifact' },
    { ...receipt, runId: 'x'.repeat(129) },
  ]) {
    assert.throws(() => coordinator.validatedReceipt(invalid, receipt.tool))
  }
})

test('coordinator refuses eager execution without a triggered workflow run', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./index.js', import.meta.url))],
    { env: {}, encoding: 'utf8' }
  )
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
})

test('coordinator receipt client executes the selected real local MCP once', async t => {
  const runId = 'workflow-unit-contract'
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
  const receipt = await coordinator.readReceipt(`${base}/mcp`)
  const evidence = await fetch(`${base}/evidence?runId=${runId}`).then(response => response.json())
  assert.equal(receipt.runId, runId)
  assert.equal(receipt.tool, 'workitem_read_receipt')
  assert.match(receipt.businessId, /^[a-f0-9-]{36}$/)
  assert.deepEqual(evidence.calls, [receipt])
})

test('coordinator accepts only one declared cluster-local fixture endpoint', () => {
  const valid = 'http://approved-tools-workflow.mcp-server.svc.cluster.local:8080/mcp'
  assert.equal(
    coordinator.receiptEndpoint({ mcpServers: [{ id: 'receipt', endpoint: valid }] }),
    valid
  )
  for (const endpoint of [
    'https://example.com/mcp',
    'http://127.0.0.1:8080/mcp',
    valid + '?override=x',
    valid.replace('/mcp', '/other'),
  ]) {
    assert.throws(() => coordinator.receiptEndpoint({ mcpServers: [{ id: 'receipt', endpoint }] }))
  }
  assert.throws(() => coordinator.receiptEndpoint({ mcpServers: [] }))
  assert.throws(() =>
    coordinator.receiptEndpoint({ mcpServers: [{ endpoint: valid }, { endpoint: valid }] })
  )
})

test('an uncertain business invocation is not retried', async () => {
  let calls = 0
  await assert.rejects(
    coordinator.readReceipt('http://fixture/mcp', async (_input, init) => {
      const request = JSON.parse(init.body)
      if (request.method === 'notifications/initialized') return new Response(null, { status: 202 })
      if (request.method === 'tools/call') {
        calls++
        throw new Error('connection_lost')
      }
      return Response.json({
        jsonrpc: '2.0',
        id: request.id,
        result:
          request.method === 'tools/list'
            ? {
                tools: [
                  {
                    name: 'receipt',
                    description: 'verification receipt',
                    inputSchema: { type: 'object' },
                  },
                ],
              }
            : { protocolVersion: '2025-03-26' },
      })
    })
  )
  assert.equal(calls, 1)
})
