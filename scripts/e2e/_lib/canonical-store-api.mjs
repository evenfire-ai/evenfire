// Development-only bound API client. Authentication material stays in this
// process and never enters shell arguments, files, logs or business receipts.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

function required(name) {
  const value = process.env[name]
  assert.ok(value, 'Missing ' + name)
  return value
}
export function endpointMap(filename, context) {
  assert.match(context, /^clerum-[a-z0-9][a-z0-9-]*-[0-9a-f]{8}$/)
  const values = new Map()
  for (const line of fs.readFileSync(filename, 'utf8').split('\n')) {
    const match = /^(CONTROL_API_URL|CONTROL_UI_URL|EXTERNAL_REST_API_URL|RPC_PROXY_URL)=(.*)$/.exec(line)
    if (!match) continue
    assert.ok(!values.has(match[1]), 'Duplicate profile endpoint')
    const url = new URL(match[2])
    assert.ok(['http:', 'https:'].includes(url.protocol))
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    assert.ok(url.port && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/')
    values.set(match[1], url.origin)
  }
  assert.equal(values.size, 4, 'Incomplete persisted profile map')
  return Object.fromEntries(values)
}
async function fetchJson(base, route, method = 'GET', body, headers = {}) {
  const response = await fetch(base + route, { method, redirect: 'error', signal: AbortSignal.timeout(180000),
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body) })
  let value
  try { value = await response.json() } catch { throw new Error('NonJsonApiResponse') }
  return { response, value }
}
async function broker(socket, hostRef, context, repoRoot) {
  assert.equal(context, required('MINIKUBE_PROFILE'))
  assert.equal(context, required('KUBECONTEXT'))
  assert.match(hostRef, /^[a-z][a-z0-9-]{0,62}$/)
  const endpoints = endpointMap(required('E2E_PROFILE_PORTS_ENV'), context)
  // Ownership precedes credential resolution and every network sign-in.
  execFileSync('bash', [path.join(repoRoot, 'scripts/minikube/require-t2-mutation-lock.sh')], { timeout: 20000, stdio: 'ignore', env: process.env })
  const parent = fs.lstatSync(path.dirname(socket))
  assert.ok(parent.isDirectory() && !parent.isSymbolicLink()); assert.equal(parent.mode & 0o777, 0o700)
  assert.ok(!fs.existsSync(socket))
  // Lazy getter keeps resolution at the request serialization boundary, after
  // lease/profile validation. It contains no embedded credential or default.
  const signedIn = await fetchJson(endpoints.EXTERNAL_REST_API_URL, '/api/v1/auth/password-login', 'POST', {
    email: required('E2E_DEV_LOGIN_EMAIL'), get password() { return required('E2E_USER_PASSWORD') },
  })
  assert.equal(signedIn.response.status, 200, 'Dedicated user sign-in failed')
  const userSession = signedIn.value.token; assert.equal(typeof userSession, 'string')
  const adminLogin = await fetchJson(endpoints.CONTROL_API_URL, '/api/v1/admin/auth/login', 'POST', {
    username: required('E2E_CONTROL_ADMIN_USERNAME'), get password() { return required('E2E_CONTROL_ADMIN_PASSWORD') },
  }, { origin: endpoints.CONTROL_UI_URL })
  assert.equal(adminLogin.response.status, 200, 'Dedicated administrator sign-in failed')
  const cookies = adminLogin.response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  assert.ok(cookies, 'HttpOnly administrator session missing')
  async function rpc(method, route, body) {
    const prefix = '/api/v1/rpc/hosts/' + hostRef
    const transcript = new RegExp('^' + prefix + '/sessions/' + hostRef + '/[A-Za-z0-9-]{1,160}/messages$')
    assert.ok((method === 'POST' && route === prefix + '/messages') || (method === 'GET' &&
      (transcript.test(route) || route === prefix + '/sessions?agent=' + hostRef + '&limit=100')))
    const mint = await fetchJson(endpoints.EXTERNAL_REST_API_URL, '/api/v1/rpc/token', 'POST', {
      hostRefs: [hostRef], scopes: ['host:message:invoke', 'host:session:read', 'host:status:read', 'host:health:read', 'host:wake:write'],
    }, { authorization: 'Bearer ' + userSession })
    assert.equal(mint.response.status, 200, 'Authorized RPC mint failed'); assert.equal(typeof mint.value.token, 'string')
    const result = await fetchJson(endpoints.RPC_PROXY_URL, route, method, body, { authorization: 'Bearer ' + mint.value.token })
    return { status: result.response.status, body: result.value }
  }
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/operation')
      let chunks = '', size = 0
      for await (const chunk of request) { size += chunk.length; assert.ok(size <= 1024 * 1024); chunks += chunk.toString() }
      const command = JSON.parse(chunks); let result
      if (command.operation === 'admin-get') {
        const fetched = await fetchJson(endpoints.CONTROL_API_URL, '/api/v1/admin/hosts/' + hostRef, 'GET', undefined, { cookie: cookies, origin: endpoints.CONTROL_UI_URL })
        result = { status: fetched.response.status, body: fetched.value }
      } else if (command.operation === 'admin-post') {
        assert.ok(['maintenance', 'prepare', 'adopt', 'release'].includes(command.kind))
        const fetched = await fetchJson(endpoints.CONTROL_API_URL, '/api/v1/admin/hosts/' + hostRef + '/conversation-store/' + command.kind,
          'POST', command.body, { cookie: cookies, origin: endpoints.CONTROL_UI_URL })
        result = { status: fetched.response.status, body: fetched.value }
      } else if (command.operation === 'rpc') result = await rpc(command.method, command.route, command.body)
      else throw new Error('Unsupported bound operation')
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result))
    } catch {
      response.writeHead(502, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'BoundApiOperationFailed' }))
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve) })
  fs.chmodSync(socket, 0o600); process.stdout.write('BOUND_CANONICAL_API_READY\n')
  const stop = () => { server.close(); server.closeAllConnections() }
  process.once('SIGTERM', stop); process.once('SIGINT', stop)
  const deadline = setTimeout(stop, 1800000)
  server.once('close', () => { clearTimeout(deadline); if (fs.existsSync(socket)) fs.unlinkSync(socket) })
}
async function client(socket) {
  const info = fs.lstatSync(socket)
  assert.ok(info.isSocket() && !info.isSymbolicLink()); assert.equal(info.mode & 0o777, 0o600)
  const body = fs.readFileSync(0, 'utf8'); assert.ok(Buffer.byteLength(body) <= 1024 * 1024)
  await new Promise((resolve, reject) => {
    const request = http.request({ socketPath: socket, path: '/operation', method: 'POST', timeout: 185000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, response => {
      let chunks = ''
      response.on('data', chunk => { chunks += chunk.toString(); if (chunks.length > 16 * 1024 * 1024) request.destroy(new Error('Response budget')) })
      response.once('end', () => {
        if (response.statusCode !== 200) { reject(new Error('Bound API operation failed')); return }
        const result = JSON.parse(chunks); assert.ok(Number.isInteger(result.status))
        process.stdout.write(JSON.stringify(result) + '\n'); resolve()
      }); response.once('error', reject)
    })
    request.once('timeout', () => request.destroy(new Error('Bound operation deadline'))); request.once('error', reject); request.end(body)
  })
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2]
  try {
    if (mode === 'broker') await broker(...process.argv.slice(3))
    else if (mode === 'client') await client(process.argv[3])
    else throw new Error('Unsupported mode')
  } catch { process.stderr.write('BoundCanonicalApiFailed\n'); process.exitCode = 1 }
}
