import { once } from 'node:events'
import { type Socket, createConnection, createServer } from 'node:net'

/** Observe a real COMMIT while discarding its reply on the owned local PG lane. */
export async function createPostgresCommitReplyBlackhole(connectionString: string) {
  const target = new URL(connectionString)
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
  let armed = true
  let dropping = false
  let discardedReplyBytes = 0
  const server = createServer(front => {
    const host = target.hostname.replace(/^\[|\]$/g, '')
    const back = createConnection({ host, port: Number(target.port || 5432) })
    for (const socket of [front, back]) {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    }
    front.on('error', () => back.destroy())
    back.on('error', () => front.destroy())
    front.on('end', () => back.end())
    back.on('end', () => front.end())
    let startup = true
    let buffered = Buffer.alloc(0)
    front.on('data', chunk => {
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
          if (sql === 'COMMIT' && armed) {
            armed = false
            dropping = true
            commit()
          }
        }
        buffered = buffered.subarray(length + 1)
      }
      back.write(chunk)
    })
    back.on('data', chunk => {
      if (dropping) discardedReplyBytes += chunk.length
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
  return {
    connectionString: proxied.toString(),
    commitForwarded,
    commands,
    get discardedReplyBytes() {
      return discardedReplyBytes
    },
    allowReplies: () => {
      dropping = false
    },
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      )
    },
  }
}
