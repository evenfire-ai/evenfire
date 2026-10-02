import { request as httpRequest } from 'node:http'

// In-pod client for scripts/e2e/e2e-control-api-secret-read-rbac.sh. The shell
// harness passes this module as the program of `node --input-type=module -e`
// inside the control-api pod and streams the credential-bearing input over
// stdin, so neither the admin password nor the session cookie appears in any
// argv. Requests go to control-api's own listener on the pod loopback, which
// keeps the journey independent of host port-forwards.

// Mirrors control-api/src/config.ts (`Number(process.env.CONTROL_API_PORT ||
// 8090)`): the port the server in this same pod is listening on.
export const DEFAULT_CONTROL_API_PORT = 8090
export const SESSION_COOKIE_NAME = 'control_ui_admin_session'
export const LOGIN_PATH = '/api/v1/admin/auth/login'
export const REQUEST_TIMEOUT_MS = 10_000
export const MAX_RESPONSE_BODY_BYTES = 64 * 1024

export function controlApiPort(env = process.env) {
  const configured = typeof env.CONTROL_API_PORT === 'string' ? env.CONTROL_API_PORT.trim() : ''
  const raw = configured || String(DEFAULT_CONTROL_API_PORT)
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error('control_api_port_invalid')
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value > 65_535) throw new Error('control_api_port_invalid')
  return value
}

export function requestControlApi({
  port,
  method,
  path,
  headers = {},
  body = null,
  timeoutMs = REQUEST_TIMEOUT_MS,
  requestFactory = httpRequest,
}) {
  if (typeof path !== 'string' || !path.startsWith('/api/v1/')) {
    return Promise.reject(new Error('control_api_path_invalid'))
  }
  return new Promise((resolve, reject) => {
    let settled = false
    let deadline
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      callback(value)
    }
    const payload = body === null ? null : Buffer.from(body, 'utf8')
    const request = requestFactory(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          accept: 'application/json',
          ...(payload
            ? { 'content-type': 'application/json', 'content-length': payload.length }
            : {}),
          ...headers,
        },
      },
      response => {
        let bytes = 0
        const chunks = []
        response.on('data', chunk => {
          bytes += chunk.length
          if (bytes > MAX_RESPONSE_BODY_BYTES) {
            request.destroy(new Error('control_api_response_too_large'))
            return
          }
          chunks.push(chunk)
        })
        response.once('end', () => {
          finish(resolve, {
            status: response.statusCode,
            headers: response.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          })
        })
        response.once('aborted', () => finish(reject, new Error('control_api_response_aborted')))
        response.once('error', error => finish(reject, error))
      }
    )
    // Wall-clock deadline for the whole exchange; ClientRequest#setTimeout only
    // measures inactivity.
    deadline = setTimeout(() => {
      request.destroy(new Error('control_api_request_timeout'))
    }, timeoutMs)
    deadline.unref?.()
    request.once('error', error => finish(reject, error))
    if (payload) request.write(payload)
    request.end()
  })
}

export function sessionCookieFrom(setCookie) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []
  for (const value of values) {
    const pair = String(value).split(';')[0].trim()
    if (pair.startsWith(`${SESSION_COOKIE_NAME}=`) && pair.length > SESSION_COOKIE_NAME.length + 1) {
      return pair
    }
  }
  return null
}

export async function login({ env = process.env, username, password, requestImpl = requestControlApi }) {
  const response = await requestImpl({
    port: controlApiPort(env),
    method: 'POST',
    path: LOGIN_PATH,
    body: JSON.stringify({ username, password }),
  })
  if (response.status !== 200) throw new Error(`control_api_login_http_${response.status}`)
  const cookie = sessionCookieFrom(response.headers['set-cookie'])
  if (!cookie) throw new Error('control_api_login_without_session_cookie')
  return cookie
}

export async function adminRequest({
  env = process.env,
  cookie,
  method,
  path,
  body,
  requestImpl = requestControlApi,
}) {
  if (typeof cookie !== 'string' || !cookie.startsWith(`${SESSION_COOKIE_NAME}=`)) {
    throw new Error('control_api_session_cookie_invalid')
  }
  const response = await requestImpl({
    port: controlApiPort(env),
    method,
    path,
    headers: { cookie },
    body: body ? body : null,
  })
  let parsed = null
  try {
    parsed = JSON.parse(response.text)
  } catch {
    // A non-JSON body is reported as `null`. The 502 assertions read
    // `.error` / `.message` and fail on it; the positive control after the
    // Role restore checks only the status and the Secret's resourceVersion.
  }
  return { status: response.status, body: parsed }
}

// stdin: NUL-separated fields.
//   login   <username> <password>            -> "200\t<cookie pair>"
//   request <cookie> <method> <path> [<body>] -> "<status>\t<single-line JSON>"
export async function runFromInput(input, { env = process.env, requestImpl = requestControlApi } = {}) {
  const fields = input.split('\0')
  const action = fields[0]
  if (action === 'login') {
    if (fields.length !== 3) throw new Error('control_api_login_input_invalid')
    const cookie = await login({ env, username: fields[1], password: fields[2], requestImpl })
    return `200\t${cookie}`
  }
  if (action === 'request') {
    if (fields.length < 4 || fields.length > 5) throw new Error('control_api_request_input_invalid')
    const [, cookie, method, path, body] = fields
    const result = await adminRequest({ env, cookie, method, path, body, requestImpl })
    return `${result.status}\t${JSON.stringify(result.body)}`
  }
  throw new Error('control_api_action_invalid')
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

if (process.env.SECRET_READ_RBAC_RUNTIME === 'run') {
  try {
    process.stdout.write(await runFromInput(await readStdin()))
  } catch (error) {
    // `error.message` is one of this module's fixed codes or a Node socket or
    // stream error from http.request (for example `connect ECONNREFUSED
    // 127.0.0.1:<port>`). Neither carries request or response content.
    process.stderr.write(`control-api secret-read runtime failed: ${error.message}\n`)
    process.exitCode = 1
  }
}
