/**
 * One image paragraph of a DOCX: fitted to its box, with its drawing id, or
 * left out with a warning that names the argument.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { Document, Packer } from 'docx'
import * as fs from 'fs'
import JSZip from 'jszip'
import * as os from 'os'
import * as path from 'path'
import { docxImageParagraph } from '../docxImages'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-docx-image-'))
  fs.writeFileSync(path.join(dir, 'wide.png'), createCanvas(800, 200).toBuffer('image/png'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

async function documentXml(paragraph: NonNullable<ReturnType<typeof docxImageParagraph>>) {
  const buffer = await Packer.toBuffer(new Document({ sections: [{ children: [paragraph] }] }))
  return (await JSZip.loadAsync(buffer)).file('word/document.xml')!.async('string')
}

describe('docxImageParagraph', () => {
  it('fits the image to its box, keeping its proportions, under the id it is given', async () => {
    const warnings: string[] = []
    const box = { width: 400, height: 400 }
    const paragraph = docxImageParagraph(
      'wide.png',
      dir,
      box,
      { altText: 'Sales' },
      warnings,
      'images[0]',
      7
    )
    expect(paragraph).toBeDefined()
    const xml = await documentXml(paragraph!)
    const extent = /<wp:extent cx="(\d+)" cy="(\d+)"/.exec(xml)!
    // 400 x 100 pixels, in EMU.
    expect([Number(extent[1]), Number(extent[2])]).toEqual([400 * 9525, 100 * 9525])
    expect(xml).toMatch(/<wp:docPr id="7" name="wide.png" descr="Sales"/)
    expect(warnings).toEqual([])
  })

  it('leaves out a missing image with a warning that names the argument', () => {
    const warnings: string[] = []
    const box = { width: 400, height: 400 }
    expect(docxImageParagraph('nope.png', dir, box, {}, warnings, 'images[1]', 1)).toBeUndefined()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/^images\[1\]: /)
  })

  it('fails on a path out of the output folder, saying how to name the file', () => {
    const box = { width: 400, height: 400 }
    expect(() => docxImageParagraph('../x.png', dir, box, {}, [], 'images[2]', 1)).toThrow(
      /images\[2\]: .*Pass the file name in the output folder/
    )
  })
})
