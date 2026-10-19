/** Writing the density a PNG declares in its pHYs chunk. */

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buf) {
    crc ^= byte
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** `png` declaring `ppm` pixels a metre, in place of any density it declared. */
export function withPngDensity(png: Buffer, ppm: number): Buffer {
  const data = Buffer.alloc(9)
  data.writeUInt32BE(ppm, 0)
  data.writeUInt32BE(ppm, 4)
  data.writeUInt8(1, 8)
  const type = Buffer.from('pHYs', 'latin1')
  const chunk = Buffer.alloc(21)
  chunk.writeUInt32BE(9, 0)
  type.copy(chunk, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(Buffer.concat([type, data])), 17)
  const chunks: Buffer[] = [png.subarray(0, 8)]
  let at = 8
  while (at + 8 <= png.length) {
    const length = png.readUInt32BE(at)
    const name = png.toString('latin1', at + 4, at + 8)
    if (name !== 'pHYs') chunks.push(png.subarray(at, at + 12 + length))
    if (name === 'IHDR') chunks.push(chunk)
    at += 12 + length
  }
  return Buffer.concat(chunks)
}
