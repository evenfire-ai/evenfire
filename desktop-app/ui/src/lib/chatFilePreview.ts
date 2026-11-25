import {
  CHAT_FILE_PREVIEW_BLOCK_MAX_CHARS,
  CHAT_FILE_PREVIEW_IMAGE_MAX_BYTES,
  CHAT_FILE_PREVIEW_TEXT_MAX_BYTES,
  CHAT_FILE_PREVIEW_TEXT_MAX_CHARS,
  CHAT_FILE_PREVIEW_TEXT_MAX_LINES,
  CHAT_GENERATED_FILE_PREVIEW_KINDS,
} from '@constants/chatRendering'
import { HTML_PREVIEW_ARTIFACT_MAX_BYTES } from '@constants/htmlPreview'
import type { ChatMessageAttachment } from '../../../src/types'

export type ChatFilePreviewKind = 'image' | 'markdown' | 'table' | 'code' | 'text' | 'html'

const KIND_BY_EXTENSION: Readonly<Record<string, ChatFilePreviewKind>> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  md: 'markdown',
  markdown: 'markdown',
  csv: 'table',
  tsv: 'table',
  json: 'code',
  txt: 'text',
  log: 'text',
  html: 'html',
  htm: 'html',
}

// The extension decides the image type, never the type the server reports.
const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

export function chatImageBlob(name: string, bytes: ArrayBuffer): Blob | null {
  const extension = fileExtension(name)
  if (!Object.hasOwn(IMAGE_MIME_BY_EXTENSION, extension)) return null
  return new Blob([bytes], { type: IMAGE_MIME_BY_EXTENSION[extension] })
}

export function fileExtension(name: string): string {
  const match = /\.([a-z0-9]{1,10})$/i.exec(name.trim())
  return match?.[1]?.toLowerCase() ?? ''
}

export function chatFilePreviewKind(name: string): ChatFilePreviewKind | null {
  const extension = fileExtension(name)
  return Object.hasOwn(KIND_BY_EXTENSION, extension) ? (KIND_BY_EXTENSION[extension] ?? null) : null
}

export function chatFilePreviewMaxBytes(kind: ChatFilePreviewKind): number {
  if (kind === 'image') return CHAT_FILE_PREVIEW_IMAGE_MAX_BYTES
  if (kind === 'html') return HTML_PREVIEW_ARTIFACT_MAX_BYTES
  return CHAT_FILE_PREVIEW_TEXT_MAX_BYTES
}

/** HTML downloads up to the text limit so an oversized page reports its size instead of failing. */
export function chatFileDownloadMaxBytes(kind: ChatFilePreviewKind): number {
  return kind === 'html' ? CHAT_FILE_PREVIEW_TEXT_MAX_BYTES : chatFilePreviewMaxBytes(kind)
}

export function decodeBase64(dataBase64: string): ArrayBuffer {
  const binary = window.atob(dataBase64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes.buffer
}

/** UTF-16 when the byte order mark says so, otherwise UTF-8. */
export function decodeText(bytes: ArrayBuffer): string {
  const [first, second] = new Uint8Array(bytes.slice(0, 2))
  const littleEndian = first === 0xff && second === 0xfe
  const bigEndian = first === 0xfe && second === 0xff
  return new TextDecoder(littleEndian ? 'utf-16le' : bigEndian ? 'utf-16be' : 'utf-8').decode(bytes)
}

export function codeFenceFor(text: string): string {
  let longest = 0
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  return '`'.repeat(Math.max(3, longest + 1))
}

/** Only response files that carry their bytes; anything else keeps its Download chip. */
export function generatedFilePreviewKind(
  attachment: ChatMessageAttachment
): ChatFilePreviewKind | null {
  if (attachment.type !== 'response_file' || attachment.encoding !== 'base64') return null
  if (!attachment.dataBase64) return null
  const kind = chatFilePreviewKind(attachment.filename || attachment.label)
  return kind && CHAT_GENERATED_FILE_PREVIEW_KINDS.has(kind) ? kind : null
}

export function beginningOfText(text: string): { text: string; truncated: boolean } {
  let end = Math.min(text.length, CHAT_FILE_PREVIEW_TEXT_MAX_CHARS)
  let lineStart = 0
  for (let line = 0; line < CHAT_FILE_PREVIEW_TEXT_MAX_LINES; line += 1) {
    const next = text.indexOf('\n', lineStart)
    if (next === -1 || next >= end)
      return { text: text.slice(0, end), truncated: end < text.length }
    lineStart = next + 1
  }
  end = Math.min(end, lineStart)
  return { text: text.slice(0, end), truncated: end < text.length }
}

/** Blocks are laid out independently: layout time can grow quadratically within one. */
export function textBlocks(text: string): string[] {
  const blocks: string[] = []
  let lines: string[] = []
  let length = 0
  const endBlock = () => {
    if (lines.length === 0) return
    // A trailing empty line needs an extra break to be visible.
    blocks.push(lines.join('\n') + (lines[lines.length - 1] === '' ? '\n' : ''))
    lines = []
    length = 0
  }
  // A final line break does not start another line.
  for (const line of text.replace(/\n$/, '').split('\n')) {
    let at = 0
    while (line.length - at > CHAT_FILE_PREVIEW_BLOCK_MAX_CHARS) {
      endBlock()
      const cut = at + CHAT_FILE_PREVIEW_BLOCK_MAX_CHARS
      // Never split a surrogate pair.
      const half = /[\ud800-\udbff]/.test(line[cut - 1] ?? '') ? 1 : 0
      lines = [line.slice(at, cut - half)]
      at = cut - half
      endBlock()
    }
    const rest = line.slice(at)
    if (length + rest.length > CHAT_FILE_PREVIEW_BLOCK_MAX_CHARS) endBlock()
    lines.push(rest)
    length += rest.length + 1
  }
  endBlock()
  return blocks
}

/** Characters that indentation would add; stops once past `limit`. */
function jsonIndentation(text: string, limit: number): number {
  let added = 0
  let depth = 0
  for (let index = 0; index < text.length && added <= limit; index += 1) {
    const char = text[index]
    if (char === '"') {
      for (index += 1; index < text.length && text[index] !== '"'; index += 1) {
        if (text[index] === '\\') index += 1
      }
    } else if (char === '{' || char === '[') {
      depth += 1
      added += 1 + 2 * depth
    } else if (char === '}' || char === ']') {
      depth -= 1
      added += 1 + 2 * depth
    } else if (char === ',') {
      added += 1 + 2 * depth
    } else if (char === ':') {
      added += 1
    }
  }
  return added
}

/** Reindents without rewriting values: `JSON.parse` rounds long numbers and drops duplicate keys. */
export function formattedJson(text: string): string {
  const limit = Math.min(Math.max(text.length * 4, 64 * 1024), CHAT_FILE_PREVIEW_TEXT_MAX_BYTES)
  if (jsonIndentation(text, limit) > limit) return text
  try {
    JSON.parse(text)
  } catch {
    return text
  }
  let depth = 0
  let opened = false
  let result = ''
  const newLine = () => `\n${'  '.repeat(depth)}`
  for (const [token] of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\],:]|[^\s"{}[\],:]+/g)) {
    if (token === '}' || token === ']') {
      depth -= 1
      result += opened ? token : newLine() + token
      opened = false
      continue
    }
    if (opened) result += newLine()
    opened = token === '{' || token === '['
    if (opened) depth += 1
    result += token === ':' ? ': ' : token
    if (token === ',') result += newLine()
    // Only the beginning is displayed.
    if (result.length > 2 * CHAT_FILE_PREVIEW_TEXT_MAX_CHARS) return result
  }
  return result
}
