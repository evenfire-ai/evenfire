export function toArrayBuffer(value: unknown): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value
  if (ArrayBuffer.isView(value)) {
    const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    return view.slice().buffer
  }
  if (value && typeof value === 'object') {
    const maybeData = (value as { data?: unknown }).data
    if (Array.isArray(maybeData)) return new Uint8Array(maybeData).buffer
  }
  throw new Error('Unexpected workflow artifact payload')
}
