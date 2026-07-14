import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import { createScreenshotAttachment } from './screenshotUtil'

vi.mock('fs/promises')

describe('screenshotUtil', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reads a PNG file and returns an Attachment', async () => {
    const fakePng = Buffer.from('fake-png-data')
    vi.mocked(fs.readFile).mockResolvedValue(fakePng)

    const att = await createScreenshotAttachment('/tmp/screenshot.png', 'desktop_screenshot')

    expect(att.kind).toBe('image')
    expect(att.mimeType).toBe('image/png')
    expect(att.encoding).toBe('base64')
    expect(att.dataBase64).toBe(fakePng.toString('base64'))
    expect(att.sourceTool).toBe('desktop_screenshot')
  })

  it('generates a unique id', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(Buffer.from('data'))

    const att1 = await createScreenshotAttachment('/tmp/a.png', 'test')
    const att2 = await createScreenshotAttachment('/tmp/b.png', 'test')

    expect(att1.id).not.toBe(att2.id)
  })
})
