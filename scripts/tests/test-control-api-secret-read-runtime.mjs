import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'
import {
  DEFAULT_CONTROL_API_PORT,
  LOGIN_PATH,
  MAX_RESPONSE_BODY_BYTES,
  adminRequest,
  controlApiPort,
  login,
  requestControlApi,
  runFromInput,
  sessionCookieFrom,
} from '../e2e/_lib/control-api-secret-read-runtime.mjs'

const COOKIE = 'control_ui_admin_session=s3ss10n'

// Fake node:http request: records the options and written payload, then emits
// the scripted response (or never answers, to exercise the deadline).
function fakeRequestFactory({ status = 200, headers = {}, chunks = [], respond = true } = {}) {
  const calls = []
  const factory = (options, onResponse) => {
    const request = new EventEmitter()
    const call = { options, written: [] }
    calls.push(call)
    request.write = payload => call.written.push(Buffer.from(payload).toString('utf8'))
    request.destroy = error => {
      call.destroyed = error
      request.emit('error', error)
    }
    request.end = () => {
      if (!respond) return
      setImmediate(() => {
        const response = new EventEmitter()
        response.statusCode = status
        response.headers = headers
        onResponse(response)
        for (const chunk of chunks) {
          if (call.destroyed) return
          response.emit('data', Buffer.from(chunk))
        }
        if (!call.destroyed) response.emit('end')
      })
    }
    return request
  }
  return { factory, calls }
}

describe('controlApiPort', () => {
  it('uses the control-api default when CONTROL_API_PORT is unset or blank', () => {
    assert.equal(controlApiPort({}), DEFAULT_CONTROL_API_PORT)
    assert.equal(controlApiPort({ CONTROL_API_PORT: '  ' }), DEFAULT_CONTROL_API_PORT)
  })

  it('uses CONTROL_API_PORT when the pod sets it', () => {
    assert.equal(controlApiPort({ CONTROL_API_PORT: '9191' }), 9191)
  })

  it('rejects a malformed or out-of-range port instead of guessing', () => {
    for (const value of ['0', '08090', 'abc', '8090x', '70000', '-1']) {
      assert.throws(() => controlApiPort({ CONTROL_API_PORT: value }), /control_api_port_invalid/)
    }
  })
})

describe('requestControlApi', () => {
  it('sends the method, path, headers and JSON body to the pod loopback', async () => {
    const { factory, calls } = fakeRequestFactory({ status: 201, chunks: ['{"ok":', 'true}'] })
    const result = await requestControlApi({
      port: 9191,
      method: 'PUT',
      path: '/api/v1/admin/secrets',
      headers: { cookie: COOKIE },
      body: '{"name":"x"}',
      requestFactory: factory,
    })
    assert.equal(calls.length, 1)
    const { options, written } = calls[0]
    assert.equal(options.hostname, '127.0.0.1')
    assert.equal(options.port, 9191)
    assert.equal(options.method, 'PUT')
    assert.equal(options.path, '/api/v1/admin/secrets')
    assert.equal(options.headers.cookie, COOKIE)
    assert.equal(options.headers['content-type'], 'application/json')
    assert.equal(options.headers['content-length'], Buffer.byteLength('{"name":"x"}'))
    assert.deepEqual(written, ['{"name":"x"}'])
    assert.deepEqual(result, { status: 201, headers: {}, text: '{"ok":true}' })
  })

  it('refuses a path outside /api/v1/ without opening a request', async () => {
    const { factory, calls } = fakeRequestFactory()
    await assert.rejects(
      requestControlApi({ port: 1, method: 'GET', path: '//evil/x', requestFactory: factory }),
      /control_api_path_invalid/
    )
    assert.equal(calls.length, 0)
  })

  it('fails when the response exceeds the body cap', async () => {
    const { factory, calls } = fakeRequestFactory({
      chunks: ['x'.repeat(MAX_RESPONSE_BODY_BYTES), 'y'],
    })
    await assert.rejects(
      requestControlApi({ port: 1, method: 'GET', path: '/api/v1/x', requestFactory: factory }),
      /control_api_response_too_large/
    )
    assert.equal(calls.length, 1)
  })

  // The test timeout turns a missing deadline into a failure instead of a hang.
  it('fails on the wall-clock deadline when the server never answers', { timeout: 2_000 }, async () => {
    const { factory, calls } = fakeRequestFactory({ respond: false })
    // The module unrefs its deadline; hold the event loop open until it fires.
    const keepAlive = setTimeout(() => {}, 1_000)
    await assert.rejects(
      requestControlApi({
        port: 1,
        method: 'GET',
        path: '/api/v1/x',
        timeoutMs: 20,
        requestFactory: factory,
      }),
      /control_api_request_timeout/
    )
    clearTimeout(keepAlive)
    assert.equal(calls.length, 1)
  })
})

describe('sessionCookieFrom', () => {
  it('extracts only the session cookie pair, without attributes', () => {
    assert.equal(
      sessionCookieFrom(['other=1; Path=/', `${COOKIE}; HttpOnly; Path=/; SameSite=Strict`]),
      COOKIE
    )
    assert.equal(sessionCookieFrom(`${COOKIE}; HttpOnly`), COOKIE)
  })

  it('returns null when the session cookie is absent or empty', () => {
    assert.equal(sessionCookieFrom(undefined), null)
    assert.equal(sessionCookieFrom(['other=1']), null)
    assert.equal(sessionCookieFrom(['control_ui_admin_session=; Max-Age=0']), null)
  })
})

describe('login', () => {
  it('posts the credentials to the login route and returns the cookie', async () => {
    const seen = []
    const cookie = await login({
      env: {},
      username: 'admin',
      password: 'pw',
      requestImpl: async options => {
        seen.push(options)
        return { status: 200, headers: { 'set-cookie': [`${COOKIE}; HttpOnly`] }, text: '{}' }
      },
    })
    assert.equal(cookie, COOKIE)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].method, 'POST')
    assert.equal(seen[0].path, LOGIN_PATH)
    assert.equal(seen[0].port, DEFAULT_CONTROL_API_PORT)
    assert.deepEqual(JSON.parse(seen[0].body), { username: 'admin', password: 'pw' })
  })

  it('fails on a non-200 login, naming only the status', async () => {
    await assert.rejects(
      login({
        env: {},
        username: 'admin',
        password: 'pw',
        requestImpl: async () => ({ status: 401, headers: {}, text: '{"error":"bad"}' }),
      }),
      error => error.message === 'control_api_login_http_401'
    )
  })

  it('fails on a 200 without a session cookie', async () => {
    await assert.rejects(
      login({
        env: {},
        username: 'admin',
        password: 'pw',
        requestImpl: async () => ({ status: 200, headers: {}, text: '{}' }),
      }),
      /control_api_login_without_session_cookie/
    )
  })
})

describe('adminRequest', () => {
  it('sends the session cookie and parses a JSON body', async () => {
    const seen = []
    const result = await adminRequest({
      env: {},
      cookie: COOKIE,
      method: 'PUT',
      path: '/api/v1/admin/secrets',
      body: '{"name":"x"}',
      requestImpl: async options => {
        seen.push(options)
        return { status: 502, headers: {}, text: '{"error":"secret_read_failed"}' }
      },
    })
    assert.deepEqual(result, { status: 502, body: { error: 'secret_read_failed' } })
    assert.equal(seen.length, 1)
    assert.equal(seen[0].headers.cookie, COOKIE)
    assert.equal(seen[0].body, '{"name":"x"}')
  })

  it('reports a non-JSON body as null', async () => {
    const result = await adminRequest({
      env: {},
      cookie: COOKIE,
      method: 'GET',
      path: '/api/v1/admin/secrets',
      requestImpl: async () => ({ status: 500, headers: {}, text: '<html>' }),
    })
    assert.deepEqual(result, { status: 500, body: null })
  })

  it('refuses to send a request without a session cookie', async () => {
    let calls = 0
    await assert.rejects(
      adminRequest({
        env: {},
        cookie: '',
        method: 'GET',
        path: '/api/v1/admin/secrets',
        requestImpl: async () => {
          calls += 1
          return { status: 200, headers: {}, text: '{}' }
        },
      }),
      /control_api_session_cookie_invalid/
    )
    assert.equal(calls, 0)
  })
})

describe('runFromInput', () => {
  it('runs login from NUL-separated stdin fields', async () => {
    const seen = []
    const output = await runFromInput('login\0admin\0pw', {
      env: {},
      requestImpl: async options => {
        seen.push(options)
        return { status: 200, headers: { 'set-cookie': [COOKIE] }, text: '{}' }
      },
    })
    assert.equal(output, `200\t${COOKIE}`)
    assert.equal(seen.length, 1)
  })

  it('runs a request and prints the status and single-line JSON', async () => {
    const output = await runFromInput(
      `request\0${COOKIE}\0PUT\0/api/v1/admin/secrets\0{"name":"x"}`,
      {
        env: {},
        requestImpl: async () => ({
          status: 502,
          headers: {},
          text: '{\n  "error": "secret_read_failed"\n}',
        }),
      }
    )
    assert.equal(output, '502\t{"error":"secret_read_failed"}')
  })

  it('rejects an unknown action or a malformed field count', async () => {
    const requestImpl = async () => assert.fail('no request expected')
    await assert.rejects(runFromInput('delete\0x', { requestImpl }), /control_api_action_invalid/)
    await assert.rejects(runFromInput('login\0admin', { requestImpl }), /control_api_login_input_invalid/)
    await assert.rejects(
      runFromInput(`request\0${COOKIE}\0GET`, { requestImpl }),
      /control_api_request_input_invalid/
    )
  })
})
