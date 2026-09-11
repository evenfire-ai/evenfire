import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createFixtureTls } from '../e2e/_lib/hcc-watch-tls.mjs'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs'
import https from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createProxy } from '../e2e/_lib/hcc-watch-api-proxy.mjs'
import { createBookmarkObservation } from '../e2e/_lib/hcc-watch-bookmarks.mjs'

const headers = { 'content-type': 'application/json;stream=watch' }
const bookmark = Buffer.from(
  '{"type":"BOOKMARK","object":{"metadata":{"resourceVersion":"123"}}}\n'
)
const added = Buffer.from('{"type":"ADDED","object":{"spec":{"type":"BOOKMARK","text":"ñ"}}}\n')

test('counts only top-level BOOKMARK by watch across arbitrary UTF8/frame splits', () => {
  let clock = 10
  const observation = createBookmarkObservation({ now: () => clock })
  const mcp = observation.open('McpServer', headers, 200)
  const context = observation.open('Context', headers, 200)
  for (const byte of Buffer.concat([added, bookmark, bookmark])) mcp.write(Buffer.from([byte]))
  context.write(added)
  mcp.end()
  context.end()
  clock = 20
  const result = observation.finish()
  assert.equal(result.byWatch.McpServer.bookmarks, 2)
  assert.equal(result.byWatch.Context.bookmarks, 0)
  assert.equal(result.byWatch.Context.receipt, 'not-observed')
  assert.equal(result.byWatch.McpServer.disconnectBenefit, 'NO_DEMOSTRADO')
  assert.equal(result.startedAtMs, 10)
  assert.equal(result.endedAtMs, 20)
})

test('unknown is not zero for absent, malformed, oversized, unsupported or partial observation', () => {
  for (const variant of [
    'absent',
    'malformed',
    'oversized',
    'compressed',
    'partial',
    'invalid-utf8',
    'invalid-bookmark',
  ]) {
    const observation = createBookmarkObservation({ maxFrameBytes: 128 })
    if (variant !== 'absent') {
      const stream = observation.open(
        'McpServer',
        variant === 'compressed' ? { ...headers, 'content-encoding': 'gzip' } : headers,
        200
      )
      if (variant === 'malformed') stream.write(Buffer.from('not-json\n'))
      if (variant === 'oversized') stream.write(Buffer.from('x'.repeat(100000) + '\n'))
      if (variant === 'partial') stream.write(bookmark.subarray(0, 10))
      if (variant === 'invalid-utf8') stream.write(Buffer.from([255, 10]))
      if (variant === 'invalid-bookmark')
        stream.write(Buffer.from('{"type":"BOOKMARK","object":{}}\n'))
      stream.close()
    }
    const result = observation.finish().byWatch.McpServer
    assert.equal(result.bookmarks, null, variant)
    assert.equal(result.coverage, 'unknown', variant)
    assert.equal(result.receipt, 'unknown', variant)
  }
})

test('positive receipt remains a lower bound after an oversized frame', () => {
  const observation = createBookmarkObservation({ maxFrameBytes: 128 })
  const stream = observation.open('McpServer', headers, 200)
  stream.write(Buffer.concat([Buffer.from('x'.repeat(100000) + '\n'), bookmark]))
  stream.end()
  const result = observation.finish().byWatch.McpServer
  assert.equal(result.bookmarks, null)
  assert.equal(result.observedBookmarks, 1)
  assert.equal(result.receipt, 'observed')
  assert.deepEqual(result.reasons, ['oversized-frame'])
})

test('bounds active parser memory and freezes the finite observation window', () => {
  let clock = 10
  const observation = createBookmarkObservation({ maxStreams: 1, now: () => clock })
  const stream = observation.open('McpServer', headers, 200)
  observation.open('Context', headers, 200).write(bookmark)
  stream.write(bookmark)
  clock = 20
  const first = observation.finish()
  clock = 30
  stream.write(bookmark)
  observation.open('McpServer', headers, 200).write(bookmark)
  assert.deepEqual(observation.finish(), first)
  assert.deepEqual(first.byWatch.Context.reasons, ['observer-limit'])
  assert.throws(() => createBookmarkObservation({ maxFrameBytes: 100000000 }))
  assert.throws(() => createBookmarkObservation({ maxStreams: 10000 }))
})

test('observation preserves streamed bytes including malformed frames and backpressure', async () => {
  const observation = createBookmarkObservation()
  const observer = observation.open('McpServer', headers, 200)
  const upstream = new PassThrough({ highWaterMark: 8 })
  const downstream = new PassThrough({ highWaterMark: 8 })
  const chunks = []
  upstream.on('data', chunk => observer.write(chunk))
  upstream.once('end', () => observer.end())
  upstream.once('close', () => observer.close())
  upstream.pipe(downstream)
  downstream.on('data', chunk => chunks.push(chunk))
  const ended = new Promise(resolve => downstream.once('end', resolve))
  const input = Buffer.concat([added, Buffer.from('malformed\n'), bookmark])
  for (const byte of input) upstream.write(Buffer.from([byte]))
  upstream.end()
  await ended
  assert.deepEqual(Buffer.concat(chunks), input)
  const result = observation.finish().byWatch.McpServer
  assert.equal(result.observedBookmarks, 1)
  assert.equal(result.bookmarks, null)
})

test('proxy observes the actual verified HTTPS response and publishes only a bounded summary', async () => {
  const credentials = createFixtureTls('127.0.0.1')
  const controlDir = mkdtempSync(join(tmpdir(), 'hcc-bookmark-observation-'))
  const upstream = https.createServer(credentials, (_request, response) => {
    response.writeHead(200, headers)
    response.end(bookmark)
  })
  let proxy
  try {
    upstream.listen(0, '127.0.0.1')
    await once(upstream, 'listening')
    proxy = createProxy({
      ...credentials,
      upstreamCa: credentials.cert,
      upstreamHost: '127.0.0.1',
      upstreamPort: upstream.address().port,
      allowedPaths: [],
      controlDir,
      periodMs: 60000,
      minAgeMs: 60000,
    })
    proxy.server.listen(0, '127.0.0.1')
    await once(proxy.server, 'listening')
    const bytes = await new Promise((resolve, reject) => {
      https
        .get(
          {
            hostname: '127.0.0.1',
            port: proxy.server.address().port,
            path: '/apis/clerum.io/v1alpha1/namespaces/mcp-server/mcpservers?watch=true',
            ca: credentials.cert,
            signal: AbortSignal.timeout(3000),
          },
          response => {
            const chunks = []
            response.on('data', chunk => chunks.push(chunk))
            response.once('end', () => resolve(Buffer.concat(chunks)))
            response.once('error', reject)
          }
        )
        .once('error', reject)
    })
    assert.deepEqual(bytes, bookmark)
    await new Promise((resolve, reject) => {
      const observer = watch(controlDir, () => {
        try {
          const ack = JSON.parse(readFileSync(join(controlDir, 'ack.json')))
          if (ack.id !== 'receipt-window' || ack.state !== 'observed') return
          clearTimeout(timeout)
          observer.close()
          resolve()
        } catch {}
      })
      const timeout = setTimeout(() => {
        observer.close()
        reject(new Error('observation acknowledgement timeout'))
      }, 3000)
      writeFileSync(
        join(controlDir, 'command.json'),
        JSON.stringify({ id: 'receipt-window', action: 'observe-bookmarks' })
      )
    })
    const report = JSON.parse(readFileSync(join(controlDir, 'bookmarks.json')))
    assert.equal(report.byWatch.McpServer.bookmarks, 1)
    assert.equal(report.byWatch.Context.bookmarks, null)
    assert.equal(report.byWatch.Context.receipt, 'unknown')
    assert.equal(JSON.stringify(report).includes('resourceVersion'), false)
  } finally {
    proxy?.close()
    upstream.closeAllConnections()
    upstream.close()
    rmSync(controlDir, { recursive: true, force: true })
  }
})

test('harness binds receipt to image and pod witnesses without turning zero or unknown into a D2-b failure', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hcc-bookmark-report-'))
  const helper = fileURLToPath(new URL('../e2e/_lib/hcc-watch-pr-a.sh', import.meta.url))
  const observation = createBookmarkObservation({ now: () => 1000 })
  const stream = observation.open('McpServer', headers, 200)
  stream.write(bookmark)
  stream.end()
  writeFileSync(join(directory, 'observation.json'), JSON.stringify(observation.finish()))
  const script = `set -euo pipefail
source "$HELPER"
NP604_EVIDENCE="$REPORT_DIR" HCC_NS=fixture HCC_IMAGE=fixture-image
hcc_pr_a_proxy_pod() { printf proxy; }
running_hcc_pod() { printf hcc; }
hcc_pr_a_bookmark_pod_witness() { printf '%s' "$WITNESS"; }
hcc_pr_a_command() { :; }
wait_until() { :; }
kctl() { cat "$REPORT_DIR/observation.json"; }
hcc_pr_a_bookmark_report
`
  try {
    for (const image of ['fixture-image', 'other-image']) {
      const witness = {
        uid: 'fixture-pod',
        image,
        imageID: 'sha256:fixture',
        restarts: 0,
        startedAt: '1970-01-01T00:00:00Z',
      }
      const run = spawnSync('/bin/bash', ['-c', script], {
        encoding: 'utf8',
        timeout: 5000,
        env: {
          ...process.env,
          HELPER: helper,
          REPORT_DIR: directory,
          WITNESS: JSON.stringify(witness),
        },
      })
      assert.equal(run.status, 0, 'receipt observation never becomes a D2-b failure')
      const report = JSON.parse(readFileSync(join(directory, 'bookmark-receipt.json')))
      assert.equal(
        report.receiptStatus,
        image === 'fixture-image' ? 'OBSERVED_UPSTREAM' : 'NO_DEMOSTRADO'
      )
      assert.equal(report.byWatch.McpServer.bookmarks, image === 'fixture-image' ? 1 : null)
      assert.equal(report.disconnectBenefit, 'NO_DEMOSTRADO')
    }
    writeFileSync(join(directory, 'observation.json'), 'unavailable')
    const run = spawnSync('/bin/bash', ['-c', script], {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, HELPER: helper, REPORT_DIR: directory, WITNESS: '{}' },
    })
    assert.equal(run.status, 0)
    assert.equal(
      JSON.parse(readFileSync(join(directory, 'bookmark-receipt.json'))).byWatch.McpServer
        .bookmarks,
      null
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
