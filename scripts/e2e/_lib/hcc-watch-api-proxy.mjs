// Development-only transport fixture. No fabricated upstream success responses.
import fs from 'node:fs'
import https from 'node:https'
import { pathToFileURL } from 'node:url'

export function validateCommand(command, allowedPaths) {
  if (!command || typeof command.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(command.id))
    throw new Error('invalid_control_id')
  if (command.action === 'arm') {
    if (
      !allowedPaths.includes(command.path) ||
      command.method !== 'GET' ||
      !Number.isInteger(command.durationMs) ||
      command.durationMs < 1000 ||
      command.durationMs > 25000
    ) {
      throw new Error('invalid_pause_scope')
    }
  } else if (command.action === 'cut') {
    if (!['McpServer', 'Context', 'both'].includes(command.kind))
      throw new Error('invalid_cut_scope')
  } else if (command.action === 'release') {
    if (typeof command.pauseId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(command.pauseId))
      throw new Error('invalid_pause_id')
  } else throw new Error('invalid_control_action')
  return command
}

export function createProxy({
  key,
  cert,
  upstreamCa,
  upstreamHost = 'kubernetes.default.svc',
  upstreamPort = 443,
  allowedPaths,
  controlDir,
  periodMs,
  minAgeMs,
}) {
  const streams = new Set()
  let pause = null
  let commandId = null
  const writeRecord = (name, fields) => {
    fs.writeFileSync(`${controlDir}/${name}.next`, JSON.stringify(fields), { mode: 0o600 })
    fs.renameSync(`${controlDir}/${name}.next`, `${controlDir}/${name}.json`)
  }
  const acknowledge = fields => writeRecord('ack', fields)
  const recordPause = (id, state) => writeRecord('pause', { id, state, at: Date.now() })
  const finishPause = reason => {
    if (!pause) return
    const old = pause
    pause = null
    clearTimeout(old.timer)
    recordPause(old.id, reason)
    old.resume?.()
    acknowledge({ id: old.id, state: reason })
  }
  const server = https.createServer({ key, cert }, (request, response) => {
    const url = new URL(request.url, 'https://fixture.invalid')
    if (!request.url.startsWith('/') || request.url.startsWith('//')) {
      response.destroy()
      return
    }
    const watch = url.searchParams.get('watch') === 'true'
    const kind = url.pathname.endsWith('/mcpservers')
      ? 'McpServer'
      : url.pathname.endsWith('/contexts')
        ? 'Context'
        : 'other'
    let upstream
    const stream = {
      request,
      response,
      kind,
      watch,
      born: Date.now(),
      close: () => {
        upstream?.destroy()
        response.destroy()
        request.destroy()
      },
    }
    streams.add(stream)
    response.once('close', () => {
      streams.delete(stream)
      upstream?.destroy()
    })
    const forward = () => {
      if (response.destroyed) return
      // Authentication is forwarded only in process memory to the verified API.
      upstream = https.request(
        {
          hostname: upstreamHost,
          port: upstreamPort,
          method: request.method,
          path: request.url,
          ca: upstreamCa,
          rejectUnauthorized: true,
          headers: { ...request.headers, host: upstreamHost },
          agent: false,
        },
        incoming => {
          response.writeHead(incoming.statusCode, incoming.headers)
          incoming.pipe(response)
        }
      )
      upstream.on('error', () => stream.close())
      request.pipe(upstream)
    }
    if (
      pause &&
      !pause.intercepted &&
      request.method === 'GET' &&
      !watch &&
      url.pathname === pause.path
    ) {
      pause.intercepted = true
      pause.resume = forward
      recordPause(pause.id, 'intercepted')
      acknowledge({ id: pause.id, state: 'intercepted', method: 'GET', path: pause.path })
    } else forward()
  })
  const poll = setInterval(() => {
    try {
      if (!fs.existsSync(`${controlDir}/command.json`)) return
      const command = validateCommand(
        JSON.parse(fs.readFileSync(`${controlDir}/command.json`, 'utf8')),
        allowedPaths
      )
      if (command.id === commandId) return
      commandId = command.id
      if (command.action === 'arm') {
        if (pause) throw new Error('pause_already_active')
        pause = {
          ...command,
          intercepted: false,
          timer: setTimeout(() => finishPause('expired'), command.durationMs),
        }
        recordPause(command.id, 'armed')
        acknowledge({ id: command.id, state: 'armed' })
      } else if (command.action === 'release') {
        if (!pause || pause.id !== command.pauseId || !pause.intercepted)
          throw new Error('pause_not_held')
        finishPause('released')
        acknowledge({ id: command.id, state: 'released' })
      } else {
        let count = 0
        for (const stream of streams) {
          if (
            stream.watch &&
            (command.kind === 'both'
              ? ['McpServer', 'Context'].includes(stream.kind)
              : stream.kind === command.kind)
          ) {
            stream.close()
            count++
          }
        }
        acknowledge({ id: command.id, state: 'cut', count })
      }
    } catch {
      acknowledge({ id: commandId, state: 'rejected' })
    }
  }, 100)
  const churn = setInterval(() => {
    if (fs.existsSync(`${controlDir}/paused`)) return
    for (const stream of streams)
      if (stream.watch && Date.now() - stream.born >= minAgeMs) stream.close()
  }, periodMs)
  const close = () => {
    clearInterval(poll)
    clearInterval(churn)
    finishPause('shutdown')
    for (const stream of streams) stream.close()
    server.close()
  }
  return { server, close }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const proxy = createProxy({
    key: fs.readFileSync('/fixture-tls/tls.key'),
    cert: fs.readFileSync('/fixture-tls/tls.crt'),
    upstreamCa: fs.readFileSync('/upstream-ca/ca.crt'),
    allowedPaths: JSON.parse(process.env.PAUSE_PATHS),
    controlDir: '/churn-ctl',
    periodMs: Number(process.env.CHURN_PERIOD_MS),
    minAgeMs: Number(process.env.CHURN_MIN_AGE_MS),
  })
  proxy.server.listen(8443, '0.0.0.0')
  process.on('SIGTERM', proxy.close)
}
