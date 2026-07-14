import * as fs from 'fs/promises'
import { Attachment } from '../../types'

export async function createScreenshotAttachment(
  filePath: string,
  sourceTool: string,
  caption?: string
): Promise<Attachment> {
  const buffer = await fs.readFile(filePath)
  return {
    id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    kind: 'image',
    mimeType: 'image/png',
    encoding: 'base64',
    dataBase64: buffer.toString('base64'),
    sourceTool,
    caption,
  }
}

export function createScreenshotAttachmentFromBuffer(
  buffer: Buffer,
  sourceTool: string,
  caption?: string
): Attachment {
  return {
    id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    kind: 'image',
    mimeType: 'image/png',
    encoding: 'base64',
    dataBase64: buffer.toString('base64'),
    sourceTool,
    caption,
  }
}
