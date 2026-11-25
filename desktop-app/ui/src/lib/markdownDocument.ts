import {
  CHAT_FILE_PREVIEW_MARKDOWN_CONCURRENCY,
  CHAT_FILE_PREVIEW_MARKDOWN_TIMEOUT_MS,
} from '@constants/chatRendering'
import type { ChatMessageSemanticModel } from './chatMessageSemantics'
import type { MarkdownDocumentRequest } from './markdownDocument.types'
import { createPreviewSlots } from './previewSlots'

const workers = createPreviewSlots(CHAT_FILE_PREVIEW_MARKDOWN_CONCURRENCY)

/** Parses in a worker with a timeout; null means the file should show as plain text. */
export async function layOutMarkdown(
  request: MarkdownDocumentRequest,
  signal: AbortSignal
): Promise<ChatMessageSemanticModel | null> {
  const release = await workers.acquire(signal)
  let worker: Worker | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    signal.throwIfAborted()
    const running = new Worker(new URL('./markdownDocument.worker.ts', import.meta.url), {
      type: 'module',
    })
    worker = running
    return await new Promise<ChatMessageSemanticModel | null>(resolve => {
      const giveUp = () => resolve(null)
      timer = setTimeout(giveUp, CHAT_FILE_PREVIEW_MARKDOWN_TIMEOUT_MS)
      signal.addEventListener('abort', giveUp, { once: true })
      running.onerror = giveUp
      running.onmessage = (event: MessageEvent<ChatMessageSemanticModel | null>) =>
        resolve(event.data)
      running.postMessage(request)
    })
  } finally {
    clearTimeout(timer)
    worker?.terminate()
    release()
  }
}
