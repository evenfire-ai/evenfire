import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process'
import net from 'node:net'

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port)
        else reject(new Error('failed to allocate port'))
      })
    })
  })
}

export async function healthStatus(baseUrl: string, path = '/health'): Promise<number> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`)
    return response.status
  } catch {
    return 0
  }
}

export async function waitForHealth(baseUrl: string, path = '/health'): Promise<void> {
  const startedAt = Date.now()
  let consecutiveHealthy = 0
  while (Date.now() - startedAt < 45_000) {
    const status = await healthStatus(baseUrl, path)
    consecutiveHealthy = status === 200 ? consecutiveHealthy + 1 : 0
    if (consecutiveHealthy >= 3) return
    await sleep(consecutiveHealthy === 0 ? 500 : 1000)
  }
  throw new Error(`timed out waiting for health at ${baseUrl.replace(/\/$/, '')}${path}`)
}

export async function ensureLocalServicePortForward(params: {
  baseUrlEnvName: string
  context: string
  namespace: string
  service: string
  defaultLocalPort: string
  remotePort: string
  forceRefresh?: boolean
}): Promise<ChildProcessWithoutNullStreams | null> {
  const rawBaseUrl = process.env[params.baseUrlEnvName]
  if (!rawBaseUrl) {
    throw new Error(`${params.baseUrlEnvName} must come from the branch-scoped ports.env`)
  }
  const baseUrl = new URL(rawBaseUrl)
  const healthUrl = baseUrl.toString()
  if (baseUrl.hostname !== '127.0.0.1' && baseUrl.hostname !== 'localhost') return null

  const port = baseUrl.port || params.defaultLocalPort
  if (params.forceRefresh) {
    await stopLocalKubectlPortForward(port)
  } else if ((await healthStatus(healthUrl)) === 200) {
    return null
  }

  const child = spawn(
    'kubectl',
    [
      '--context',
      params.context,
      '-n',
      params.namespace,
      'port-forward',
      `svc/${params.service}`,
      `${port}:${params.remotePort}`,
    ],
    { stdio: 'pipe' }
  )
  await waitForHealth(healthUrl)
  return child
}

export async function stopChild(child: ChildProcessWithoutNullStreams | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>(resolve => {
    child.once('exit', () => resolve())
    child.kill('SIGTERM')
  })
}

async function stopLocalKubectlPortForward(port: string): Promise<void> {
  const result = spawnSync('lsof', ['-nP', `-tiTCP:${port}`, '-sTCP:LISTEN'], {
    encoding: 'utf8',
  })
  const pids = result.stdout
    .split('\n')
    .map(pid => pid.trim())
    .filter(Boolean)

  for (const pid of pids) {
    const command = spawnSync('ps', ['-p', pid, '-o', 'command='], { encoding: 'utf8' }).stdout
    if (!command.includes('kubectl') || !command.includes('port-forward')) {
      throw new Error(`port ${port} is owned by a non-kubectl process: ${command.trim()}`)
    }
    try {
      process.kill(Number(pid), 'SIGTERM')
    } catch {
      // The port-forward may have already exited after lsof observed it.
    }
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const check = spawnSync('lsof', ['-nP', `-tiTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
    })
    if (!check.stdout.trim()) return
    await sleep(250)
  }
  throw new Error(`timed out waiting for port ${port} to be released`)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
