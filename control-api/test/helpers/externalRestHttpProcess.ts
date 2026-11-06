import { spawn } from 'node:child_process'
import { createPublicKey, generateKeyPairSync } from 'node:crypto'
import { access } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import request from 'supertest'

export type ExternalRestHttpProcess = {
  baseUrl: string
  stop: () => Promise<void>
}
export type RecoveryHttpConfig = {
  controlApiBaseUrl: string
  controlApiServiceToken: string
  jwtPublicKey?: string
  jwtPrivateKey?: string
  jwtIssuer?: string
  jwtAudience?: string
}

// Every request in the composed lane has a finite deadline, including failure schedules.
export function boundedRequest(target: Parameters<typeof request>[0]) {
  const agent = request(target)
  for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head'] as const) {
    const original = agent[method].bind(agent)
    agent[method] = ((...args: Parameters<typeof original>) =>
      original(...args).timeout({ response: 10_000, deadline: 15_000 })) as typeof original
  }
  return agent
}

export async function startExternalRestHttpProcess(
  config: RecoveryHttpConfig
): Promise<ExternalRestHttpProcess> {
  const upstream = new URL(config.controlApiBaseUrl)
  if (
    upstream.protocol !== 'http:' ||
    upstream.hostname !== '127.0.0.1' ||
    !upstream.port ||
    upstream.username ||
    upstream.password ||
    upstream.search ||
    upstream.hash ||
    !['', '/', '/api/v1'].includes(upstream.pathname)
  )
    throw new Error('Recovery HTTP producer must be task-owned loopback')
  const entry = fileURLToPath(
    new URL(
      '../../../external-rest-api/test/helpers/passwordRecoveryHttpServer.mjs',
      import.meta.url
    )
  )
  const build = fileURLToPath(new URL('../../../external-rest-api/dist/app.js', import.meta.url))
  await access(build).catch(() => {
    throw new Error('Build External REST before composed HTTP tests')
  })
  const publicKey =
    config.jwtPublicKey ||
    createPublicKey(
      config.jwtPrivateKey || generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    )
      .export({ type: 'spki', format: 'pem' })
      .toString()
  const child = spawn(process.execPath, [entry], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      EXTERNAL_REST_API_CORS_ORIGIN: 'http://127.0.0.1',
      EXTERNAL_REST_API_GOOGLE_CLIENT_ID: 'synthetic-recovery-client',
      EXTERNAL_REST_API_CONTROL_API_BASE_URL: config.controlApiBaseUrl,
      EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN: config.controlApiServiceToken,
      EXTERNAL_REST_API_CONTROL_API_SERVICE_NAME: 'external-rest-api',
      EXTERNAL_REST_API_JWT_PUBLIC_KEY: publicKey,
      EXTERNAL_REST_API_JWT_ISSUER: config.jwtIssuer || 'control-api',
      EXTERNAL_REST_API_JWT_AUDIENCE: config.jwtAudience || 'profile-ui',
      EXTERNAL_REST_API_PUBLIC_BASE_URL: 'http://127.0.0.1',
      EXTERNAL_REST_API_DESKTOP_RPC_PROXY_BASE_URL: 'http://127.0.0.1',
    },
  })
  // Do not forward child logs/configuration into assertion errors.
  child.stderr.resume()
  let exited = false
  let exitCode: number | null = null
  const completion = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => {
      exited = true
      exitCode = code
      resolve()
    })
  })
  const lines = createInterface({ input: child.stdout })
  let stopped: Promise<void> | undefined
  const stop = () =>
    (stopped ||= (async () => {
      if (!exited) child.kill('SIGTERM')
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        try {
          await Promise.race([
            completion,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                reject(new Error('Recovery HTTP child shutdown exceeded 5 seconds'))
              }, 5000)
            }),
          ])
        } catch (error) {
          clearTimeout(timer)
          if (!exited) {
            child.kill('SIGKILL')
            await Promise.race([
              completion,
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error('Recovery HTTP child did not exit after SIGKILL')),
                  2000
                )
              }),
            ])
          }
          throw error
        }
        if (exitCode !== 0) throw new Error('Recovery HTTP child exited unsuccessfully')
      } finally {
        clearTimeout(timer)
        lines.close()
        child.stdin.destroy()
      }
    })())
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const baseUrl = await Promise.race([
      new Promise<string>((resolve, reject) => {
        lines.once('line', line => {
          if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/.test(line)) {
            reject(new Error('Invalid recovery HTTP readiness address'))
          } else resolve(line)
        })
      }),
      completion.then(() => {
        throw new Error('Recovery HTTP child exited before readiness')
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Recovery HTTP readiness exceeded 10 seconds')),
          10_000
        )
      }),
    ])
    return { baseUrl, stop }
  } catch (error) {
    await stop().catch(() => undefined)
    throw error
  } finally {
    clearTimeout(timer)
  }
}
