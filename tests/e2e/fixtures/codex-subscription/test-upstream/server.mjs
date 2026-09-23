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
// Optional canned model reply for the hermetic transport test. No MCP tool is
// executed; ordinary fixture runs retain the existing text-only response.
const fixtureToolCall = process.env.CODEX_TEST_UPSTREAM_TOOL_CALL
  ? JSON.parse(process.env.CODEX_TEST_UPSTREAM_TOOL_CALL)
  : undefined
// Optional repeat count for the canned call, used by the per-response
// tool-call limit tests. Unset keeps the single `call-hermetic-optional` reply.
const rawToolCallCount = process.env.CODEX_TEST_UPSTREAM_TOOL_CALL_COUNT
const fixtureToolCallCount = rawToolCallCount === undefined ? undefined : Number(rawToolCallCount)
if (
  fixtureToolCallCount !== undefined &&
  (!Number.isInteger(fixtureToolCallCount) || fixtureToolCallCount < 1 || !fixtureToolCall)
) {
  throw new Error(
    'CODEX_TEST_UPSTREAM_TOOL_CALL_COUNT must be an integer >= 1 and requires CODEX_TEST_UPSTREAM_TOOL_CALL'
  )
}
// Optional: drop the leading text delta so a limit failure happens before the
// proxy sends any SSE byte (HTTP status path instead of an SSE error frame).
const rawOmitText = process.env.CODEX_TEST_UPSTREAM_OMIT_TEXT
if (rawOmitText !== undefined && (rawOmitText !== '1' || fixtureToolCallCount === undefined)) {
  throw new Error(
    'CODEX_TEST_UPSTREAM_OMIT_TEXT must be "1" and requires CODEX_TEST_UPSTREAM_TOOL_CALL_COUNT'
  )
}
const fixtureOmitText = rawOmitText === '1'

// Optional: a second model id served alongside the baseline one. The catalog
// re-sync lane needs an upstream that offers a model the grant's seeded state
// does not carry, so that a model appearing in Control UI can only be the
// result of re-reading the catalog. Unset keeps the single-model reply every
// other lane expects, byte for byte.
const fixtureExtraModel = process.env.CODEX_TEST_UPSTREAM_EXTRA_MODEL || undefined
if (fixtureExtraModel !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(fixtureExtraModel)) {
  throw new Error(
    'CODEX_TEST_UPSTREAM_EXTRA_MODEL must be a model id of letters, digits, dot, underscore or hyphen'
  )
}

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
      const models = [{ id: 'gpt-5.3-codex', object: 'model' }]
      if (fixtureExtraModel) models.push({ id: fixtureExtraModel, object: 'model' })
      return json(response, 200, { data: models })
    }
    if (request.method === 'POST' && url.pathname === '/backend-api/codex/responses') {
      const body = JSON.parse((await readBody(request)) || '{}')
      if (fixtureToolCall && !body.tools?.some(tool => tool.name === fixtureToolCall.name)) {
        return json(response, 400, { error: 'fixture_tool_not_declared' })
      }
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
      if (!fixtureOmitText) {
        response.write(
          `event: response.output_text.delta\ndata: ${JSON.stringify({
            type: 'response.output_text.delta',
            delta: 'hello',
          })}\n\n`
        )
      }
      if (fixtureToolCall) {
        const callIds =
          fixtureToolCallCount === undefined
            ? ['call-hermetic-optional']
            : Array.from({ length: fixtureToolCallCount }, (_, index) => `call-hermetic-${index}`)
        for (const callId of callIds) {
          response.write(
            `data: ${JSON.stringify({
              type: 'response.output_item.done',
              item: {
                type: 'function_call',
                call_id: callId,
                name: fixtureToolCall.name,
                arguments: JSON.stringify(fixtureToolCall.arguments),
              },
            })}\n\n`
          )
        }
      }
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
