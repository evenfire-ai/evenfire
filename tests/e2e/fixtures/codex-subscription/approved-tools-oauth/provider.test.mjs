import assert from 'node:assert/strict'
import test from 'node:test'
import { createOAuthFixtureFetch, validateFixtureEnvironment } from './provider.mjs'

const base = 'https://auth.openai.com'
const env = {
  NODE_ENV: 'test',
  EVENFIRE_APPROVED_TOOLS_OAUTH_FIXTURE: '1',
  APPROVED_TOOLS_RUN_ID: 'approved-tools-123456abcdef',
  MINIKUBE_PROFILE: 'owned-test',
  CONTROL_API_REAL_PG_CONTEXT: 'owned-test',
  KUBERNETES_SERVICE_HOST: 'test-cluster',
}
function harness() {
  let time = 1000
  const delegated = []
  const fetch = createOAuthFixtureFetch(
    (...args) => {
      delegated.push(args)
      return 'delegated'
    },
    { now: () => time }
  )
  const post = (path, data) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      body: path === '/oauth/token' ? new URLSearchParams(data).toString() : JSON.stringify(data),
    })
  return {
    fetch,
    post,
    delegated,
    expire: () => {
      time += 300001
    },
  }
}
async function device(h) {
  return (await h.post('/api/accounts/deviceauth/usercode', { client_id: 'fixture-client' })).json()
}
async function exchange(h, start) {
  const poll = { device_auth_id: start.device_auth_id, user_code: start.user_code }
  assert.equal((await h.post('/api/accounts/deviceauth/token', poll)).status, 403)
  const code = await (await h.post('/api/accounts/deviceauth/token', poll)).json()
  return {
    grant_type: 'authorization_code',
    client_id: 'fixture-client',
    code: code.authorization_code,
    code_verifier: code.code_verifier,
    redirect_uri: `${base}/deviceauth/callback`,
  }
}
test('requires every isolated runtime binding', () => {
  validateFixtureEnvironment(env)
  for (const key of Object.keys(env))
    assert.throws(() => validateFixtureEnvironment({ ...env, [key]: '' }))
  assert.throws(() => validateFixtureEnvironment({ ...env, NODE_ENV: 'production' }))
  assert.throws(() =>
    validateFixtureEnvironment({ ...env, CONTROL_API_REAL_PG_CONTEXT: 'different' })
  )
})
test('pending, successful exchange, unique accounts and replay rejection', async () => {
  const h = harness()
  const subjects = new Set()
  for (let i = 0; i < 2; i++) {
    const body = await exchange(h, await device(h))
    const response = await h.post('/oauth/token', body)
    assert.equal(response.status, 200)
    const result = await response.json()
    const claims = JSON.parse(Buffer.from(result.id_token.split('.')[1], 'base64url'))
    assert.equal(claims.sub, claims['https://api.openai.com/auth'].chatgpt_account_id)
    subjects.add(claims.sub)
    assert.equal((await h.post('/oauth/token', body)).status, 400)
  }
  assert.equal(subjects.size, 2)
  assert.equal(h.delegated.length, 0)
})
test('rejects wrong bindings without consuming the valid exchange', async () => {
  const h = harness()
  const body = await exchange(h, await device(h))
  for (const key of Object.keys(body))
    assert.equal((await h.post('/oauth/token', { ...body, [key]: 'wrong' })).status, 400)
  assert.equal((await h.post('/oauth/token', body)).status, 200)
})
test('expired devices and exhausted capacity fail locally', async () => {
  const h = harness()
  const first = await device(h)
  for (let i = 1; i < 32; i++) await device(h)
  assert.equal(
    (await h.post('/api/accounts/deviceauth/usercode', { client_id: 'fixture-client' })).status,
    400
  )
  h.expire()
  assert.equal((await h.post('/api/accounts/deviceauth/token', first)).status, 400)
  assert.equal(
    (await h.post('/api/accounts/deviceauth/usercode', { client_id: 'fixture-client' })).status,
    200
  )
})
test('intercepts only the exact boundary and rejects unsupported input forms', async () => {
  const h = harness()
  const init = { method: 'POST', body: '{}' }
  assert.equal(await h.fetch('https://application.test/api/login', init), 'delegated')
  assert.deepEqual(h.delegated, [['https://application.test/api/login', init]])
  const url = `${base}/oauth/token`
  assert.equal((await h.fetch(`${base}/oauth/revoke`, init)).status, 400)
  assert.equal((await h.fetch(`${base}/oauth/authorize`, init)).status, 400)
  for (const [input, options] of [
    [url, {}],
    [url, { ...init, body: 'a'.repeat(16385) }],
    [`${url}?extra=1`, init],
    [new Request(url, init), {}],
  ]) {
    assert.equal((await h.fetch(input, options)).status, 400)
  }
  assert.equal(h.delegated.length, 1)
})
