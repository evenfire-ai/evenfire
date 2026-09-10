import dgram from 'node:dgram'

/** Minimal authoritative UDP DNS fixture; only synthetic .test names. */
export async function startDnsFixture() {
  const server = dgram.createSocket('udp4')
  const queries = new Map()
  server.on('message', (packet, peer) => {
    let offset = 12
    const labels = []
    while (offset < packet.length && packet[offset]) {
      const length = packet[offset++]
      if (length > 63 || offset + length > packet.length) return
      labels.push(packet.toString('ascii', offset, offset + length))
      offset += length
    }
    if (offset + 5 > packet.length) return
    offset++
    const type = packet.readUInt16BE(offset)
    offset += 4
    const name = labels.join('.')
    const key = name + ':' + type
    queries.set(key, (queries.get(key) ?? 0) + 1)
    let data
    if (name.endsWith('.test')) {
      if (type === 1)
        data = Buffer.from(
          name === 'rebind.test' && queries.get(key) > 1 ? [127, 0, 0, 1] : [11, 198, 0, 2]
        )
      if (type === 28 && name === 'mixed.test')
        data = Buffer.from('00000000000000000000000000000001', 'hex')
    }
    const header = Buffer.from(packet.subarray(0, 12))
    header.writeUInt16BE(0x8180, 2)
    header.writeUInt16BE(1, 4)
    header.writeUInt16BE(data ? 1 : 0, 6)
    header.writeUInt32BE(0, 8)
    const parts = [header, packet.subarray(12, offset)]
    if (data) {
      const answer = Buffer.alloc(12)
      answer.writeUInt16BE(0xc00c, 0)
      answer.writeUInt16BE(type, 2)
      answer.writeUInt16BE(1, 4)
      answer.writeUInt32BE(0, 6)
      answer.writeUInt16BE(data.length, 10)
      parts.push(answer, data)
    }
    server.send(Buffer.concat(parts), peer.port, peer.address)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.bind(53, '127.0.0.1', resolve)
  })
  return { queries, close: () => server.close() }
}
