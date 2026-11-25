import {
  CHAT_GFS_DOWNLOAD_CONCURRENCY,
  CHAT_GFS_DOWNLOAD_TIMEOUT_MS,
} from '@constants/chatRendering'
import { createPreviewSlots } from './previewSlots'

type ChatGfsFile = Readonly<{ name: string; bytes: ArrayBuffer }>

const downloads = createPreviewSlots(CHAT_GFS_DOWNLOAD_CONCURRENCY)

export function isTooLargeToShow(error: unknown): boolean {
  return error instanceof Error && /exceeds the \d+-byte limit/.test(error.message)
}

/** Uses the Files preview download, which checks access on every call. Nothing is cached, so bytes never outlive a session. */
export async function loadChatGfsFile(
  uri: string,
  maxBytes: number,
  signal?: AbortSignal
): Promise<ChatGfsFile> {
  const release = await downloads.acquire(signal)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    if (signal?.aborted) throw new Error('The preview closed before its file loaded')
    const downloaded = await Promise.race([
      window.clerum.gfs.downloadPreview(uri, maxBytes),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('The file took too long to load')),
          CHAT_GFS_DOWNLOAD_TIMEOUT_MS
        )
      }),
    ])
    if (downloaded.bytes.byteLength > maxBytes) {
      throw new Error(`The file exceeds the ${maxBytes}-byte limit`)
    }
    return { name: downloaded.resource.name, bytes: downloaded.bytes }
  } finally {
    clearTimeout(timer)
    release()
  }
}
