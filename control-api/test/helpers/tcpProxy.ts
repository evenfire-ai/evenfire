import net from 'node:net'

/**
 * A controllable TCP proxy between pg and a real Postgres.
 *
 * Accept modes: 'pass', or 'blackhole' (accepts the TCP connection and never
 * answers, a hung connect). Traffic modes, per connection: 'pass';
 * 'dropNotify' (drops backend NotificationResponse messages, the rest flows);
 * 'frozen' (half-open: nothing flows either way and a FIN is swallowed).
 */
export type ProxyAccept = 'pass' | 'blackhole'
export type ProxyTraffic = 'pass' | 'dropNotify' | 'frozen'

type ProxiedConnection = {
  client: net.Socket
  upstream: net.Socket | null
  traffic: ProxyTraffic
  buffer: Buffer
}

export type TcpProxy = {
  readonly port: number
  readonly stats: { accepted: number; droppedNotifications: number }
  readonly openConnections: number
  setAccept(mode: ProxyAccept): void
  /** Changes the traffic of open connections and, unless `existingOnly`, of new ones. */
  setTraffic(mode: ProxyTraffic, opts?: { existingOnly?: boolean }): void
  /** TCP RST on both sides of every open connection. */
  resetAll(): void
  /** Destroys every open connection on both sides (test cleanup). */
  destroyAll(): void
  close(): Promise<void>
}

const NOTIFICATION_RESPONSE = 0x41 // 'A'

export async function startTcpProxy(
  upstreamPort: number,
  upstreamHost = '127.0.0.1'
): Promise<TcpProxy> {
  let accept: ProxyAccept = 'pass'
  let traffic: ProxyTraffic = 'pass'
  const connections = new Set<ProxiedConnection>()
  const stats = { accepted: 0, droppedNotifications: 0 }

  const server = net.createServer({ allowHalfOpen: true }, client => {
    stats.accepted += 1
    const rec: ProxiedConnection = { client, upstream: null, traffic, buffer: Buffer.alloc(0) }
    connections.add(rec)
    client.on('error', () => {})
    client.on('close', () => {
      connections.delete(rec)
      rec.upstream?.destroy()
    })
    if (accept === 'blackhole') {
      client.on('data', () => {})
      return
    }
    const upstream = net.connect(upstreamPort, upstreamHost)
    rec.upstream = upstream
    upstream.on('error', () => {})
    upstream.on('close', () => client.destroy())
    client.on('data', d => {
      if (rec.traffic !== 'frozen') upstream.write(d)
    })
    client.on('end', () => {
      if (rec.traffic === 'frozen') return
      upstream.end()
      client.end()
    })
    upstream.on('data', d => {
      if (rec.traffic === 'frozen') return
      if (rec.traffic === 'pass') {
        client.write(d)
        return
      }
      rec.buffer = Buffer.concat([rec.buffer, d])
      const out: Buffer[] = []
      while (rec.buffer.length >= 5) {
        const len = rec.buffer.readInt32BE(1)
        if (rec.buffer.length < 1 + len) break
        const message = rec.buffer.subarray(0, 1 + len)
        rec.buffer = rec.buffer.subarray(1 + len)
        if (message[0] === NOTIFICATION_RESPONSE) {
          stats.droppedNotifications += 1
          continue
        }
        out.push(message)
      }
      if (out.length > 0) client.write(Buffer.concat(out))
    })
  })

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port))
  })

  return {
    port,
    stats,
    get openConnections() {
      return connections.size
    },
    setAccept(mode) {
      accept = mode
    },
    setTraffic(mode, { existingOnly = false } = {}) {
      if (!existingOnly) traffic = mode
      for (const c of connections) {
        // A message split across chunks before the switch would desync the parser.
        if (mode === 'dropNotify' && c.traffic !== 'dropNotify') c.buffer = Buffer.alloc(0)
        c.traffic = mode
      }
    },
    resetAll() {
      for (const c of connections) {
        c.client.resetAndDestroy()
        c.upstream?.resetAndDestroy()
      }
    },
    destroyAll() {
      for (const c of connections) {
        c.client.destroy()
        c.upstream?.destroy()
      }
    },
    close: () =>
      new Promise<void>(resolve => {
        for (const c of connections) {
          c.client.destroy()
          c.upstream?.destroy()
        }
        server.close(() => resolve())
      }),
  }
}
