import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { RECEIPT_TOOL, createApprovedToolsFixture } from './server.mjs'

// Exercise interoperability with the same installed SDK as MCP Host.
const require = createRequire(new URL('../../../../../mcp-host/package.json', import.meta.url))
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const {
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/sdk/client/streamableHttp.js')

async function start(t, catalogSize) {
  const runId = `contract-${catalogSize}`
  const server = createApprovedToolsFixture({ catalogSize, runId })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    const closed = once(server, 'close')
    server.close()
    server.closeAllConnections()
    await closed
  })
  const base = `http://127.0.0.1:${server.address().port}`
  return { base, runId }
}

for (const count of [83, 150, 250]) {
  test(`real HTTP MCP discovers exactly ${count} and executes the final receipt tool`, async t => {
    const { base, runId } = await start(t, count)
    const evidence = () =>
      fetch(`${base}/evidence?runId=${runId}`).then(response => response.json())
    assert.deepEqual(await evidence(), { runId, catalogSize: count, calls: [] })
    const client = new Client({ name: 'fixture-contract', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`))
    t.after(() => client.close())
    await client.connect(transport)
    assert.equal(client.getServerVersion().name, 'evenfire-approved-tools-fixture')
    const catalog = await client.listTools()
    assert.equal(catalog.tools.length, count)
    assert.equal(new Set(catalog.tools.map(tool => tool.name)).size, count)
    assert.equal(catalog.tools.at(-1).name, RECEIPT_TOOL)
    assert.equal(catalog.tools.at(-1).inputSchema.additionalProperties, false)
    assert.deepEqual((await evidence()).calls, [], 'Discovery must not create business records')
    assert.equal(
      JSON.stringify(catalog).includes('businessId'),
      false,
      'Nonce must not be advertised'
    )
    const result = await client.callTool({ name: RECEIPT_TOOL, arguments: {} })
    assert.equal(result.isError, false)
    const receipt = JSON.parse(result.content[0].text)
    assert.equal(receipt.tool, RECEIPT_TOOL)
    assert.equal(receipt.runId, runId)
    assert.match(receipt.businessId, /^[0-9a-f-]{36}$/)
    assert.deepEqual((await evidence()).calls, [receipt])
    const repeated = await client.callTool({ name: RECEIPT_TOOL, arguments: {} })
    assert.equal(JSON.parse(repeated.content[0].text).businessId, receipt.businessId)
    assert.equal(
      (await evidence()).calls.length,
      2,
      'Counters detect duplicate business executions'
    )
    const unknown = await client.callTool({ name: 'unavailable_tool', arguments: {} })
    assert.equal(unknown.isError, true)
    const invalid = await client.callTool({
      name: RECEIPT_TOOL,
      arguments: { runId: 'fabricated' },
    })
    assert.equal(invalid.isError, true)
    assert.equal((await evidence()).calls.length, 2, 'Rejected calls cannot create evidence')
    assert.equal((await fetch(`${base}/evidence?runId=another-run`)).status, 404)
  })
}

test('HTTP protocol errors and observation routes cannot execute business operations', async t => {
  const { base, runId } = await start(t, 83)
  const rpc = body =>
    fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body,
    })
  assert.equal((await fetch(`${base}/mcp`)).status, 405)
  assert.equal((await fetch(`${base}/mcp`, { method: 'POST' })).status, 406)
  assert.equal((await rpc('{')).status, 200)
  assert.equal((await (await rpc('{')).json()).error.code, -32700)
  assert.equal((await rpc('x'.repeat(65537))).status, 413)
  const unknown = await (
    await rpc(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'unknown' }))
  ).json()
  assert.equal(unknown.error.code, -32601)
  assert.deepEqual((await (await fetch(`${base}/evidence?runId=${runId}`)).json()).calls, [])
  assert.equal((await fetch(`${base}/evidence?runId=`)).status, 400)
  const health = await (await fetch(`${base}/health`)).json()
  assert.deepEqual(health, { ready: true, catalogSize: 83, runId })
})

test('invalid fixture configuration fails before listening', () => {
  for (const catalogSize of [0, 32, 84, 151, 251, NaN, '83']) {
    assert.throws(() => createApprovedToolsFixture({ catalogSize }), /catalogSize/)
  }
  assert.throws(() => createApprovedToolsFixture({ runId: '../foreign' }), /runId/)
})
