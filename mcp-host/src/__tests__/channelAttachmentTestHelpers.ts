import * as path from 'node:path'
import {
  CHANNEL_ATTACHMENT_STORE_SUBDIR,
  type ChannelAttachmentPutResult,
  type ChannelAttachmentStore,
} from '../internalTools/channelAttachmentStore'

/**
 * Test-only helper calling the real `ChannelAttachmentStore.putStream` API
 * (replaces removed production `putBuffer` method per BR-T5).
 */
export async function putTestBuffer(
  store: ChannelAttachmentStore,
  input: {
    bytes: Buffer | Uint8Array
    linkedUserId: string
    maxBytes?: number
    attachmentId?: string
  }
): Promise<ChannelAttachmentPutResult> {
  const buf = Buffer.isBuffer(input.bytes)
    ? input.bytes
    : Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength)
  async function* singleChunk() {
    if (buf.length > 0) yield buf
  }
  return store.putStream({
    stream: singleChunk(),
    linkedUserId: input.linkedUserId,
    declaredBytes: buf.length,
    maxBytes: input.maxBytes,
    attachmentId: input.attachmentId,
  })
}

/**
 * Derive the host-owned channel attachment storage directory from the exported
 * `CHANNEL_ATTACHMENT_STORE_SUBDIR` constant (replaces removed `getStoreDir()` per BR-T5).
 */
export function channelAttachmentStoreDir(hostWorkspaceRoot: string): string {
  return path.join(path.resolve(hostWorkspaceRoot), CHANNEL_ATTACHMENT_STORE_SUBDIR)
}
