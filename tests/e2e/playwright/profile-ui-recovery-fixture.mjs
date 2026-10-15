import { spawn, spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(fixtureDirectory, '../../..')
const profileUiRoot = path.join(repositoryRoot, 'profile-ui')
const externalRestRoot = path.join(repositoryRoot, 'external-rest-api')
const port = Number(process.env.PROFILE_UI_RECOVERY_PORT || 31873)
const invitationToken = 'synthetic-reset-proof'
const syntheticServiceAuthorization = ['Bearer', 'synthetic-profile-recovery-service-token'].join(
  ' '
)
const contractPasswordPrefix = 'Synthetic-Recovery-Contract-'
const invitation = {
  id: 'synthetic-reset-row',
  teamId: null,
  teamName: null,
  email: 'member@example.invalid',
  role: 'member',
  purpose: 'password_reset',
  status: 'pending',
  expiresAt: '2030-01-01T00:00:00.000Z',
  acceptedAt: null,
  userId: 'synthetic-member-id',
  passwordPending: true,
}
const member = {
  id: 'synthetic-member-id',
  email: invitation.email,
  name: 'Synthetic Member',
  picture: null,
  teamId: null,
  teamName: null,
  role: 'member',
  profile: { displayName: 'Synthetic Member', channels: {} },
}

let resetPosts = 0
let authenticatedMeReads = 0
let passwordChanged = false
let contractResetPosts = 0
let externalRestBaseUrl

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  })
  response.end(JSON.stringify(body))
}

async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

const apiServer = createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1')

  if (request.method === 'GET' && url.pathname === `/api/v1/invitations/token/${invitationToken}`) {
    sendJson(response, 200, invitation)
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/v1/invitations/password-reset') {
    let body
    try {
      body = await readJson(request)
    } catch {
      sendJson(response, 400, { error: 'invalid_payload' })
      return
    }
    if (typeof body.password === 'string' && body.password.startsWith(contractPasswordPrefix)) {
      contractResetPosts += 1
      const ipSuffix = String((contractResetPosts % 200) + 20)
      try {
        const upstream = await fetch(`${externalRestBaseUrl}/api/v1/invitations/password-reset`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-forwarded-for': `198.51.100.${ipSuffix}`,
          },
          body: JSON.stringify(body),
        })
        const text = await upstream.text()
        response.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') || 'application/json',
          ...(upstream.headers.get('set-cookie')
            ? { 'set-cookie': upstream.headers.get('set-cookie') }
            : {}),
        })
        response.end(text)
      } catch {
        sendJson(response, 502, { error: 'synthetic_external_rest_unavailable' })
      }
      return
    }
    resetPosts += 1
    if (
      body.token !== invitationToken ||
      body.email !== invitation.email ||
      body.invitationId !== invitation.id ||
      typeof body.password !== 'string' ||
      body.password.length < 8
    ) {
      sendJson(response, 400, { error: 'invalid_invitation' })
      return
    }
    if (passwordChanged) {
      sendJson(response, 409, { error: 'invitation_not_pending' })
      return
    }
    passwordChanged = true
    sendJson(
      response,
      200,
      { ...invitation, status: 'accepted', passwordPending: false, passwordUpdated: true },
      {
        'set-cookie': 'profile_session=synthetic-recovered-session; HttpOnly; Path=/; SameSite=Lax',
      }
    )
    return
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/me') {
    if (
      !String(request.headers.cookie || '').includes('profile_session=synthetic-recovered-session')
    ) {
      sendJson(response, 401, { error: 'Unauthorized' })
      return
    }
    authenticatedMeReads += 1
    if (authenticatedMeReads === 1) {
      sendJson(response, 404, { error: 'User not found' })
      return
    }
    sendJson(response, 200, member)
    return
  }

  if (request.method === 'GET' && url.pathname === '/__test/metrics') {
    sendJson(response, 200, {
      resetPosts,
      authenticatedMeReads,
      passwordChanged,
      contractResetPosts,
    })
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/v1/external/invitations/password-token') {
    let body
    try {
      body = await readJson(request)
    } catch {
      sendJson(response, 400, { error: 'invalid_payload' })
      return
    }
    if (
      request.headers.authorization !== syntheticServiceAuthorization ||
      body.token !== invitationToken ||
      body.email !== invitation.email ||
      body.invitationId !== invitation.id ||
      typeof body.password !== 'string' ||
      !body.password.startsWith(contractPasswordPrefix) ||
      body.password.trim().length < 8
    ) {
      sendJson(response, 400, { error: 'invalid_payload' })
      return
    }
    const outcomes = {
      invalid_password: [400, 'invalid_password'],
      invalid_invitation: [400, 'invalid_invitation'],
      forbidden: [403, 'forbidden'],
      expired: [410, 'expired'],
      not_pending: [409, 'invitation_not_pending'],
      rate_limited: [429, 'rate_limited'],
      authority_unavailable: [503, 'authority_unavailable'],
      recovery_outcome_unknown: [503, 'recovery_outcome_unknown'],
    }
    const scenario = body.password
      .slice(contractPasswordPrefix.length)
      .match(/^(.+)-Password-123$/)?.[1]
    const outcome = outcomes[String(scenario || '')]
    if (outcome) {
      sendJson(response, outcome[0], { error: outcome[1] })
      return
    }
    sendJson(response, 404, { error: 'not_found' })
    return
  }

  sendJson(response, 404, { error: 'not_found' })
})

await new Promise((resolve, reject) => {
  apiServer.once('error', reject)
  apiServer.listen(0, '127.0.0.1', resolve)
})

const apiAddress = apiServer.address()
if (!apiAddress || typeof apiAddress === 'string') throw new Error('Fixture API did not bind TCP')

const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const externalRestProcess = spawn(
  process.execPath,
  [path.join(externalRestRoot, 'test/helpers/passwordRecoveryHttpServer.mjs')],
  {
    cwd: externalRestRoot,
    env: {
      NODE_ENV: 'development',
      EXTERNAL_REST_API_CONTROL_API_BASE_URL: `http://127.0.0.1:${apiAddress.port}/api/v1`,
      EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN: 'synthetic-profile-recovery-service-token',
      EXTERNAL_REST_API_JWT_PUBLIC_KEY: publicKey
        .export({ type: 'spki', format: 'pem' })
        .toString(),
      EXTERNAL_REST_API_CORS_ORIGIN: 'http://127.0.0.1:31873',
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  }
)

externalRestBaseUrl = await new Promise((resolve, reject) => {
  let output = ''
  const timeout = setTimeout(() => reject(new Error('External REST fixture did not start')), 15_000)
  externalRestProcess.stdout.setEncoding('utf8')
  externalRestProcess.stdout.on('data', chunk => {
    output += chunk
    const match = output.match(/http:\/\/127\.0\.0\.1:\d+/)
    if (match) {
      clearTimeout(timeout)
      resolve(match[0])
    }
  })
  externalRestProcess.once('error', error => {
    clearTimeout(timeout)
    reject(error)
  })
  externalRestProcess.once('exit', code => {
    clearTimeout(timeout)
    reject(new Error(`External REST fixture exited before readiness (${code})`))
  })
})

const nextBinary = path.join(profileUiRoot, 'node_modules/next/dist/bin/next')
const nextProcess = spawn(
  process.execPath,
  [
    '--max-old-space-size=3072',
    nextBinary,
    'dev',
    '--webpack',
    '--hostname',
    '127.0.0.1',
    '--port',
    String(port),
  ],
  {
    cwd: profileUiRoot,
    env: {
      ...process.env,
      EXTERNAL_REST_API_INTERNAL_URL: `http://127.0.0.1:${apiAddress.port}`,
      NEXT_TELEMETRY_DISABLED: '1',
      NODE_ENV: 'development',
    },
    stdio: 'inherit',
  }
)

let shuttingDown = false
function childProcessIds(rootPid) {
  try {
    const result = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], {
      encoding: 'utf8',
      timeout: 2_000,
      maxBuffer: 2 * 1024 * 1024,
    })
    if (result.status !== 0 || result.error) return []
    const children = new Map()
    for (const line of result.stdout.split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(\d+)$/)
      if (!match) continue
      const pid = Number(match[1])
      const parentPid = Number(match[2])
      const peers = children.get(parentPid) || []
      peers.push(pid)
      children.set(parentPid, peers)
    }
    const descendants = []
    function visit(parentPid) {
      for (const pid of children.get(parentPid) || []) {
        visit(pid)
        descendants.push(pid)
      }
    }
    visit(rootPid)
    return descendants
  } catch {
    return []
  }
}

function signalChildTree(child, signal) {
  for (const pid of childProcessIds(child.pid)) {
    try {
      process.kill(pid, signal)
    } catch {}
  }
  if (child.exitCode === null && child.signalCode === null) child.kill(signal)
}

async function stopChild(child) {
  const childIsRunning = () => child.exitCode === null && child.signalCode === null
  const exited = childIsRunning()
    ? new Promise(resolve => child.once('exit', resolve))
    : Promise.resolve()
  signalChildTree(child, 'SIGTERM')
  let graceTimer
  await Promise.race([
    exited,
    new Promise(resolve => {
      graceTimer = setTimeout(resolve, 5_000)
    }),
  ])
  clearTimeout(graceTimer)
  if (childIsRunning() || childProcessIds(child.pid).length > 0) signalChildTree(child, 'SIGKILL')
  await exited
}

async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  apiServer.closeAllConnections()
  await Promise.all([stopChild(nextProcess), stopChild(externalRestProcess)])
  await new Promise(resolve => apiServer.close(resolve))
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
nextProcess.once('error', error => {
  process.stderr.write(`Could not start Profile UI recovery fixture: ${error.message}\n`)
  process.exitCode = 1
  void shutdown('SIGTERM')
})
nextProcess.once('exit', code => {
  if (!shuttingDown) {
    process.exitCode = code ?? 1
    void shutdown('SIGTERM')
  }
})
