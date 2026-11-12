/**
 * GIF and WebP images are decoded asynchronously by the canvas library, and
 * each generator embeds images synchronously. These tests read the pixels of
 * what actually lands in the file, since a blank image has the right size.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { INTERNAL_TOOLS } from '../internalTools'
import { zipEntries } from './support/zipEntries'

/** One opaque red pixel, without a transparency extension. */
const RED_GIF = Buffer.from(
  'R0lGODlhAQABAPAAAP8AAP///yH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==',
  'base64'
)

let outputDir: string

beforeEach(async () => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-formats-'))
  fs.writeFileSync(path.join(outputDir, 'red.gif'), RED_GIF)
  const canvas = createCanvas(40, 20)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#1f6c9f'
  ctx.fillRect(0, 0, 40, 20)
  fs.writeFileSync(path.join(outputDir, 'blue.webp'), await canvas.encode('webp'))
})

afterEach(() => {
  fs.rmSync(outputDir, { recursive: true, force: true })
})

async function opaquePixels(png: Buffer): Promise<number> {
  const image = await loadImage(png)
  const canvas = createCanvas(image.width, image.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(image, 0, 0)
  const data = ctx.getImageData(0, 0, image.width, image.height).data
  let count = 0
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) count++
  return count
}

async function mediaPixels(tool: string, args: Record<string, unknown>): Promise<number[]> {
  const result = await INTERNAL_TOOLS.find(t => t.name === tool)!.execute(args, outputDir)
  expect(result.success, result.error).toBe(true)
  const media = [...zipEntries(result.artifact!.path)].filter(([name]) =>
    /\/media\/[^/]+\.\w+$/.test(name)
  )
  return Promise.all(media.map(([, data]) => opaquePixels(data)))
}

describe('GIF and WebP images keep their pixels', () => {
  it('in a DOCX', async () => {
    const pixels = await mediaPixels('clerum__generate_docx', {
      filename: 'd.docx',
      body: 'Report',
      images: ['red.gif', 'blue.webp'],
    })
    expect(pixels.sort((a, b) => a - b)).toEqual([1, 800])
  })

  it('in an XLSX', async () => {
    const pixels = await mediaPixels('clerum__generate_xlsx', {
      filename: 'x.xlsx',
      sheets: [{ name: 'S', rows: [['a'], [1]], images: ['red.gif', 'blue.webp'] }],
    })
    expect(pixels.sort((a, b) => a - b)).toEqual([1, 800])
  })

  it('in a PPTX', async () => {
    const pixels = await mediaPixels('clerum__generate_pptx', {
      filename: 'p.pptx',
      slides: [
        { layout: 'image', title: 'GIF', image: { path: 'red.gif' } },
        { layout: 'image', title: 'WebP', image: { path: 'blue.webp' } },
      ],
    })
    expect(pixels.filter(n => n > 0).sort((a, b) => a - b)).toEqual([1, 800])
  })
})
