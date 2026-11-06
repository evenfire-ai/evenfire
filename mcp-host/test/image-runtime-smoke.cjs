'use strict'

// Run from the built mcp-host package directory, or stream into the final image.
// This checks shipped dist/native bindings; the TypeScript suite owns source-level
// transport faults, keep-alive and cancellation coverage.
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { gzipSync } = require('node:zlib')
const Database = require('better-sqlite3')
const { createCanvas } = require('@napi-rs/canvas')
const { resolve } = require('node:path')
const { OpenAICompatibleProvider } = require(resolve('dist/llm/openaiCompatible.js'))
const db = new Database(':memory:')
assert.equal(db.prepare('SELECT 42 AS value').get().value, 42)
db.close()
const canvas = createCanvas(10, 10)
canvas.getContext('2d').fillRect(0, 0, 10, 10)
assert.ok(canvas.toBuffer('image/png').length > 0)
let requests = 0
const server = createServer((request, response) => {
  request.resume()
  request.on('end', () => {
    requests++
    const body = gzipSync(
      Buffer.from(
        JSON.stringify({ choices: [{ message: { content: 'complete' }, finish_reason: 'stop' }] })
      )
    )
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' })
    response.write(body.subarray(0, 7))
    setImmediate(() => response.end(body.subarray(7)))
  })
})
server.listen(0, '127.0.0.1', async () => {
  try {
    const baseURL = `http://127.0.0.1:${server.address().port}/v1`
    const provider = new OpenAICompatibleProvider(
      { id: 'zai', baseURL, defaultModel: 'runtime-http-test' },
      'local-http-fixture'
    )
    const result = await provider.completeSingleTurn([{ role: 'user', content: 'read' }], {
      signal: AbortSignal.timeout(5000),
    })
    assert.equal(result.content, 'complete')
    assert.equal(requests, 1)
    console.log(
      JSON.stringify({
        status: 'PASS',
        nodeVersion: process.versions.node,
        sqlite: true,
        canvas: true,
        defaultSdkHttp: true,
        requests,
      })
    )
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    server.closeAllConnections()
    server.close()
  }
})
