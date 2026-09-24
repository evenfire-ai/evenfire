/**
 * The text-or-binary decision shared by `clerum__gfs_read` and
 * `clerum__attachment_read` (#666): one rule for every tool that hands file
 * bytes to the model as text.
 */

/** Signatures of formats that must never be returned as text (PDF, ZIP, GIF, RIFF, gzip). */
export function isNonTextFormat(bytes: Uint8Array): boolean {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const signature = buffer.byteLength >= 4 ? buffer.readUInt32LE(0) : 0
  const gif = buffer.subarray(0, 6).toString('ascii')
  return (
    buffer.subarray(0, 5).equals(Buffer.from('%PDF-')) ||
    [0x04034b50, 0x06054b50, 0x08074b50].includes(signature) ||
    gif === 'GIF87a' ||
    gif === 'GIF89a' ||
    (buffer.subarray(0, 4).equals(Buffer.from('RIFF')) &&
      ['WEBP', 'WAVE', 'AVI '].includes(buffer.subarray(8, 12).toString('ascii'))) ||
    (buffer[0] === 0x1f && buffer[1] === 0x8b)
  )
}

/**
 * The file as text, or null when it is not text: a binary signature, bytes
 * that are not strict UTF-8, or C0/C1 control characters other than TAB, LF
 * and CR. A leading UTF-8 byte order mark is dropped.
 */
export function decodeTextContent(bytes: Uint8Array): string | null {
  if (isNonTextFormat(bytes)) return null
  let text: string
  try {
    // TextDecoder already drops a UTF-8 BOM; strip again so classification
    // and the model see the same contract.
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '')
  } catch {
    return null
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text)) return null
  return text
}
