import { once } from 'node:events'
import { type Socket, createConnection, createServer } from 'node:net'

type ErrorFields = {
  code: string | null
  severity: string | null
  message: string | null
}

function parseErrorFields(frame: Buffer): ErrorFields {
  const fields: ErrorFields = { code: null, severity: null, message: null }
  let offset = 5
  while (offset < frame.length && frame[offset] !== 0) {
    const field = String.fromCharCode(frame[offset]!)
    const end = frame.indexOf(0, offset + 1)
    if (end < 0) break
    const value = frame.toString('utf8', offset + 1, end)
    if (field === 'C') fields.code = value
    if (field === 'S') fields.severity = value
    if (field === 'M') fields.message = value
    offset = end + 1
  }
  return fields
}

/** Drop a real successful COMMIT reply, then expose PostgreSQL's backend FATAL. */
export async function createPostgresFatalCommitReplyInjector(connectionString: string) {
  const target = new URL(connectionString)
  const targetHost = target.searchParams.get('host') || target.hostname.replace(/^\[|\]$/g, '')
  const targetPort = Number(target.searchParams.get('port') || target.port || 5432)
  const sockets = new Set<Socket>()
  const commands: string[] = []
  let commitAckWithheldResolve!: () => void
  let backendReadyResolve!: (pid: number) => void
  let fatalResponseResolve!: (fields: ErrorFields) => void
  const commitAckWithheld = new Promise<void>(resolve => {
    commitAckWithheldResolve = resolve
  })
  const backendReady = new Promise<number>(resolve => {
    backendReadyResolve = resolve
  })
  const fatalResponse = new Promise<ErrorFields>(resolve => {
    fatalResponseResolve = resolve
  })
  let backendPid: number | undefined
  let withheldCommitReply = false

  const server = createServer({ allowHalfOpen: true }, front => {
    const back = targetHost.startsWith('/')
      ? createConnection({
          path: `${targetHost.replace(/\/$/, '')}/.s.PGSQL.${targetPort}`,
          allowHalfOpen: true,
        })
      : createConnection({ host: targetHost, port: targetPort, allowHalfOpen: true })
    for (const socket of [front, back]) {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    }
    front.on('error', () => back.destroy())
    back.on('error', () => front.destroy())
    front.on('end', () => back.end())
    back.on('end', () => front.end())

    let clientStartupPending = true
    let clientBuffer = Buffer.alloc(0)
    front.on('data', chunk => {
      clientBuffer = Buffer.concat([clientBuffer, chunk])
      if (clientStartupPending) {
        if (clientBuffer.length < 4) return
        const startupLength = clientBuffer.readInt32BE(0)
        if (clientBuffer.length < startupLength) return
        back.write(clientBuffer.subarray(0, startupLength))
        clientBuffer = clientBuffer.subarray(startupLength)
        clientStartupPending = false
      }
      while (clientBuffer.length >= 5) {
        const length = clientBuffer.readInt32BE(1)
        const frameLength = length + 1
        if (clientBuffer.length < frameLength) break
        const frame = clientBuffer.subarray(0, frameLength)
        if (frame[0] === 'Q'.charCodeAt(0)) {
          const query = frame.toString('utf8', 5, frame.length - 1).trim()
          if (query === 'BEGIN' || query === 'COMMIT' || query === 'ROLLBACK') {
            commands.push(query)
          }
          if (query === 'COMMIT') withheldCommitReply = true
        }
        back.write(frame)
        clientBuffer = clientBuffer.subarray(frameLength)
      }
    })

    let serverBuffer = Buffer.alloc(0)
    let commitCommandComplete = false
    back.on('data', chunk => {
      serverBuffer = Buffer.concat([serverBuffer, chunk])
      while (serverBuffer.length >= 5) {
        const length = serverBuffer.readInt32BE(1)
        const frameLength = length + 1
        if (serverBuffer.length < frameLength) break
        const frame = serverBuffer.subarray(0, frameLength)
        const type = String.fromCharCode(frame[0]!)
        let forward = true
        if (type === 'K' && frame.length >= 13) {
          backendPid = frame.readInt32BE(5)
          backendReadyResolve(backendPid)
        }
        if (
          withheldCommitReply &&
          type === 'C' &&
          frame.toString('utf8', 5, frame.length - 1) === 'COMMIT'
        ) {
          commitCommandComplete = true
          forward = false
        } else if (withheldCommitReply && type === 'Z' && commitCommandComplete) {
          withheldCommitReply = false
          commitCommandComplete = false
          forward = false
          commitAckWithheldResolve()
        }
        if (type === 'E') {
          const fields = parseErrorFields(frame)
          if (
            fields.code === '57P01' ||
            fields.severity === 'FATAL' ||
            fields.severity === 'PANIC'
          ) {
            fatalResponseResolve(fields)
          }
        }
        if (forward) front.write(frame)
        serverBuffer = serverBuffer.subarray(frameLength)
      }
    })
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing PostgreSQL proxy address')
  const proxied = new URL(connectionString)
  proxied.hostname = '127.0.0.1'
  proxied.port = String(address.port)
  proxied.searchParams.delete('host')
  proxied.searchParams.delete('port')

  return {
    connectionString: proxied.toString(),
    backendReady,
    commitAckWithheld,
    fatalResponse,
    commands,
    get backendPid() {
      return backendPid
    },
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      )
    },
  }
}
