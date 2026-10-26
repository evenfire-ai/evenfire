import { once } from 'node:events'
import { type Socket, createConnection, createServer } from 'node:net'

/** Observe a real COMMIT while discarding its reply on the owned local PG lane. */
export async function createPostgresCommitReplyBlackhole(
  connectionString: string,
  dropCommitNumber = 1
) {
  return createPostgresProtocolBlackhole(connectionString, true, dropCommitNumber)
}

/** Hide replies and client disconnects without ending the real backend socket. */
export async function createPostgresDisconnectBlackhole(connectionString: string) {
  return createPostgresProtocolBlackhole(connectionString, false, 1)
}

async function createPostgresProtocolBlackhole(
  connectionString: string,
  dropCommitReply: boolean,
  dropCommitNumber: number
) {
  if (!Number.isSafeInteger(dropCommitNumber) || dropCommitNumber < 1) {
    throw new Error('dropCommitNumber must be a positive integer')
  }
  const target = new URL(connectionString)
  const targetHost = target.searchParams.get('host') || target.hostname.replace(/^\[|\]$/g, '')
  const queryPort = target.searchParams.get('port')
  const targetPort = Number(queryPort || target.port || 5432)
  const sslMode = target.searchParams.get('sslmode')
  if (sslMode && sslMode !== 'disable') {
    throw new Error('COMMIT reply observation requires the harness plaintext PostgreSQL connection')
  }
  const sockets = new Set<Socket>()
  const commands: string[] = []
  let commit!: () => void
  const commitForwarded = new Promise<void>(resolve => {
    commit = resolve
  })
  let armed = dropCommitReply
  let commitCount = 0
  let droppingBackend: Socket | undefined
  let droppedFrontend: Socket | undefined
  let dropAllReplies = false
  let discardedReplyBytes = 0
  let discardedFrontendBytes = 0
  let suppressDisconnects = false
  let suppressedDisconnects = 0
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
    front.on('error', () => {
      if (suppressDisconnects) suppressedDisconnects++
      else back.destroy()
    })
    back.on('error', () => front.destroy())
    front.on('end', () => {
      if (suppressDisconnects) suppressedDisconnects++
      else back.end()
    })
    back.on('end', () => front.end())
    let startup = true
    let buffered = Buffer.alloc(0)
    front.on('data', chunk => {
      // pg may send Terminate before FIN on an idle checkout. A network fault
      // that hides disconnects must suppress both; forwarding either would let
      // the test pass because of EOF instead of the server timeout backstop.
      if (suppressDisconnects) {
        discardedFrontendBytes += chunk.length
        return
      }
      buffered = Buffer.concat([buffered, chunk])
      if (startup && buffered.length >= 4 && buffered.length >= buffered.readInt32BE(0)) {
        buffered = buffered.subarray(buffered.readInt32BE(0))
        startup = false
      }
      while (!startup && buffered.length >= 5 && buffered.length >= buffered.readInt32BE(1) + 1) {
        const length = buffered.readInt32BE(1)
        if (buffered[0] === 'Q'.charCodeAt(0)) {
          const sql = buffered.toString('utf8', 5, length)
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') commands.push(sql)
          if (sql === 'COMMIT') commitCount++
          if (sql === 'COMMIT' && armed && commitCount === dropCommitNumber) {
            armed = false
            droppingBackend = back
            droppedFrontend = front
            commit()
          }
        }
        buffered = buffered.subarray(length + 1)
      }
      back.write(chunk)
    })
    back.on('data', chunk => {
      if (dropAllReplies || back === droppingBackend) discardedReplyBytes += chunk.length
      else front.write(chunk)
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing COMMIT observer address')
  const proxied = new URL(connectionString)
  proxied.hostname = '127.0.0.1'
  proxied.port = String(address.port)
  proxied.searchParams.delete('host')
  proxied.searchParams.delete('port')
  return {
    connectionString: proxied.toString(),
    commitForwarded,
    commands,
    get discardedReplyBytes() {
      return discardedReplyBytes
    },
    get discardedFrontendBytes() {
      return discardedFrontendBytes
    },
    get suppressedDisconnects() {
      return suppressedDisconnects
    },
    failClientAfterCommitForwarded: () => {
      const front = droppedFrontend
      if (!front) throw new Error('no targeted COMMIT reply is being withheld')
      droppingBackend = undefined
      droppedFrontend = undefined
      front.destroy(new Error('simulated lost COMMIT acknowledgement'))
    },
    dropRepliesAndDisconnects: () => {
      armed = false
      dropAllReplies = true
      suppressDisconnects = true
    },
    allowReplies: () => {
      dropAllReplies = false
      suppressDisconnects = false
      droppingBackend = undefined
      droppedFrontend = undefined
    },
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      )
    },
  }
}
