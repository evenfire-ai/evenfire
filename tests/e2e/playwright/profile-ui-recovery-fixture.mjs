import { spawn, spawnSync } from 'node:child_process'
import { generateKeyPairSync, sign, verify } from 'node:crypto'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(fixtureDirectory, '../../..')
const profileUiRoot = path.join(repositoryRoot, 'profile-ui')
const externalRestRoot = path.join(repositoryRoot, 'external-rest-api')
const port = Number(process.env.PROFILE_UI_RECOVERY_PORT || 31873)
const profileOrigin = `http://127.0.0.1:${port}`
const invitationToken = 'synthetic-reset-proof'
const syntheticBearer = 'Bearer synthetic-profile-recovery-token' // PUBLIC_SYNTHETIC_BEARER_FIXTURE
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

const ordinaryInvitations = new Map([
  [
    'synthetic-member-invitation',
    {
      id: 'synthetic-member-invitation-row',
      teamId: 'synthetic-member-team',
      teamName: 'Synthetic Member Team',
      email: 'member-onboarding@example.invalid',
      role: 'member',
      purpose: 'member_invitation',
      status: 'pending',
      expiresAt: '2030-01-01T00:00:00.000Z',
      acceptedAt: null,
      acceptedUserId: null,
      userId: 'synthetic-member-onboarding-user',
      passwordPending: true,
      passwordMutationCount: 0,
    },
  ],
  [
    'synthetic-admin-invitation',
    {
      id: 'synthetic-admin-invitation-row',
      teamId: null,
      teamName: null,
      email: 'admin-onboarding@example.invalid',
      role: 'admin',
      purpose: 'admin_desktop_access',
      status: 'accepted',
      expiresAt: '2030-01-01T00:00:00.000Z',
      acceptedAt: '2026-10-16T00:00:00.000Z',
      acceptedUserId: 'synthetic-admin-onboarding-user',
      userId: 'synthetic-admin-onboarding-user',
      passwordPending: true,
      passwordMutationCount: 0,
    },
  ],
  [
    'synthetic-wrong-purpose-invitation',
    {
      id: 'synthetic-wrong-purpose-invitation-row',
      teamId: null,
      teamName: null,
      email: 'wrong-purpose@example.invalid',
      role: 'member',
      purpose: 'member_invitation',
      status: 'pending',
      expiresAt: '2030-01-01T00:00:00.000Z',
      acceptedAt: null,
      acceptedUserId: null,
      userId: 'synthetic-wrong-purpose-user',
      passwordPending: true,
      passwordMutationCount: 0,
    },
  ],
])
const ordinaryMetrics = {
  acceptanceRequests: [],
  passwordRequests: [],
  resetRequests: [],
  meRequests: [],
}

let resetPosts = 0
let authenticatedMeReads = 0
let passwordChanged = false
let contractResetPosts = 0
let externalRestBaseUrl
let sessionPrivateKey
let sessionPublicKey

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

async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks)
}

function sessionTokenFor(invitation) {
  if (!sessionPrivateKey) throw new Error('Synthetic session signer is unavailable')
  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({
      userId: invitation.userId,
      email: invitation.email,
      teamId: invitation.teamId,
      role: invitation.role,
      authGeneration: 1,
      iat: now,
      exp: now + 3600,
      iss: 'control-api',
      aud: 'profile-ui',
    })
  ).toString('base64url')
  const signed = `${header}.${payload}`
  return `${signed}.${sign('RSA-SHA256', Buffer.from(signed), sessionPrivateKey).toString('base64url')}`
}

function sessionClaims(token) {
  if (!sessionPublicKey || typeof token !== 'string') return null
  const [header, payload, signature] = token.split('.')
  if (!header || !payload || !signature) return null
  const signed = `${header}.${payload}`
  if (
    !verify(
      'RSA-SHA256',
      Buffer.from(signed),
      sessionPublicKey,
      Buffer.from(signature, 'base64url')
    )
  ) {
    return null
  }
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (
      claims.iss !== 'control-api' ||
      claims.aud !== 'profile-ui' ||
      typeof claims.exp !== 'number' ||
      claims.exp <= Math.floor(Date.now() / 1000)
    ) {
      return null
    }
    return claims
  } catch {
    return null
  }
}

function invitationForToken(token) {
  return ordinaryInvitations.get(token) || null
}

function ordinarySnapshot() {
  return {
    operations: ordinaryMetrics,
    invitations: [...ordinaryInvitations.values()].map(
      ({
        id,
        purpose,
        status,
        userId,
        acceptedUserId,
        passwordPending,
        passwordMutationCount,
      }) => ({
        id,
        purpose,
        status,
        userId,
        acceptedUserId,
        passwordPending,
        passwordMutationCount,
      })
    ),
  }
}

async function proxyExternalRest(request, response, path, bodyOverride) {
  try {
    const headers = {}
    for (const name of ['content-type', 'cookie', 'authorization', 'origin', 'sec-fetch-site']) {
      if (request.headers[name]) headers[name] = request.headers[name]
    }
    headers['x-forwarded-for'] = request.headers['x-forwarded-for'] || '192.0.2.48'
    const body =
      bodyOverride !== undefined
        ? Buffer.from(JSON.stringify(bodyOverride))
        : ['GET', 'HEAD'].includes(request.method || 'GET')
          ? undefined
          : await readBody(request)
    const upstream = await fetch(`${externalRestBaseUrl}${path}`, {
      method: request.method,
      headers,
      body,
      redirect: 'manual',
    })
    const responseHeaders = {
      'content-type': upstream.headers.get('content-type') || 'application/json',
    }
    const cookies = upstream.headers.getSetCookie?.() || []
    if (cookies.length > 0) responseHeaders['set-cookie'] = cookies
    else if (upstream.headers.get('set-cookie')) {
      responseHeaders['set-cookie'] = upstream.headers.get('set-cookie')
    }
    response.writeHead(upstream.status, responseHeaders)
    response.end(await upstream.text())
  } catch {
    sendJson(response, 502, { error: 'synthetic_external_rest_unavailable' })
  }
}

const apiServer = createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1')

  const publicInvitationMatch = url.pathname.match(/^\/api\/v1\/invitations\/token\/([^/]+)$/)
  if (request.method === 'GET' && publicInvitationMatch) {
    const token = decodeURIComponent(publicInvitationMatch[1])
    if (invitationForToken(token)) {
      await proxyExternalRest(request, response, `${url.pathname}${url.search}`)
      return
    }
  }

  if (
    request.method === 'POST' &&
    ['/api/v1/invitations/accept', '/api/v1/invitations/password'].includes(url.pathname)
  ) {
    let body
    try {
      body = await readJson(request)
    } catch {
      sendJson(response, 400, { error: 'invalid_payload' })
      return
    }
    if (invitationForToken(String(body.token || ''))) {
      await proxyExternalRest(request, response, `${url.pathname}${url.search}`, body)
      return
    }
  }

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
    if (invitationForToken(String(body.token || ''))) {
      ordinaryMetrics.resetRequests.push({
        id: invitationForToken(String(body.token)).id,
      })
      await proxyExternalRest(request, response, `${url.pathname}${url.search}`, body)
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
    const cookie = String(request.headers.cookie || '')
    if (cookie.includes('profile_session=synthetic-recovered-session')) {
      authenticatedMeReads += 1
      if (authenticatedMeReads === 1) {
        sendJson(response, 404, { error: 'User not found' })
        return
      }
      sendJson(response, 200, member)
      return
    }
    if (!cookie.includes('profile_session=')) {
      sendJson(response, 401, { error: 'Unauthorized' })
      return
    }
    await proxyExternalRest(request, response, `${url.pathname}${url.search}`)
    return
  }

  if (request.method === 'GET' && url.pathname === '/__test/metrics') {
    sendJson(response, 200, {
      resetPosts,
      authenticatedMeReads,
      passwordChanged,
      contractResetPosts,
      ordinary: ordinarySnapshot(),
    })
    return
  }

  const invitationTokenMatch = url.pathname.match(
    /^\/api\/v1\/external\/invitations\/token\/([^/]+)$/
  )
  if (request.method === 'GET' && invitationTokenMatch) {
    if (request.headers.authorization !== syntheticBearer) {
      sendJson(response, 401, { error: 'Unauthorized' })
      return
    }
    const token = decodeURIComponent(invitationTokenMatch[1])
    const invited = invitationForToken(token)
    if (!invited) {
      sendJson(response, 404, { error: 'not_found' })
      return
    }
    sendJson(response, 200, invited)
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/v1/external/invitations/accept') {
    let body
    try {
      body = await readJson(request)
    } catch {
      sendJson(response, 400, { error: 'invalid_payload' })
      return
    }
    const invited = invitationForToken(String(body.token || ''))
    if (request.headers.authorization !== syntheticBearer) {
      sendJson(response, 401, { error: 'Unauthorized' })
      return
    }
    if (!invited || String(body.email || '').toLowerCase() !== invited.email.toLowerCase()) {
      sendJson(response, 403, { error: 'forbidden' })
      return
    }
    if (invited.purpose === 'password_reset' || invited.status === 'revoked') {
      sendJson(response, 400, { error: 'not_pending' })
      return
    }
    if (invited.acceptedUserId && invited.acceptedUserId !== invited.userId) {
      sendJson(response, 403, { error: 'forbidden' })
      return
    }
    invited.status = 'accepted'
    invited.acceptedAt ||= new Date().toISOString()
    invited.acceptedUserId = invited.userId
    ordinaryMetrics.acceptanceRequests.push({ id: invited.id, purpose: invited.purpose })
    sendJson(response, 200, {
      accepted: true,
      ...invited,
      token: sessionTokenFor(invited),
    })
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/v1/external/invitations/password') {
    let body
    try {
      body = await readJson(request)
    } catch {
      sendJson(response, 400, { error: 'invalid_payload' })
      return
    }
    if (request.headers.authorization !== syntheticBearer) {
      sendJson(response, 401, { error: 'Unauthorized' })
      return
    }
    const claims = sessionClaims(String(request.headers['x-user-session-token'] || ''))
    const selected = [...ordinaryInvitations.values()].find(item => item.id === body.invitationId)
    if (
      !claims ||
      !selected ||
      claims.userId !== selected.userId ||
      claims.email !== selected.email ||
      body.userId !== selected.userId ||
      String(body.email || '').toLowerCase() !== selected.email.toLowerCase() ||
      selected.acceptedUserId !== selected.userId
    ) {
      sendJson(response, 403, { error: 'forbidden' })
      return
    }
    if (
      selected.purpose === 'password_reset' ||
      !['member_invitation', 'admin_desktop_access'].includes(selected.purpose)
    ) {
      sendJson(response, 404, { error: 'not_found' })
      return
    }
    if (
      selected.status !== 'accepted' ||
      !selected.passwordPending ||
      selected.passwordMutationCount
    ) {
      sendJson(response, 409, { error: 'invitation_not_pending' })
      return
    }
    if (typeof body.password !== 'string' || body.password.trim().length < 8) {
      sendJson(response, 400, { error: 'invalid_password' })
      return
    }
    selected.passwordMutationCount += 1
    selected.passwordPending = false
    ordinaryMetrics.passwordRequests.push({ id: selected.id, purpose: selected.purpose })
    sendJson(response, 200, { ...selected, passwordUpdated: true })
    return
  }

  const meMatch = url.pathname.match(/^\/api\/v1\/external\/users\/([^/]+)\/me$/)
  if (request.method === 'GET' && meMatch) {
    if (request.headers.authorization !== syntheticBearer) {
      sendJson(response, 401, { error: 'Unauthorized' })
      return
    }
    const claims = sessionClaims(String(request.headers['x-user-session-token'] || ''))
    const invited = [...ordinaryInvitations.values()].find(item => item.userId === meMatch[1])
    if (!claims || !invited || claims.userId !== invited.userId || claims.email !== invited.email) {
      sendJson(response, 403, { error: 'forbidden' })
      return
    }
    ordinaryMetrics.meRequests.push({ id: invited.id, userId: claims.userId })
    sendJson(response, 200, {
      id: invited.userId,
      email: invited.email,
      name: invited.role === 'admin' ? 'Synthetic Admin' : 'Synthetic Member',
      picture: null,
      teamId: invited.teamId,
      teamName: invited.teamName,
      role: invited.role,
      profile: { displayName: invited.role === 'admin' ? 'Synthetic Admin' : 'Synthetic Member' },
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
    const ordinaryInvitation = invitationForToken(String(body.token || ''))
    if (ordinaryInvitation) {
      ordinaryMetrics.resetRequests.push({ id: ordinaryInvitation.id })
      if (body.email !== ordinaryInvitation.email || body.invitationId !== ordinaryInvitation.id) {
        sendJson(response, 403, { error: 'forbidden' })
      } else {
        sendJson(response, 409, { error: 'invitation_not_pending' })
      }
      return
    }
    if (
      request.headers.authorization !== syntheticBearer ||
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
      internal_error: [500, 'internal_error'],
      unknown_500: [500, 'unclassified_failure'],
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

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
sessionPrivateKey = privateKey
sessionPublicKey = publicKey
const externalRestProcess = spawn(
  process.execPath,
  [path.join(externalRestRoot, 'test/helpers/passwordRecoveryHttpServer.mjs')],
  {
    cwd: externalRestRoot,
    env: {
      NODE_ENV: 'development',
      EXTERNAL_REST_API_CONTROL_API_BASE_URL: `http://127.0.0.1:${apiAddress.port}/api/v1`,
      EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN: 'synthetic-profile-recovery-token',
      EXTERNAL_REST_API_JWT_PUBLIC_KEY: publicKey
        .export({ type: 'spki', format: 'pem' })
        .toString(),
      EXTERNAL_REST_API_CORS_ORIGIN: profileOrigin,
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
const nextEnvironment = Object.fromEntries(
  ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']
    .filter(name => typeof process.env[name] === 'string')
    .map(name => [name, process.env[name]])
)
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
      ...nextEnvironment,
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
