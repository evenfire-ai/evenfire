import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib'
import { FETCH_PAGE_LIMITS, fetchPage, pageText } from '../dist/fetchPage.js'

// Unit-only transport double. Real sockets and MCP are separate required lanes.
function upstream(t, responses) {
  const options = []
  t.mock.method(http, 'request', (opts, callback) => {
    options.push(opts)
    const request = new EventEmitter()
    request.end = () =>
      queueMicrotask(() => {
        const response = new PassThrough()
        const spec = responses.shift()
        response.statusCode = spec.status ?? 200
        response.headers = spec.headers ?? {}
        callback(response)
        response.end(spec.body ?? '<title>Example</title><p>Hello</p>')
      })
    return request
  })
  return options
}
test('legitimate content and pinned connection contract', async t => {
  const options = upstream(t, [{}])
  assert.deepEqual(await fetchPage('http://8.8.8.8/example?q=1', 100), {
    title: 'Example',
    content: 'Example Hello',
  })
  assert.equal(options[0].hostname, '8.8.8.8')
  assert.equal(options[0].path, '/example?q=1')
  assert.equal(options[0].agent, false)
})
test('private redirect never creates a second connection', async t => {
  const calls = upstream(t, [{ status: 302, headers: { location: 'http://127.0.0.1' } }])
  await assert.rejects(fetchPage('http://8.8.8.8', 100), { code: 'destination_blocked' })
  assert.equal(calls.length, 1)
})
test('relative redirects and cycles', async t => {
  upstream(t, [{ status: 302, headers: { location: '/next' } }, {}])
  assert.equal((await fetchPage('http://8.8.8.8', 100)).content, 'Example Hello')
  upstream(t, [{ status: 302, headers: { location: '/' } }])
  await assert.rejects(fetchPage('http://8.8.8.8', 100), { code: 'redirect_limit' })
})
for (const [encoding, compress] of [
  ['gzip', gzipSync],
  ['deflate', deflateSync],
  ['br', brotliCompressSync],
]) {
  test(encoding + ' decoded normally', async t => {
    upstream(t, [{ headers: { 'content-encoding': encoding }, body: compress('hello') }])
    assert.equal((await fetchPage('http://8.8.8.8', 100)).content, 'hello')
  })
  test(encoding + ' expansion is bounded', async t => {
    upstream(t, [
      {
        headers: { 'content-encoding': encoding },
        body: compress('x'.repeat(FETCH_PAGE_LIMITS.maxBytes + 1)),
      },
    ])
    await assert.rejects(fetchPage('http://8.8.8.8', 100), { code: 'response_too_large' })
  })
}
test('maxChars is not the byte ceiling; exact ceiling succeeds and +1 fails', async t => {
  upstream(t, [
    { body: 'x'.repeat(FETCH_PAGE_LIMITS.maxBytes) },
    { body: 'x'.repeat(FETCH_PAGE_LIMITS.maxBytes + 1) },
    {},
  ])
  assert.equal((await fetchPage('http://8.8.8.8', 100)).content.length, 100)
  await assert.rejects(fetchPage('http://8.8.8.8', 100), { code: 'response_too_large' })
  assert.equal((await fetchPage('http://8.8.8.8', 100)).title, 'Example')
})
test('unsupported encoding returns only a stable error', async t => {
  upstream(t, [{ headers: { 'content-encoding': 'gzip, br' } }])
  await assert.rejects(fetchPage('http://8.8.8.8', 100), { message: 'unsupported_encoding' })
})
test('linear stripping preserves malformed and ordinary text', () => {
  assert.equal(pageText('a <b> c </b> d'), 'a c d')
  const input = '<'.repeat(1000000)
  assert.equal(pageText(input), input)
})

test('deadline remains active after headers and destroys the body', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const headers = Promise.withResolvers()
  let response
  t.mock.method(http, 'request', (_opts, callback) => {
    const req = new EventEmitter()
    req.end = () =>
      queueMicrotask(() => {
        response = new PassThrough()
        response.statusCode = 200
        response.headers = {}
        callback(response)
        response.write('partial')
        headers.resolve()
      })
    return req
  })
  const pending = fetchPage('http://8.8.8.8', 100)
  const rejected = assert.rejects(pending, { code: 'deadline_exceeded' })
  await headers.promise
  t.mock.timers.tick(FETCH_PAGE_LIMITS.timeoutMs)
  await rejected
  assert.equal(response.destroyed, true)
})

test('process-wide concurrency has no queue and abort releases every slot', async t => {
  const requests = []
  const allHeaders = Promise.withResolvers()
  t.mock.method(http, 'request', (_opts, callback) => {
    const req = new EventEmitter()
    req.end = () =>
      queueMicrotask(() => {
        const res = new PassThrough()
        res.statusCode = 200
        res.headers = {}
        requests.push(res)
        callback(res)
        if (requests.length === FETCH_PAGE_LIMITS.maxConcurrent) allHeaders.resolve()
      })
    return req
  })
  const controllers = Array.from(
    { length: FETCH_PAGE_LIMITS.maxConcurrent },
    () => new AbortController()
  )
  const rejected = controllers.map(controller =>
    assert.rejects(fetchPage('http://8.8.8.8', 100, controller.signal), { code: 'cancelled' })
  )
  await allHeaders.promise
  await assert.rejects(fetchPage('http://8.8.8.8', 100), { code: 'busy' })
  for (const controller of controllers) controller.abort()
  await Promise.all(rejected)
  assert.equal(
    requests.every(r => r.destroyed),
    true
  )
  upstream(t, [{}])
  assert.equal((await fetchPage('http://8.8.8.8', 100)).title, 'Example')
})

test('redirect hop limit terminates before another connection', async t => {
  const responses = Array.from({ length: 6 }, (_, i) => ({
    status: 302,
    headers: { location: `/hop-${i}` },
  }))
  const calls = upstream(t, responses)
  await assert.rejects(fetchPage('http://8.8.8.8', 100), { code: 'redirect_limit' })
  assert.equal(calls.length, 6)
})

test('untrusted declared length is rejected before buffering', async t => {
  upstream(t, [{ headers: { 'content-length': String(FETCH_PAGE_LIMITS.maxBytes + 1) } }])
  await assert.rejects(fetchPage('http://8.8.8.8', 100), { code: 'response_too_large' })
})

test('compressed wire overhead is bounded independently of decoded size', async t => {
  const { randomBytes } = await import('node:crypto')
  const compressed = gzipSync(randomBytes(FETCH_PAGE_LIMITS.maxBytes))
  assert.ok(compressed.length > FETCH_PAGE_LIMITS.maxBytes)
  upstream(t, [{ headers: { 'content-encoding': 'gzip' }, body: compressed }])
  await assert.rejects(fetchPage('http://8.8.8.8', 100), { code: 'response_too_large' })
})

test('DNS host connects only to the validated address and preserves Host', async t => {
  const { Resolver } = await import('node:dns/promises')
  t.mock.method(Resolver.prototype, 'resolve4', async () => ['8.8.8.8'])
  t.mock.method(Resolver.prototype, 'resolve6', async () => {
    throw Object.assign(new Error(), { code: 'ENODATA' })
  })
  const requests = upstream(t, [{}])
  await fetchPage('http://fixture.test:8080/', 100)
  assert.equal(requests[0].hostname, '8.8.8.8')
  assert.equal(requests[0].headers.Host, 'fixture.test:8080')
})

for (const [html, expectedTitle] of [
  ['<title>İstanbul</title><p>Hello</p>', 'İstanbul'],
  ['<!--İ--><title>Hello</title>', 'Hello'],
]) {
  test(`title offsets remain valid for Unicode: ${expectedTitle}`, async t => {
    upstream(t, [{ body: html }])
    assert.equal((await fetchPage('http://8.8.8.8', 100)).title, expectedTitle)
  })
}

for (const prefix of ['<titleish></titleish>', '<titlex>'.repeat(10000)]) {
  test(`title scanning continues past invalid prefixes (${prefix.length} characters)`, async t => {
    upstream(t, [{ body: `${prefix}<TITLE>Actual</TITLE>` }])
    assert.equal((await fetchPage('http://8.8.8.8', 100)).title, 'Actual')
  })
}

test('invalid maxChars has its own safe error and never connects', async t => {
  const requests = upstream(t, [])
  for (const maxChars of [99, 100001, 100.5, NaN, Infinity]) {
    await assert.rejects(fetchPage('http://8.8.8.8', maxChars), {
      code: 'invalid_max_chars',
      message: 'invalid_max_chars',
    })
  }
  assert.equal(requests.length, 0)
})

test('comment-like text in an attribute does not hide the real title', async t => {
  upstream(t, [{ body: '<meta name="description" content="<!--"><title>Actual</title>' }])
  assert.equal((await fetchPage('http://8.8.8.8', 100)).title, 'Actual')
})
