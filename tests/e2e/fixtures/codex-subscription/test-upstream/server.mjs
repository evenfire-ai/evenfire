#!/usr/bin/env node
/**
 * Test-only HTTPS upstream for Codex subscription acceptance.
 * Implements the frozen sanitised contract. Certificates are supplied at
 * runtime and must never be committed.
 */
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:https'

const PORT = Number(process.env.CODEX_TEST_UPSTREAM_PORT || 8443)
const cert = readFileSync(process.env.CODEX_TEST_UPSTREAM_CERT_PATH, 'utf8')
const key = readFileSync(process.env.CODEX_TEST_UPSTREAM_KEY_PATH, 'utf8')

const counters = {
  consent: 0,
  models: 0,
  streams: 0,
  cancels: 0,
  refresh: 0,
  revoke: 0,
}

const devices = new Map()
const tokens = new Map()
const streams = new Map()

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function issueToken(kind) {
  const accessToken = `test-access-${randomBytes(8).toString('hex')}`
  const refreshToken = `test-refresh-${randomBytes(8).toString('hex')}`
  tokens.set(accessToken, { kind, refreshToken, revoked: false })
  return { accessToken, refreshToken }
}

const server = createServer({ cert, key }, async (request, response) => {
  const url = new URL(request.url || '/', 'https://codex-test-upstream.local')
  try {
    if (request.method === 'GET' && url.pathname === '/healthz') {
      return json(response, 200, { ok: true, counters })
    }
    if (request.method === 'GET' && url.pathname === '/internal/counters') {
      return json(response, 200, counters)
    }
    if (request.method === 'GET' && url.pathname === '/oauth/authorize') {
      counters.consent += 1
      response.writeHead(302, { location: '/oauth/consent-complete' })
      return response.end()
    }
    if (request.method === 'POST' && url.pathname === '/api/accounts/deviceauth/usercode') {
      counters.consent += 1
      const deviceAuthId = `deviceauth_${randomBytes(6).toString('hex')}`
      devices.set(deviceAuthId, { approved: true, userCode: 'TEST-CODE' })
      return json(response, 200, {
        device_auth_id: deviceAuthId,
        user_code: 'TEST-CODE',
        interval: '1',
        expires_at: new Date(Date.now() + 300_000).toISOString(),
      })
    }
    if (request.method === 'POST' && url.pathname === '/api/accounts/deviceauth/token') {
      const body = JSON.parse((await readBody(request)) || '{}')
      const pending = devices.get(body.device_auth_id)
      if (!pending || pending.userCode !== body.user_code) {
        return json(response, 403, { error: { code: 'deviceauth_authorization_pending' } })
      }
      return json(response, 200, {
        authorization_code: `authz-${randomBytes(6).toString('hex')}`,
        code_challenge: 'test-challenge',
        code_verifier: 'test-verifier',
      })
    }
    if (request.method === 'POST' && url.pathname === '/oauth/token') {
      const body = await readBody(request)
      if (body.includes('refresh_token')) {
        counters.refresh += 1
      } else {
        counters.consent += 1
      }
      return json(response, 200, {
        ...issueToken('user'),
        token_type: 'Bearer',
        expires_in: 60,
      })
    }
    if (request.method === 'POST' && url.pathname === '/oauth/revoke') {
      counters.revoke += 1
      return json(response, 200, { revoked: true })
    }
    if (request.method === 'GET' && url.pathname === '/backend-api/codex/models') {
      counters.models += 1
      return json(response, 200, {
        data: [{ id: 'gpt-5.3-codex', object: 'model' }],
      })
    }
    if (request.method === 'POST' && url.pathname === '/backend-api/codex/responses') {
      counters.streams += 1
      const streamId = `resp-${randomBytes(6).toString('hex')}`
      streams.set(streamId, { cancelled: false })
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      })
      // The proxy transport parser (codexTransport.consumeSse) dispatches on
      // the `type` field INSIDE the data payload, exactly like the live
      // ChatGPT backend. `event:` lines alone are ignored, so frames without
      // an embedded type would leave the stream outcome `unknown`.
      response.write(
        `event: response.output_text.delta\ndata: ${JSON.stringify({
          type: 'response.output_text.delta',
          delta: 'hello',
        })}\n\n`
      )
      response.write(
        `event: response.completed\ndata: ${JSON.stringify({
          type: 'response.completed',
          id: streamId,
          usage: { input_tokens: 3, output_tokens: 1 },
        })}\n\n`
      )
      return response.end()
    }
    if (
      request.method === 'POST' &&
      url.pathname.startsWith('/backend-api/codex/responses/') &&
      url.pathname.endsWith('/cancel')
    ) {
      counters.cancels += 1
      const streamId = url.pathname.split('/')[4]
      const stream = streams.get(streamId)
      if (stream) stream.cancelled = true
      return json(response, 200, { cancelled: true, id: streamId })
    }
    return json(response, 404, { error: 'not_found' })
  } catch (error) {
    return json(response, 500, { error: error instanceof Error ? error.message : 'upstream_error' })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`codex-test-upstream listening on 127.0.0.1:${PORT}\n`)
})
