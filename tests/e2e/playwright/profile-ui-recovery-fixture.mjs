import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(fixtureDirectory, '../../..')
const profileUiRoot = path.join(repositoryRoot, 'profile-ui')
const port = Number(process.env.PROFILE_UI_RECOVERY_PORT || 31873)
const invitationToken = 'synthetic-reset-proof'
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

  if (request.method === 'POST' && url.pathname === '/api/v1/invitations/password') {
    resetPosts += 1
    let body
    try {
      body = await readJson(request)
    } catch {
      sendJson(response, 400, { error: 'invalid_payload' })
      return
    }
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
      sendJson(response, 503, { error: 'authority_unavailable' }, { 'retry-after': '2' })
      return
    }
    sendJson(response, 200, member)
    return
  }

  if (request.method === 'GET' && url.pathname === '/__test/metrics') {
    sendJson(response, 200, { resetPosts, authenticatedMeReads, passwordChanged })
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
async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  nextProcess.kill(signal)
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
  process.exitCode = code ?? 1
  void shutdown('SIGTERM')
})
