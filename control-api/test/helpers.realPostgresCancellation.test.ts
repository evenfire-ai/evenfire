import { expect, it } from 'vitest'
import { once } from 'node:events'
import { type Socket, createConnection, createServer } from 'node:net'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { createPostgresCommitReplyBlackhole } from './helpers/realPostgresCancellation.js'

async function observed(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('proxy lifecycle observation did not arrive')
    await nextTurn()
  }
}

function query(sql: string): Buffer {
  const body = Buffer.from(`${sql}\0`)
  const header = Buffer.alloc(5)
  header[0] = 'Q'.charCodeAt(0)
  header.writeInt32BE(body.length + 4, 1)
  return Buffer.concat([header, body])
}

it('forwards fragmented COMMIT bytes, discards the reply and recovers later replies', async () => {
  const sockets = new Set<Socket>()
  let received = Buffer.alloc(0)
  let repliedToCommit = false
  const backend = createServer(socket => {
    sockets.add(socket)
    socket.on('data', chunk => {
      received = Buffer.concat([received, chunk])
      if (!repliedToCommit && received.length === 8 + query('COMMIT').length) {
        repliedToCommit = true
        socket.write('commit-reply')
      } else if (
        repliedToCommit &&
        received.length === 8 + query('COMMIT').length + query('SELECT 1').length
      ) {
        socket.write('later-reply')
      }
    })
    socket.on('end', () => socket.end())
    socket.on('error', () => {})
  })
  backend.listen(0, '127.0.0.1')
  await once(backend, 'listening')
  const address = backend.address()
  if (!address || typeof address === 'string') throw new Error('missing fixture backend address')
  const proxy = await createPostgresCommitReplyBlackhole(
    ['postgresql:', `//fixture@127.0.0.1:${address.port}/fixture`].join('')
  )
  const target = new URL(proxy.connectionString)
  const client = createConnection({ host: target.hostname, port: Number(target.port) })
  const replies: Buffer[] = []
  client.on('data', chunk => replies.push(chunk))
  client.on('error', () => {})
  try {
    await once(client, 'connect')
    const startup = Buffer.alloc(8)
    startup.writeInt32BE(8, 0)
    startup.writeInt32BE(196608, 4)
    client.write(startup)
    await observed(() => received.length === 8)
    const commit = query('COMMIT')
    client.write(commit.subarray(0, 2))
    await observed(() => received.length === 10)
    expect(proxy.commands).toEqual([])
    client.write(commit.subarray(2))
    await proxy.commitForwarded
    await observed(() => proxy.discardedReplyBytes > 0)
    expect(received.subarray(8)).toEqual(commit)
    expect(proxy.commands).toEqual(['COMMIT'])
    expect(replies).toEqual([])
    proxy.allowReplies()
    client.write(query('SELECT 1'))
    await observed(() => Buffer.concat(replies).toString() === 'later-reply')
  } finally {
    client.destroy()
    await proxy.close()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve, reject) =>
      backend.close(error => (error ? reject(error) : resolve()))
    )
  }
})

it('refuses an encrypted protocol prerequisite instead of pretending to observe COMMIT', async () => {
  await expect(
    createPostgresCommitReplyBlackhole(
      ['postgresql:', '//fixture@127.0.0.1/fixture?sslmode=require'].join('')
    )
  ).rejects.toThrow('plaintext PostgreSQL connection')
})
