import type { BoundedEnvBytes } from './staticSourceAuthority.js'

export function assertUploadV2TransportBounds(input: {
  writerProtocol: number
  writerPart: number
  protocolMirrors: number[]
  partMirrors: number[]
  relayBounds: BoundedEnvBytes[]
  gatewayBytes: number
}): void {
  if (input.protocolMirrors.length === 0)
    throw new Error('protocol mirrors must contain at least one producer')
  if (input.partMirrors.length === 0)
    throw new Error('part mirrors must contain at least one producer')
  if (input.relayBounds.length === 0)
    throw new Error('relay bounds must contain at least one producer')
  if (input.writerProtocol !== 1024 * 1024 * 1024)
    throw new Error('writer protocol maximum must remain 1 GiB')
  if (input.writerPart !== 16 * 1024 * 1024)
    throw new Error('writer part maximum must remain 16 MiB')
  if (input.writerPart >= input.writerProtocol)
    throw new Error('writer part maximum must be below the protocol maximum')
  if (input.protocolMirrors.some(value => value !== input.writerProtocol))
    throw new Error('client protocol maximum diverges from the writer')
  if (input.partMirrors.some(value => value !== input.writerPart))
    throw new Error('client part maximum diverges from the writer')
  if (
    input.relayBounds.some(
      bounds => bounds.fallback !== input.writerPart || bounds.ceiling !== input.writerPart
    )
  ) {
    throw new Error('relay part maximum diverges from the writer')
  }
  if (input.writerPart >= input.gatewayBytes)
    throw new Error('gateway request cap cannot safely carry an Upload v2 part')
}
