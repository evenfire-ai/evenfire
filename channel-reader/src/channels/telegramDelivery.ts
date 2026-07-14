import { Bot, InputFile } from 'grammy'
import { config } from '../config'
import { Attachment, SendMessageOptions, TelegramInlineKeyboardButton } from '../types'

const TELEGRAM_MAX_LENGTH = 4096
const TELEGRAM_MAX_CAPTION_LENGTH = 1024

function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining)
      break
    }

    let splitAt = remaining.lastIndexOf('\n', maxLength)
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(' ', maxLength)
    if (splitAt <= 0) splitAt = maxLength

    chunks.push(remaining.substring(0, splitAt))
    remaining = remaining.substring(splitAt).trimStart()
  }

  return chunks
}

function approxDecodedBytes(base64: string): number {
  const len = base64.length
  if (len === 0) return 0
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((len * 3) / 4) - padding
}

function splitCaptionAndRemainder(text: string): { caption: string; remainder: string } {
  if (text.length <= TELEGRAM_MAX_CAPTION_LENGTH) return { caption: text, remainder: '' }
  return {
    caption: text.substring(0, TELEGRAM_MAX_CAPTION_LENGTH),
    remainder: text.substring(TELEGRAM_MAX_CAPTION_LENGTH).trimStart(),
  }
}

function telegramInlineKeyboard(
  keyboard: TelegramInlineKeyboardButton[][] | undefined
): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } | undefined {
  if (!keyboard || keyboard.length === 0) return undefined
  const inline_keyboard = keyboard
    .map(row =>
      row
        .filter(button => button.text.trim() && button.callbackData.trim())
        .map(button => ({ text: button.text, callback_data: button.callbackData }))
    )
    .filter(row => row.length > 0)
  return inline_keyboard.length > 0 ? { inline_keyboard } : undefined
}

function sendMessageOptions(
  replyId: number | undefined,
  options?: SendMessageOptions,
  includeInlineKeyboard = false
): {
  reply_to_message_id?: number
  parse_mode?: 'HTML'
  reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }
} {
  const replyMarkup = includeInlineKeyboard
    ? telegramInlineKeyboard(options?.telegramInlineKeyboard)
    : undefined
  return {
    ...(replyId ? { reply_to_message_id: replyId } : {}),
    ...(options?.parseMode === 'telegram-html' ? { parse_mode: 'HTML' as const } : {}),
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  }
}

const WORKFLOW_DOCUMENT_MIME_BY_EXT = new Map([
  ['json', 'application/json'],
  ['txt', 'text/plain'],
  ['md', 'text/markdown'],
  ['csv', 'text/csv'],
  ['pdf', 'application/pdf'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
])

const INTERNAL_GENERATED_ARTIFACT_DOCUMENTS = [
  ['clerum__generate_markdown', 'md', 'text/markdown'],
  ['clerum__generate_pdf', 'pdf', 'application/pdf'],
  [
    'clerum__generate_docx',
    'docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],
  [
    'clerum__generate_xlsx',
    'xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ],
  [
    'clerum__generate_pptx',
    'pptx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ],
  ['clerum__generate_chart', 'png', 'image/png'],
] as const

const INTERNAL_GENERATED_ARTIFACT_MIME_BY_EXT = new Map<string, string>(
  INTERNAL_GENERATED_ARTIFACT_DOCUMENTS.map(([, format, mimeType]) => [format, mimeType])
)

const INTERNAL_GENERATED_ARTIFACT_FORMAT_BY_TOOL = new Map<string, string>(
  INTERNAL_GENERATED_ARTIFACT_DOCUMENTS.map(([tool, format]) => [tool, format])
)

const INTERNAL_GENERATED_ARTIFACT_PRODUCER = 'mcp-host-internal-tool'

function attachmentExtension(filename: string | undefined): string {
  if (!filename) return ''
  const idx = filename.lastIndexOf('.')
  return idx >= 0 ? filename.slice(idx + 1).toLowerCase() : ''
}

function safeDocumentFilename(filename: string | undefined, fallback: string): string {
  const raw = (filename || fallback).replace(/\\/g, '/').split('/').pop() || fallback
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160)
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : fallback
}

function isAllowedWorkflowDocument(attachment: Attachment): boolean {
  if (attachment.kind !== 'file') return false
  if (attachment.sourceTool !== 'workflow_result') return false
  const expected = WORKFLOW_DOCUMENT_MIME_BY_EXT.get(attachmentExtension(attachment.filename))
  if (!expected) return false
  return attachment.mimeType.split(';', 1)[0]?.toLowerCase() === expected
}

function isAllowedInternalGeneratedDocument(attachment: Attachment): boolean {
  if (attachment.kind !== 'file') return false
  if (attachment.lane !== 'internal_generated_artifact') return false
  if (attachment.producer !== INTERNAL_GENERATED_ARTIFACT_PRODUCER) return false
  const expectedFormat = attachment.sourceTool
    ? INTERNAL_GENERATED_ARTIFACT_FORMAT_BY_TOOL.get(attachment.sourceTool)
    : undefined
  if (!expectedFormat) return false
  if (attachment.artifactFormat !== expectedFormat) return false
  if (attachmentExtension(attachment.filename) !== expectedFormat) return false
  const expectedMime = INTERNAL_GENERATED_ARTIFACT_MIME_BY_EXT.get(expectedFormat)
  if (!expectedMime) return false
  return attachment.mimeType.split(';', 1)[0]?.toLowerCase() === expectedMime
}

export async function sendTelegramMessage(
  bot: Bot,
  channelId: string,
  content: string,
  replyToMessageId?: string,
  attachments?: Attachment[],
  options?: SendMessageOptions
): Promise<string | undefined> {
  const replyId = replyToMessageId ? parseInt(replyToMessageId, 10) : undefined

  const validAttachments = config.enableResponseAttachments
    ? (attachments || [])
        .filter(a => a.kind === 'image' && a.mimeType === 'image/jpeg' && a.encoding === 'base64')
        .slice(0, config.attachmentMaxCount)
    : []

  if (validAttachments.length > 0) {
    const inputFiles: InputFile[] = []
    const captions: string[] = []
    for (const attachment of validAttachments) {
      const estimatedBytes = approxDecodedBytes(attachment.dataBase64)
      if (estimatedBytes > config.attachmentMaxBytes) {
        console.warn(
          `[Telegram] Skipping oversized attachment ${attachment.id} (${estimatedBytes} bytes)`
        )
        continue
      }

      try {
        const buffer = Buffer.from(attachment.dataBase64, 'base64')
        inputFiles.push(new InputFile(buffer, attachment.filename || `${attachment.id}.jpg`))
        captions.push(attachment.caption || '')
      } catch (err) {
        console.warn(`[Telegram] Failed to decode attachment ${attachment.id}:`, err)
      }
    }

    if (inputFiles.length > 0) {
      const baseCaption = content.trim() ? content.trim() : captions[0]
      const { caption, remainder } = splitCaptionAndRemainder(baseCaption || '')
      const firstPhoto = await bot.api.sendPhoto(channelId, inputFiles[0], {
        caption: caption || undefined,
        reply_to_message_id: replyId,
      })
      const remainingPhotos = inputFiles.slice(1)
      if (remainingPhotos.length > 0) {
        await Promise.all(remainingPhotos.map(file => bot.api.sendPhoto(channelId, file)))
      }

      const trailingText = remainder.trim()
      if (trailingText) {
        await Promise.all(
          splitMessage(trailingText, TELEGRAM_MAX_LENGTH).map(chunk =>
            bot.api.sendMessage(channelId, chunk, sendMessageOptions(undefined, options))
          )
        )
      }

      console.log(
        `[Telegram] Sent reply to channel ${channelId} (${inputFiles.length} image attachment(s))`
      )
      return String(firstPhoto.message_id)
    }
  }

  const documentAttachments = (attachments || [])
    .filter(
      attachment =>
        isAllowedWorkflowDocument(attachment) ||
        (config.enableResponseAttachments && isAllowedInternalGeneratedDocument(attachment))
    )
    .slice(0, config.attachmentMaxCount)

  if (documentAttachments.length > 0) {
    const textResults =
      content && content.trim()
        ? await Promise.all(
            splitMessage(content, TELEGRAM_MAX_LENGTH).map((chunk, index) =>
              bot.api.sendMessage(
                channelId,
                chunk,
                sendMessageOptions(replyId, options, index === 0)
              )
            )
          )
        : []
    let firstDocumentId: string | undefined
    for (const attachment of documentAttachments) {
      const estimatedBytes = approxDecodedBytes(attachment.dataBase64)
      if (estimatedBytes > config.attachmentMaxBytes) {
        console.warn(
          `[Telegram] Skipping oversized document attachment ${attachment.id} (${estimatedBytes} bytes)`
        )
        continue
      }
      try {
        const filename = safeDocumentFilename(attachment.filename, `${attachment.id}.dat`)
        const buffer = Buffer.from(attachment.dataBase64, 'base64')
        const caption = attachment.caption || `${filename} (${buffer.byteLength} bytes)`
        const sent = await bot.api.sendDocument(channelId, new InputFile(buffer, filename), {
          caption: caption.slice(0, TELEGRAM_MAX_CAPTION_LENGTH),
          reply_to_message_id: replyId,
        })
        firstDocumentId ??= String(sent.message_id)
      } catch (err) {
        console.warn(`[Telegram] Failed to deliver document attachment ${attachment.id}:`, err)
      }
    }
    if (firstDocumentId) {
      console.log(
        `[Telegram] Sent reply to channel ${channelId} (${documentAttachments.length} document attachment(s))`
      )
      return textResults[0] ? String(textResults[0].message_id) : firstDocumentId
    }
    if (textResults[0]) {
      await bot.api.sendMessage(channelId, 'Generated document attachments could not be delivered.')
      return String(textResults[0].message_id)
    }
  }

  const contentToSend =
    content && content.trim()
      ? content
      : validAttachments.length > 0
        ? 'Generated image attachments could not be delivered.'
        : documentAttachments.length > 0
          ? 'Generated document attachments could not be delivered.'
          : content
  if (!contentToSend) return

  const chunks = splitMessage(contentToSend, TELEGRAM_MAX_LENGTH)
  const results = await Promise.all(
    chunks.map((chunk, index) =>
      bot.api.sendMessage(channelId, chunk, sendMessageOptions(replyId, options, index === 0))
    )
  )
  if (chunks.length > 1) {
    console.log(`[Telegram] Sent reply to channel ${channelId} (${chunks.length} parts)`)
  } else {
    console.log(`[Telegram] Sent reply to channel ${channelId}`)
  }
  return results[0] ? String(results[0].message_id) : undefined
}
