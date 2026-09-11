import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { X509Certificate, generateKeyPairSync } from 'node:crypto'
import { once } from 'node:events'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  watch,
  writeFileSync,
} from 'node:fs'
import https from 'node:https'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import {
  createProxy,
  proxyUpstreamErrorRecord,
  validateCommand,
} from '../e2e/_lib/hcc-watch-api-proxy.mjs'
import { changedEnvironment, restorePatch, snapshot } from '../e2e/_lib/hcc-watch-config.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const allowedPath = '/api/v1/namespaces/mcp-server/services/runtime-witness'
const mcpPath = '/apis/clerum.io/v1alpha1/namespaces/mcp-server/mcpservers?watch=true'
const contextPath = '/apis/clerum.io/v1alpha1/namespaces/mcp-server/contexts?watch=true'
const otherPath = '/api/v1/namespaces/mcp-server/pods?watch=true'
let front
let upstreamTls
let publicConfig

test(
  'quiet upstream WATCH headers reach the client before its first body event',
  { timeout: 5000 },
  async () => {
    const controlDir = mkdtempSync(join(tmpdir(), 'hcc-quiet-watch-'))
    let upstreamResponse
    const upstream = https.createServer(upstreamTls, (_request, response) => {
      upstreamResponse = response
      response.writeHead(200, { 'content-type': 'application/json' })
      response.flushHeaders()
    })
    let proxy
    let client
    try {
      await new Promise(resolveListen => upstream.listen(0, '127.0.0.1', resolveListen))
      proxy = createProxy({
        ...front,
        upstreamCa: upstreamTls.cert,
        upstreamHost: '127.0.0.1',
        upstreamPort: upstream.address().port,
        allowedPaths: [],
        controlDir,
        periodMs: 60000,
        minAgeMs: 60000,
      })
      await new Promise(resolveListen => proxy.server.listen(0, '127.0.0.1', resolveListen))
      const headers = new Promise((resolveHeaders, rejectHeaders) => {
        client = https.get(
          {
            hostname: '127.0.0.1',
            port: proxy.server.address().port,
            path: mcpPath,
            servername: 'proxy-fixture.test-fixture.svc',
            ca: front.cert,
            rejectUnauthorized: true,
          },
          resolveHeaders
        )
        client.once('error', rejectHeaders)
      })
      // No upstream body is emitted until this assertion succeeds. A buffered
      // header block therefore cannot pass by riding along with an initial event.
      const response = await bounded(headers, 'quiet WATCH headers were not forwarded', 1000)
      assert.equal(response.statusCode, 200)
      assert.equal(response.headers['content-type'], 'application/json')
      const firstEvent = once(response, 'data')
      upstreamResponse.write('first-watch-event\n')
      const [bytes] = await bounded(firstEvent, 'first WATCH event was not forwarded')
      assert.equal(bytes.toString(), 'first-watch-event\n')
    } finally {
      client?.destroy()
      proxy?.close()
      upstream.closeAllConnections()
      await new Promise(resolveClose => upstream.close(resolveClose))
      rmSync(controlDir, { recursive: true, force: true })
    }
  }
)

test('upstream error records discard messages, headers, bodies and unrecognised codes', () => {
  const marker = 'synthetic-sensitive-material-must-not-appear'
  for (const code of ['ECONNRESET', 'ERR_TLS_CERT_ALTNAME_INVALID', marker, undefined]) {
    const record = proxyUpstreamErrorRecord(
      Object.assign(new Error(marker), {
        code,
        headers: { authorization: marker },
        body: marker,
        certificate: marker,
      })
    )
    assert.deepEqual(record, {
      event: 'hcc-fixture-upstream-error',
      code: code === 'ECONNRESET' || code === 'ERR_TLS_CERT_ALTNAME_INVALID' ? code : 'UNKNOWN',
    })
    assert.equal(JSON.stringify(record).includes(marker), false)
  }
})

test('actual positive probe emits only an allowed error code even with sensitive error fields', () => {
  const captured = spawnSync(
    '/bin/bash',
    [
      '-c',
      `
source "$HELPER"
E2E_HCC_PR_A=0 PROXY_NAME=fixture-proxy HCC_NS=fixture HCC_DEPLOY=fixture
kctl() { case "$1" in get) printf '10.0.0.1';; exec) shift 9; printf '%s' "$1" >&3; exit 0;; *) exit 1;; esac; }
verify_hcc_proxy_network_policy
`,
    ],
    {
      env: { ...process.env, HELPER: join(root, 'scripts/e2e/_lib/hcc-watch-recovery-fixture.sh') },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      timeout: 5000,
    }
  )
  assert.equal(captured.status, 0)
  const code = captured.output[3]
  assert.ok(code.includes('hcc-fixture-positive-probe-error'))
  const marker = 'synthetic-sensitive-material-must-not-appear'
  for (const failureCode of ['CERT_HAS_EXPIRED', marker]) {
    const records = []
    let exitCode
    let errorHandler
    const request = {
      setTimeout() {
        return request
      },
      on(event, handler) {
        if (event === 'error') errorHandler = handler
        return request
      },
      end() {
        errorHandler({
          code: failureCode,
          message: marker,
          headers: { authorization: marker },
          body: marker,
        })
      },
    }
    runInNewContext(code, {
      require: name =>
        name === 'fs' ? { readFileSync: () => Buffer.from(marker) } : { request: () => request },
      process: {
        argv: ['node', 'fixture-proxy', 'fixture-proxy', ''],
        exit: value => {
          exitCode = value
        },
      },
      console: { error: value => records.push(JSON.parse(value)) },
      setTimeout,
      clearTimeout,
      Buffer,
    })
    assert.equal(exitCode, 3)
    assert.deepEqual(records, [
      {
        event: 'hcc-fixture-positive-probe-error',
        code: failureCode === 'CERT_HAS_EXPIRED' ? failureCode : 'UNKNOWN',
      },
    ])
    assert.equal(JSON.stringify(records).includes(marker), false)
  }
  // A peer that never ends its response cannot extend the five-second wall
  // deadline through activity; expiration is explicit ETIMEDOUT, never success.
  let expire
  let expiredExit
  const expiredRecords = []
  const pending = {
    on() {
      return pending
    },
    end() {},
  }
  runInNewContext(code, {
    require: name =>
      name === 'fs' ? { readFileSync: () => Buffer.from(marker) } : { request: () => pending },
    process: {
      argv: ['node', 'fixture', 'fixture', ''],
      exit: value => {
        expiredExit = value
      },
    },
    console: { error: value => expiredRecords.push(JSON.parse(value)) },
    Buffer,
    setTimeout(callback, ms) {
      assert.equal(ms, 5000)
      expire = callback
      return 1
    },
    clearTimeout() {},
  })
  assert.equal(expiredExit, undefined)
  expire()
  assert.equal(expiredExit, 3)
  assert.deepEqual(expiredRecords, [
    { event: 'hcc-fixture-positive-probe-error', code: 'ETIMEDOUT' },
  ])
})

test('failed positive probe collects only bounded safe proxy event/code records before exit', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hcc-proxy-diagnostics-'))
  const marker = 'synthetic-sensitive-material-must-not-appear'
  try {
    const logs = join(directory, 'synthetic-logs')
    writeFileSync(
      logs,
      [
        marker,
        JSON.stringify({
          event: 'hcc-fixture-upstream-error',
          code: 'ECONNRESET',
          message: marker,
          body: marker,
        }),
        JSON.stringify({ event: 'hcc-fixture-upstream-error', code: marker }),
        JSON.stringify({ event: 'unrelated', code: 'ECONNRESET', message: marker }),
      ].join('\n')
    )
    const result = spawnSync(
      '/bin/bash',
      [
        '-c',
        `
set -euo pipefail
source "$HELPER"
E2E_HCC_PR_A=0 PROXY_NAME=fixture-proxy HCC_NS=fixture HCC_DEPLOY=fixture
kctl() { case "$1" in
  get) printf '10.0.0.1';;
  exec) return 3;;
  logs) [[ "$*" == *--tail=100* && "$*" == *--limit-bytes=32768* ]] || exit 9; cat "$FAKE_LOGS";;
  *) exit 1;; esac; }
die() { exit 1; }
verify_hcc_proxy_network_policy
`,
      ],
      {
        env: {
          ...process.env,
          HELPER: join(root, 'scripts/e2e/_lib/hcc-watch-recovery-fixture.sh'),
          FAKE_LOGS: logs,
        },
        encoding: 'utf8',
        timeout: 5000,
      }
    )
    assert.equal(result.status, 1)
    assert.deepEqual(JSON.parse(result.stdout), {
      event: 'hcc-fixture-upstream-error',
      code: 'ECONNRESET',
    })
    assert.equal((result.stdout + result.stderr).includes(marker), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('projected-file symlink CLI enters startup and fails loud without fixture mounts', () => {
  // ConfigMap projection resolves import.meta.url to a timestamped real path,
  // while argv[1] retains the projected symlink. Never create root mounts or
  // open the proxy listener in this entry-point regression.
  assert.equal(existsSync('/fixture-tls'), false, 'test requires no root fixture mount')
  const directory = mkdtempSync(join(tmpdir(), 'hcc-proxy-entry-'))
  try {
    const entry = join(directory, 'projected-proxy.mjs')
    symlinkSync(join(root, 'scripts/e2e/_lib/hcc-watch-api-proxy.mjs'), entry)
    const result = spawnSync(process.execPath, [entry], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 65536,
    })
    assert.equal(result.error, undefined, 'CLI terminated without a runner error')
    assert.notEqual(result.status, 0, 'projected CLI must not silently exit successfully')
    assert.equal(result.stdout, '')
    assert.equal(result.stderr.includes('ENOENT'), true, 'startup attempted its required mount')
    assert.equal(
      result.stderr.includes('/fixture-tls/tls.key'),
      true,
      'failure is the expected missing fixture mount'
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

function certificate() {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  const result = spawnSync(
    '/bin/sh',
    [
      '-c',
      "exec 3<&0; trap 'kill \"$signer\" 2>/dev/null; wait \"$signer\" 2>/dev/null; exit 143' TERM; cat <&3 | openssl \"$@\" & signer=$!; exec 3<&-; wait \"$signer\"",
      'openssl',
      'req',
      '-new',
      '-x509',
      '-key',
      '/dev/stdin',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
    ],
    {
      input: privateKey,
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 1048576,
    }
  )
  assert.equal(result.status, 0, 'in-memory certificate generation succeeds')
  return { key: privateKey, cert: result.stdout }
}

before(() => {
  const result = spawnSync(
    process.execPath,
    [
      join(root, 'scripts/e2e/_lib/hcc-watch-tls-manifest.mjs'),
      'proxy-fixture',
      'test-fixture',
      'run-fixture',
      join(root, 'scripts/e2e/_lib/hcc-watch-api-proxy.mjs'),
    ],
    {
      encoding: 'utf8',
      timeout: 20000,
      maxBuffer: 1048576,
    }
  )
  // Captured generator output stays in memory and is never printed in diagnostics.
  assert.equal(result.status, 0, 'fixture manifest generator succeeds')
  let manifest
  try {
    manifest = JSON.parse(result.stdout)
  } catch {
    throw new Error('fixture generator did not emit JSON')
  }
  assert.equal(manifest.kind, 'List')
  assert.equal(manifest.apiVersion, 'v1')
  assert.equal(manifest.items.length, 2)
  const tlsResource = manifest.items.find(item => item.kind === 'Secret')
  const configMap = manifest.items.find(item => item.kind === 'ConfigMap')
  assert.equal(tlsResource?.type, 'kubernetes.io/tls')
  assert.equal(tlsResource?.metadata.namespace, 'test-fixture')
  assert.equal(tlsResource?.metadata.labels['e2e.clerum.io/run'], 'run-fixture')
  assert.equal(typeof tlsResource?.stringData['tls.key'], 'string')
  front = { key: tlsResource.stringData['tls.key'], cert: tlsResource.stringData['tls.crt'] }
  const cert = new X509Certificate(front.cert)
  assert.equal(cert.checkHost('proxy-fixture.test-fixture.svc'), 'proxy-fixture.test-fixture.svc')
  assert.equal(cert.ca, true)
  publicConfig = JSON.parse(configMap.data['config.json'])
  assert.equal(
    configMap.data['proxy.mjs'] ===
      readFileSync(join(root, 'scripts/e2e/_lib/hcc-watch-api-proxy.mjs'), 'utf8'),
    true
  )
  assert.equal(
    JSON.stringify(configMap).includes(JSON.stringify(front.key).slice(1, -1)),
    false,
    'public config excludes signing material'
  )
  upstreamTls = certificate()
})

function bounded(promise, message, timeoutMs = 4000) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    }),
  ]).finally(() => clearTimeout(timer))
}
function ack(controlDir, id, state, filename = 'ack.json') {
  return new Promise((resolveAck, reject) => {
    let observer
    const done = (error, value) => {
      clearTimeout(timer)
      observer?.close()
      if (error) reject(error)
      else resolveAck(value)
    }
    const read = () => {
      let value
      try {
        value = JSON.parse(readFileSync(join(controlDir, filename), 'utf8'))
      } catch {
        return
      }
      if (value.id === id && value.state === state) done(null, value)
    }
    const timer = setTimeout(
      () => done(new Error(`control acknowledgement missing: ${state}`)),
      4000
    )
    observer = watch(controlDir, read)
    read()
  })
}
async function fixture(run, { wrongCa = false } = {}) {
  const controlDir = mkdtempSync(join(tmpdir(), 'hcc-proxy-test-'))
  const requests = []
  const responses = new Map()
  const upstream = https.createServer(upstreamTls, (request, response) => {
    requests.push({
      path: request.url,
      method: request.method,
      authorization: request.headers.authorization,
    })
    if (request.url === '/opaque') {
      response.destroy()
      return
    }
    if (request.url.includes('watch=true')) {
      responses.set(request.url, response)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('watch-start\n')
    } else {
      response.writeHead(request.url === '/status' ? 418 : 200, { 'content-type': 'text/plain' })
      response.end('upstream-response')
    }
  })
  upstream.on('tlsClientError', () => {})
  await new Promise(resolveListen => upstream.listen(0, '127.0.0.1', resolveListen))
  const proxy = createProxy({
    ...front,
    upstreamCa: wrongCa ? front.cert : upstreamTls.cert,
    upstreamHost: '127.0.0.1',
    upstreamPort: upstream.address().port,
    allowedPaths: [allowedPath],
    controlDir,
    periodMs: 60000,
    minAgeMs: 60000,
  })
  await new Promise(resolveListen => proxy.server.listen(0, '127.0.0.1', resolveListen))
  const clients = new Set()
  const request = (path, method = 'GET') => {
    let responseResolve
    let responseReject
    const opened = new Promise((resolveResponse, reject) => {
      responseResolve = resolveResponse
      responseReject = reject
    })
    const req = https.request({
      hostname: '127.0.0.1',
      port: proxy.server.address().port,
      servername: 'proxy-fixture.test-fixture.svc',
      ca: front.cert,
      rejectUnauthorized: true,
      method,
      path,
      headers: { authorization: 'Bearer test' },
      agent: false,
    })
    clients.add(req)
    let body = ''
    const completed = new Promise((resolveResponse, reject) => {
      req.on('response', response => {
        responseResolve(response)
        response.on('data', chunk => {
          body += chunk
        })
        response.on('end', () => resolveResponse({ status: response.statusCode, body }))
        response.on('error', reject)
      })
      req.on('error', error => {
        responseReject(error)
        reject(error)
      })
    })
    opened.catch(() => {})
    completed.catch(() => {})
    req.end()
    return {
      req,
      opened,
      completed,
      get body() {
        return body
      },
    }
  }
  const command = async (value, state) => {
    const waiting = ack(controlDir, value.id, state)
    writeFileSync(join(controlDir, 'command.json'), JSON.stringify(value), { mode: 0o600 })
    return waiting
  }
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    const stopped = once(proxy.server, 'close')
    proxy.close()
    await bounded(stopped, 'proxy server did not close')
  }
  try {
    await run({ request, command, controlDir, requests, responses, close })
  } finally {
    try {
      await close()
    } finally {
      for (const client of clients) client.destroy()
      upstream.closeAllConnections()
      await bounded(
        new Promise(resolveClose => upstream.close(resolveClose)),
        'upstream did not close'
      )
      rmSync(controlDir, { recursive: true, force: true })
    }
  }
}
async function watchStarted(stream) {
  const response = await bounded(stream.opened, 'watch response not opened')
  if (!stream.body.includes('watch-start'))
    await bounded(once(response, 'data'), 'watch did not flow')
  assert.equal(stream.body.includes('watch-start'), true)
  return response
}

test('generator emits public CA trust and service-account tokenFile provider', () => {
  const cluster = publicConfig.clusters[0].cluster
  assert.equal(cluster.server, 'https://proxy-fixture.test-fixture.svc:443')
  assert.equal(
    Buffer.from(cluster['certificate-authority-data'], 'base64').equals(Buffer.from(front.cert)),
    true
  )
  assert.equal('insecure-skip-tls-verify' in cluster, false)
  const user = publicConfig.users[0].user
  assert.equal(user['auth-provider'].name, 'tokenFile')
  assert.equal(
    user['auth-provider'].config.tokenFile,
    '/var/run/secrets/kubernetes.io/serviceaccount/token'
  )
  assert.deepEqual(Object.keys(user), ['auth-provider'])
  assert.equal(publicConfig['current-context'], 'fixture')
})
test('commands reject invalid id, method, path, duration and cut scope', () => {
  const valid = { action: 'arm', id: 'valid-1', method: 'GET', path: allowedPath, durationMs: 1000 }
  assert.equal(validateCommand(valid, [allowedPath]), valid)
  for (const change of [
    { id: '../escape' },
    { id: true },
    { id: 123 },
    { method: 'POST' },
    { path: '/api/v1/pods' },
    { durationMs: 999 },
    { durationMs: 25001 },
    { durationMs: 1000.5 },
    { action: 'unknown' },
  ]) {
    assert.throws(() => validateCommand({ ...valid, ...change }, [allowedPath]))
  }
  assert.throws(() => validateCommand({ action: 'cut', id: 'cut-1', kind: 'Pod' }, [allowedPath]))
})
test(
  'verified HTTPS forwards status and synthetic authorization; upstream errors are opaque',
  { timeout: 10000 },
  async () => {
    await fixture(async ({ request, requests }) => {
      const result = await bounded(request('/status').completed, 'short response absent')
      assert.equal(result.status, 418)
      assert.equal(result.body, 'upstream-response')
      assert.equal(requests[0].authorization === 'Bearer test', true)
      await assert.rejects(bounded(request('/opaque').completed, 'error response absent'), {
        code: 'ECONNRESET',
      })
    })
  }
)
test('wrong upstream CA cannot produce a successful response', { timeout: 10000 }, async () => {
  await fixture(
    async ({ request, requests }) => {
      await assert.rejects(
        bounded(request('/status').completed, 'untrusted response did not settle'),
        { code: 'ECONNRESET' }
      )
      assert.equal(requests.length, 0)
    },
    { wrongCa: true }
  )
})
test(
  'exact GET pause acknowledges interception and release while watches keep flowing',
  { timeout: 10000 },
  async () => {
    await fixture(async ({ request, command, controlDir, requests, responses }) => {
      const stream = request(mcpPath)
      const response = await watchStarted(stream)
      await command(
        { action: 'arm', id: 'arm-release', path: allowedPath, method: 'GET', durationMs: 5000 },
        'armed'
      )
      assert.equal(
        (await bounded(request('/status').completed, 'unrelated short request paused')).status,
        418
      )
      assert.equal(
        (await bounded(request(allowedPath, 'POST').completed, 'POST was incorrectly paused'))
          .status,
        200
      )
      const intercepted = ack(controlDir, 'arm-release', 'intercepted')
      const held = request(allowedPath)
      await intercepted
      assert.equal(
        requests.some(value => value.path === allowedPath && value.method === 'GET'),
        false
      )
      const flowing = once(response, 'data')
      responses.get(mcpPath).write('watch-during-pause\n')
      await bounded(flowing, 'watch stalled behind short request')
      assert.equal(stream.body.includes('watch-during-pause'), true)
      await command({ action: 'release', id: 'release-1', pauseId: 'arm-release' }, 'released')
      assert.equal((await bounded(held.completed, 'held GET did not resume')).status, 200)
      assert.equal(
        requests.filter(value => value.path === allowedPath && value.method === 'GET').length,
        1
      )
    })
  }
)
test(
  'minimum pause expires and resumes the actual intercepted request',
  { timeout: 10000 },
  async () => {
    await fixture(async ({ request, command, controlDir, requests }) => {
      await command(
        { action: 'arm', id: 'arm-expiry', path: allowedPath, method: 'GET', durationMs: 1000 },
        'armed'
      )
      const intercepted = ack(controlDir, 'arm-expiry', 'intercepted')
      const held = request(allowedPath)
      await intercepted
      assert.equal(
        requests.some(value => value.path === allowedPath && value.method === 'GET'),
        false
      )
      await ack(controlDir, 'arm-expiry', 'expired', 'pause.json')
      await command({ action: 'release', id: 'release-expired', pauseId: 'arm-expiry' }, 'rejected')
      assert.equal(
        JSON.parse(readFileSync(join(controlDir, 'pause.json'), 'utf8')).state,
        'expired'
      )
      assert.equal((await bounded(held.completed, 'expired GET did not resume')).status, 200)
    })
  }
)
test(
  'cut targets only the selected watch kind and preserves short requests and other streams',
  { timeout: 10000 },
  async () => {
    await fixture(async ({ request, command, controlDir, responses }) => {
      const mcp = request(mcpPath)
      const context = request(contextPath)
      const other = request(otherPath)
      await watchStarted(mcp)
      const contextResponse = await watchStarted(context)
      const otherResponse = await watchStarted(other)
      await command(
        { action: 'arm', id: 'arm-cut', path: allowedPath, method: 'GET', durationMs: 5000 },
        'armed'
      )
      const intercepted = ack(controlDir, 'arm-cut', 'intercepted')
      const held = request(allowedPath)
      await intercepted
      const pauseBeforeCut = await ack(controlDir, 'arm-cut', 'intercepted', 'pause.json')
      const cut = await command({ action: 'cut', id: 'cut-mcp', kind: 'McpServer' }, 'cut')
      assert.deepEqual(
        JSON.parse(readFileSync(join(controlDir, 'pause.json'), 'utf8')),
        pauseBeforeCut
      )
      assert.equal(cut.count, 1)
      await assert.rejects(bounded(mcp.completed, 'MCP watch did not close'))
      for (const [path, response, stream] of [
        [contextPath, contextResponse, context],
        [otherPath, otherResponse, other],
      ]) {
        const flowing = once(response, 'data')
        responses.get(path).write('survived-cut\n')
        await bounded(flowing, 'unselected stream was cut')
        assert.equal(stream.body.includes('survived-cut'), true)
      }
      await command({ action: 'release', id: 'release-cut', pauseId: 'arm-cut' }, 'released')
      assert.equal((await bounded(held.completed, 'short request was cut')).status, 200)
      const both = await command({ action: 'cut', id: 'cut-both', kind: 'both' }, 'cut')
      assert.equal(both.count, 1)
      await assert.rejects(bounded(context.completed, 'Context watch survived both cut'))
      const flowing = once(otherResponse, 'data')
      responses.get(otherPath).write('survived-both\n')
      await bounded(flowing, 'both cut unrelated watch')
      assert.equal(other.body.includes('survived-both'), true)
    })
  }
)
test(
  'close tears down active watches and an armed intercepted request',
  { timeout: 10000 },
  async () => {
    await fixture(async ({ request, command, controlDir, close }) => {
      const stream = request(mcpPath)
      await watchStarted(stream)
      await command(
        { action: 'arm', id: 'arm-close', path: allowedPath, method: 'GET', durationMs: 25000 },
        'armed'
      )
      const intercepted = ack(controlDir, 'arm-close', 'intercepted')
      const held = request(allowedPath)
      await intercepted
      await close()
      await assert.rejects(bounded(stream.completed, 'watch survived shutdown'))
      await assert.rejects(bounded(held.completed, 'held request survived shutdown'))
    })
  }
)

// Apply the emitted JSON Patch to a cloned in-memory Deployment.
function applyPatch(deployment, patches) {
  const result = structuredClone(deployment)
  for (const patch of patches) {
    const keys = patch.path.slice(1).split('/')
    const parent = keys.slice(0, -1).reduce((value, key) => value[key], result)
    const key = keys.at(-1)
    if (patch.op === 'test') assert.deepEqual(parent[key], patch.value)
    else if (patch.op === 'add') parent[key] = structuredClone(patch.value)
    else if (patch.op === 'remove') delete parent[key]
    else throw new Error('unexpected restore operation')
  }
  return result
}
function deploymentFixture() {
  return {
    metadata: { uid: 'deployment-fixture-uid', resourceVersion: '1' },
    spec: {
      template: {
        spec: {
          containers: [
            { name: 'sidecar', env: [{ name: 'SIDECAR', value: 'untouched' }] },
            { name: 'host-context-controller' },
          ],
        },
      },
    },
  }
}
function injectFixture(deployment) {
  const result = structuredClone(deployment)
  const pod = result.spec.template.spec
  const container = pod.containers.find(value => value.name === 'host-context-controller')
  container.env = [
    ...(container.env ?? []).filter(value => !changedEnvironment.includes(value.name)),
    ...changedEnvironment.map(name => ({ name, value: 'fixture-value' })),
  ]
  pod.volumes = [
    ...(pod.volumes ?? []),
    { name: 'hcc-pr-a-config', configMap: { name: 'fixture-config' } },
  ]
  container.volumeMounts = [
    ...(container.volumeMounts ?? []),
    { name: 'hcc-pr-a-config', mountPath: '/fixture-config' },
  ]
  return result
}
test('config restore removes fixture-added fields that were originally absent', () => {
  const original = deploymentFixture()
  const saved = snapshot(original)
  assert.equal(saved.envPresent, false)
  assert.equal(saved.volumesPresent, false)
  assert.equal(saved.mountsPresent, false)
  assert.equal(changedEnvironment.includes('KUBERNETES_SERVICE_HOST'), false)
  assert.equal(changedEnvironment.includes('KUBERNETES_SERVICE_PORT'), false)
  assert.equal('aliases' in saved, false)
  assert.equal('aliasesPresent' in saved, false)
  const restored = applyPatch(injectFixture(original), restorePatch(saved, injectFixture(original)))
  assert.deepEqual(restored, original)
})
test('config snapshot is public-only and restore preserves unrelated environment edits', () => {
  const original = deploymentFixture()
  const pod = original.spec.template.spec
  const container = pod.containers[1]
  container.env = [
    { name: 'KUBECONFIG', value: '/previous/config' },
    { name: 'UNRELATED', value: 'not-in-public-snapshot' },
  ]
  container.volumeMounts = [{ name: 'existing', mountPath: '/existing' }]
  pod.volumes = [{ name: 'existing', emptyDir: {} }]
  pod.hostAliases = [{ ip: '127.0.0.3', hostnames: ['original.test'] }]
  const saved = snapshot(original)
  assert.deepEqual(saved.env, [{ name: 'KUBECONFIG', value: '/previous/config' }])
  assert.equal(JSON.stringify(saved).includes('not-in-public-snapshot'), false)
  const changed = injectFixture(original)
  changed.spec.template.spec.containers[1].env.find(value => value.name === 'UNRELATED').value =
    'concurrent-public-edit'
  const restored = applyPatch(changed, restorePatch(saved, changed))
  const restoredContainer = restored.spec.template.spec.containers[1]
  assert.equal(
    restoredContainer.env.find(value => value.name === 'UNRELATED').value,
    'concurrent-public-edit'
  )
  assert.equal(
    restoredContainer.env.find(value => value.name === 'KUBECONFIG').value,
    '/previous/config'
  )
  assert.deepEqual(snapshot(restored), saved)
  assert.deepEqual(
    restored.spec.template.spec.containers[0],
    original.spec.template.spec.containers[0]
  )
})
test('config snapshot and restore reject collisions, identity replacement and unrelated mount changes', () => {
  const original = deploymentFixture()
  const saved = snapshot(original)
  assert.throws(() => snapshot(injectFixture(original)), /fixture_mount_collision/)
  const replaced = injectFixture(original)
  replaced.metadata.uid = 'different-deployment'
  assert.throws(() => restorePatch(saved, replaced), /deployment_uid_changed/)
  const removed = injectFixture(original)
  removed.spec.template.spec.containers = []
  assert.throws(() => restorePatch(saved, removed), /deployment_container_missing/)
  for (const field of ['volumes', 'volumeMounts']) {
    const changed = injectFixture(original)
    const target =
      field === 'volumes' ? changed.spec.template.spec : changed.spec.template.spec.containers[1]
    target[field].push({ name: 'unrelated-new-mount' })
    assert.throws(() => restorePatch(saved, changed), /unrelated_configuration_changed/)
  }
})

test('release requires a valid original pause identity', () => {
  for (const pauseId of [undefined, '', true, 123, '../wrong']) {
    assert.throws(() =>
      validateCommand({ action: 'release', id: 'release-invalid', pauseId }, [allowedPath])
    )
  }
  assert.equal(
    validateCommand({ action: 'release', id: 'release-valid', pauseId: 'arm-valid' }, [allowedPath])
      .pauseId,
    'arm-valid'
  )
})

test(
  'absent or mismatched pause cannot be released or resume an intercepted GET',
  { timeout: 10000 },
  async () => {
    await fixture(async ({ request, command, controlDir, requests }) => {
      await command({ action: 'release', id: 'release-absent', pauseId: 'never-armed' }, 'rejected')
      await command(
        { action: 'arm', id: 'arm-identity', path: allowedPath, method: 'GET', durationMs: 5000 },
        'armed'
      )
      await command(
        { action: 'release', id: 'release-not-intercepted', pauseId: 'arm-identity' },
        'rejected'
      )
      assert.equal(JSON.parse(readFileSync(join(controlDir, 'pause.json'), 'utf8')).state, 'armed')
      const intercepted = ack(controlDir, 'arm-identity', 'intercepted', 'pause.json')
      const held = request(allowedPath)
      const ledger = await intercepted
      await command(
        { action: 'release', id: 'release-wrong', pauseId: 'different-arm' },
        'rejected'
      )
      assert.deepEqual(JSON.parse(readFileSync(join(controlDir, 'pause.json'), 'utf8')), ledger)
      assert.equal(
        requests.some(value => value.path === allowedPath),
        false
      )
      await command(
        { action: 'release', id: 'release-correct', pauseId: 'arm-identity' },
        'released'
      )
      const released = await ack(controlDir, 'arm-identity', 'released', 'pause.json')
      assert.equal(Number.isFinite(released.at), true)
      assert.equal(
        (await bounded(held.completed, 'correctly released GET did not resume')).status,
        200
      )
    })
  }
)

test('config restore compare-and-swap rejects a newer Deployment revision', () => {
  const original = deploymentFixture()
  const changed = injectFixture(original)
  changed.metadata.resourceVersion = '2'
  const missingRevision = structuredClone(changed)
  delete missingRevision.metadata.resourceVersion
  assert.throws(
    () => restorePatch(snapshot(original), missingRevision),
    /deployment_resource_version_missing/
  )
  const patches = restorePatch(snapshot(original), changed)
  assert.equal(
    patches.some(
      patch =>
        patch.op === 'test' && patch.path === '/metadata/resourceVersion' && patch.value === '2'
    ),
    true
  )
  const concurrent = structuredClone(changed)
  concurrent.metadata.resourceVersion = '3'
  assert.throws(() => applyPatch(concurrent, patches))
  assert.equal(applyPatch(changed, patches).metadata.resourceVersion, '2')
})

test('config restoration preserves new host aliases outside fixture ownership', () => {
  const original = deploymentFixture()
  original.spec.template.spec.hostAliases = [{ ip: '127.0.0.3', hostnames: ['original.test'] }]
  const changed = injectFixture(original)
  const aliases = [{ ip: '127.0.0.4', hostnames: ['concurrent.test'] }]
  changed.spec.template.spec.hostAliases = aliases
  const patches = restorePatch(snapshot(original), changed)
  assert.equal(
    patches.some(patch => patch.path.includes('hostAliases')),
    false
  )
  assert.deepEqual(applyPatch(changed, patches).spec.template.spec.hostAliases, aliases)
})

test('TLS fixture timeout terminates its signer', { timeout: 25000 }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'hcc-signer-timeout-'))
  const pidPath = join(directory, 'signer.pid')
  const signerPath = join(directory, 'signer.cjs')
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
  let signerPid
  try {
    writeFileSync(signerPath,
      `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); process.stdin.resume(); setTimeout(() => {}, 30000)`)
    writeFileSync(join(directory, 'openssl'),
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(signerPath)}\n`, { mode: 0o700 })
    const result = spawnSync(process.execPath, [
      join(root, 'scripts/e2e/_lib/hcc-watch-tls-manifest.mjs'),
      'timeout-fixture', 'test-fixture', 'run-fixture',
      join(root, 'scripts/e2e/_lib/hcc-watch-api-proxy.mjs'),
    ], { env: { PATH: `${directory}:/usr/bin:/bin` },
      encoding: 'utf8', timeout: 22000, maxBuffer: 1048576 })
    signerPid = Number(readFileSync(pidPath, 'utf8'))
    assert.equal(result.error, undefined, 'the generator enforces its own deadline')
    assert.equal(result.status, 1, 'signing timeout fails closed')
    assert.equal(result.stdout, '', 'no partial manifest is emitted')
    assert.match(result.stderr, /fixture_certificate_generation_failed/)
    assert.throws(() => process.kill(signerPid, 0), { code: 'ESRCH' }, 'signer was reaped')
  } finally {
    if (signerPid) {
      try { process.kill(signerPid, 'SIGKILL') } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
    rmSync(directory, { recursive: true, force: true })
  }
})
