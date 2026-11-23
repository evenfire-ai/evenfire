import { spawn, spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRecoveryControlApi } from './profile-ui-recovery-control-api.mjs'

const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(fixtureDirectory, '../../..')
const profileUiRoot = path.join(repositoryRoot, 'profile-ui')
const externalRestRoot = path.join(repositoryRoot, 'external-rest-api')
const port = Number(process.env.PROFILE_UI_RECOVERY_PORT || 31873)
const profileOrigin = `http://127.0.0.1:${port}`

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const controlApi = await createRecoveryControlApi({ privateKey })
const metricsPort = Number(process.env.PROFILE_UI_RECOVERY_METRICS_PORT || 31874)

function sendJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(body))
}

async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  return text.trim() ? JSON.parse(text) : {}
}

const controlApiServer = createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1')
  if (url.pathname === '/__test/metrics' && request.method === 'GET') {
    sendJson(response, 200, controlApi.snapshot())
    return
  }
  if (!url.pathname.startsWith('/api/v1/')) {
    sendJson(response, 404, { error: 'not_found' })
    return
  }
  let body
  if (request.method === 'POST') {
    try {
      body = await readJson(request)
    } catch {
      sendJson(response, 400, { error: 'invalid_payload' })
      return
    }
  }
  try {
    const result = await controlApi.handle({
      method: request.method,
      path: `${url.pathname.slice('/api/v1'.length)}${url.search}`,
      headers: request.headers,
      body,
    })
    sendJson(response, result.status, result.body)
  } catch {
    sendJson(response, 500, { error: 'internal_error' })
  }
})

await new Promise((resolve, reject) => {
  controlApiServer.once('error', reject)
  controlApiServer.listen(0, '127.0.0.1', resolve)
})

const metricsServer = createServer((request, response) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1')
  if (request.method === 'GET' && url.pathname === '/__test/metrics') {
    sendJson(response, 200, controlApi.snapshot())
    return
  }
  sendJson(response, 404, { error: 'not_found' })
})
await new Promise((resolve, reject) => {
  metricsServer.once('error', reject)
  metricsServer.listen(metricsPort, '127.0.0.1', resolve)
})
const controlApiAddress = controlApiServer.address()
if (!controlApiAddress || typeof controlApiAddress === 'string') {
  throw new Error('Fixture Control API did not bind TCP')
}
const controlApiBaseUrl = `http://127.0.0.1:${controlApiAddress.port}/api/v1`

const externalRestProcess = spawn(
  process.execPath,
  [path.join(externalRestRoot, 'test/helpers/passwordRecoveryHttpServer.mjs')],
  {
    cwd: externalRestRoot,
    env: {
      NODE_ENV: 'development',
      EXTERNAL_REST_API_CONTROL_API_BASE_URL: controlApiBaseUrl,
      EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN: 'synthetic-profile-recovery-token',
      EXTERNAL_REST_API_CONTROL_API_SERVICE_NAME: 'external-rest-api',
      EXTERNAL_REST_API_JWT_PUBLIC_KEY: publicKey
        .export({ type: 'spki', format: 'pem' })
        .toString(),
      EXTERNAL_REST_API_CORS_ORIGIN: profileOrigin,
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  }
)

const externalRestBaseUrl = await new Promise((resolve, reject) => {
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
      EXTERNAL_REST_API_INTERNAL_URL: externalRestBaseUrl,
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
  controlApiServer.closeAllConnections()
  metricsServer.closeAllConnections()
  await Promise.all([stopChild(nextProcess), stopChild(externalRestProcess)])
  await new Promise(resolve => controlApiServer.close(resolve))
  await new Promise(resolve => metricsServer.close(resolve))
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
