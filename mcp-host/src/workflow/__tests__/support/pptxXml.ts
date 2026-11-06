/**
 * Read the parts of a generated .pptx that the PPTX tests assert on. Geometry
 * is returned in inches so tests compare against slide dimensions directly.
 */
import { createCanvas } from '@napi-rs/canvas'
import * as fs from 'fs'
import * as path from 'path'
import { INTERNAL_TOOLS } from '../../internalTools'
import type { InternalToolResult } from '../../types'
import { zipEntries, zipEntryText } from './zipEntries'

export const EMU_PER_INCH = 914400

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export async function generatePptx(
  args: Record<string, unknown>,
  outputDir: string
): Promise<InternalToolResult> {
  const tool = INTERNAL_TOOLS.find(t => t.name === 'clerum__generate_pptx')
  if (!tool) throw new Error('clerum__generate_pptx is not registered')
  return tool.execute(args, outputDir)
}

export function slideCount(file: string): number {
  return [...zipEntries(file).keys()].filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length
}

export function slideXml(file: string, n: number): string {
  return zipEntryText(file, `ppt/slides/slide${n}.xml`)
}

function boxOf(xml: string): Box {
  const off = /<a:off x="(-?\d+)" y="(-?\d+)"\/>/.exec(xml)
  const ext = /<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(xml)
  if (!off || !ext) throw new Error('shape without a transform')
  return {
    x: Number(off[1]) / EMU_PER_INCH,
    y: Number(off[2]) / EMU_PER_INCH,
    w: Number(ext[1]) / EMU_PER_INCH,
    h: Number(ext[2]) / EMU_PER_INCH,
  }
}

/** Every picture on a slide, with whether pptxgenjs asked PowerPoint to stretch it. */
export function pictures(xml: string): Array<Box & { stretched: boolean; cropped: boolean }> {
  return [...xml.matchAll(/<p:pic>[\s\S]*?<\/p:pic>/g)].map(m => ({
    ...boxOf(m[0]),
    stretched: /<a:srcRect l="0" r="0" t="0" b="0"\/>/.test(m[0]),
    cropped: /<a:srcRect l="[1-9]|<a:srcRect [^>]*[trb]="[1-9]/.test(m[0]),
  }))
}

export interface TextShape extends Box {
  paragraphs: string[]
  sizes: number[]
  anchor?: string
  xml: string
}

/** Text boxes (not table cells) in document order. */
export function textShapes(xml: string): TextShape[] {
  return [...xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)]
    .filter(m => m[0].includes('<p:txBody>'))
    .map(m => {
      const body = m[0]
      // A soft line break inside a paragraph reads as a newline.
      const paragraphs = [...body.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)]
        .map(p =>
          [...p[1].matchAll(/<a:br\/>|<a:t>([\s\S]*?)<\/a:t>/g)]
            .map(t => (t[1] === undefined ? '\n' : decode(t[1])))
            .join('')
        )
        .filter(p => p.length > 0)
      const sizes = [...body.matchAll(/<a:rPr[^>]* sz="(\d+)"/g)].map(s => Number(s[1]) / 100)
      const anchor = /<a:bodyPr[^>]* anchor="(\w+)"/.exec(body)?.[1]
      return { ...boxOf(body), paragraphs, sizes, anchor, xml: body }
    })
    .filter(s => s.paragraphs.length > 0)
}

/** The shape whose text starts with `prefix`. */
export function shapeWithText(xml: string, prefix: string): TextShape {
  const hit = textShapes(xml).find(s => s.paragraphs.join('\n').startsWith(prefix))
  if (!hit) throw new Error(`no text shape starting with ${JSON.stringify(prefix)}`)
  return hit
}

export interface TableInfo extends Box {
  columnWidths: number[]
  rowHeights: number[]
  rows: string[][]
}

export function tables(xml: string): TableInfo[] {
  return [...xml.matchAll(/<p:graphicFrame>[\s\S]*?<\/p:graphicFrame>/g)]
    .filter(m => m[0].includes('<a:tbl>'))
    .map(m => {
      const frame = m[0]
      const columnWidths = [...frame.matchAll(/<a:gridCol w="(\d+)"/g)].map(
        c => Number(c[1]) / EMU_PER_INCH
      )
      const rowMatches = [...frame.matchAll(/<a:tr h="(\d+)">([\s\S]*?)<\/a:tr>/g)]
      return {
        ...boxOf(frame.replace(/<p:xfrm>/, '')),
        columnWidths,
        rowHeights: rowMatches.map(r => Number(r[1]) / EMU_PER_INCH),
        rows: rowMatches.map(r =>
          [...r[2].matchAll(/<a:tc[^>]*>([\s\S]*?)<\/a:tc>/g)].map(c =>
            [...c[1].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(t => decode(t[1])).join('')
          )
        ),
      }
    })
}

/** Chart parts in the archive, in the order pptxgenjs numbered them. */
export function chartXmls(file: string): string[] {
  const entries = zipEntries(file)
  return [...entries.keys()]
    .filter(n => /^ppt\/charts\/chart\d+\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]))
    .map(n => entries.get(n)!.toString('utf8'))
}

/** Numeric cache values of every series in a chart part. */
export function chartValues(chartXml: string): string[][] {
  return [...chartXml.matchAll(/<c:val>([\s\S]*?)<\/c:val>/g)].map(v =>
    [...v[1].matchAll(/<c:v>([^<]*)<\/c:v>/g)].map(x => x[1])
  )
}

export function chartCategories(chartXml: string): string[] {
  const cat = /<c:cat>([\s\S]*?)<\/c:cat>/.exec(chartXml)
  return cat ? [...cat[1].matchAll(/<c:v>([^<]*)<\/c:v>/g)].map(x => decode(x[1])) : []
}

function decode(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** An image of the given pixel size with a filled circle, so distortion is visible when rendered. */
export async function writeImage(
  dir: string,
  name: string,
  width: number,
  height: number,
  format: 'png' | 'jpeg' | 'gif' = 'png'
): Promise<string> {
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = '#1d4ed8'
  ctx.beginPath()
  ctx.arc(width / 2, height / 2, Math.min(width, height) / 2 - 2, 0, Math.PI * 2)
  ctx.fill()
  const data =
    format === 'png'
      ? canvas.toBuffer('image/png')
      : format === 'jpeg'
        ? canvas.toBuffer('image/jpeg')
        : gifOf(width, height)
  const file = path.join(dir, name)
  fs.writeFileSync(file, data)
  return file
}

/** A minimal single-colour GIF; the canvas library can read GIF but not write it. */
function gifOf(width: number, height: number): Buffer {
  const header = Buffer.from('GIF89a', 'latin1')
  const screen = Buffer.alloc(7)
  screen.writeUInt16LE(width, 0)
  screen.writeUInt16LE(height, 2)
  screen[4] = 0x80
  const palette = Buffer.from([0x1d, 0x4e, 0xd8, 0xff, 0xff, 0xff])
  const descriptor = Buffer.alloc(10)
  descriptor[0] = 0x2c
  descriptor.writeUInt16LE(width, 5)
  descriptor.writeUInt16LE(height, 7)
  // LZW with a clear code before every pixel keeps the code size fixed at 3 bits.
  const codes: number[] = []
  for (let i = 0; i < width * height; i++) codes.push(4, 0)
  codes.push(5)
  const bytes: number[] = []
  let acc = 0
  let bits = 0
  for (const code of codes) {
    acc |= code << bits
    bits += 3
    while (bits >= 8) {
      bytes.push(acc & 0xff)
      acc >>= 8
      bits -= 8
    }
  }
  if (bits > 0) bytes.push(acc & 0xff)
  const blocks: number[] = [2]
  for (let i = 0; i < bytes.length; i += 255) {
    const chunk = bytes.slice(i, i + 255)
    blocks.push(chunk.length, ...chunk)
  }
  blocks.push(0, 0x3b)
  return Buffer.concat([header, screen, palette, descriptor, Buffer.from(blocks)])
}
