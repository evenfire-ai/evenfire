/**
 * pptxgenjs `sizing: 'contain'` reads w/h as the image's own proportions and
 * stretches the picture to the box, so the deck sizes pictures itself. These
 * tests read the drawn size back out of the slide XML.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { withPngDensity } from './support/pngDensity'
import { generatePptx, pictures, slideXml, textShapes, writeImage } from './support/pptxXml'

let outputDir: string

beforeEach(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-pptx-img-'))
})

afterEach(() => {
  fs.rmSync(outputDir, { recursive: true, force: true })
})

const SLIDE = { width: 13.333, height: 7.5 }

function onlyPicture(file: string, slide = 1) {
  const pics = pictures(slideXml(file, slide))
  expect(pics).toHaveLength(1)
  return pics[0]
}

function expectInsideSlide(p: { x: number; y: number; w: number; h: number }) {
  expect(p.x).toBeGreaterThanOrEqual(0)
  expect(p.y).toBeGreaterThanOrEqual(0)
  expect(p.x + p.w).toBeLessThanOrEqual(SLIDE.width + 1e-3)
  expect(p.y + p.h).toBeLessThanOrEqual(SLIDE.height + 1e-3)
}

describe('clerum__generate_pptx — images keep their proportions', () => {
  it.each([
    ['a tall 1:2 picture', 600, 1200],
    ['a wide 2:1 picture', 1600, 800],
    ['a 4:3 photo', 800, 600],
  ])('draws %s at its own aspect ratio on an image slide', async (_label, w, h) => {
    await writeImage(outputDir, 'pic.png', w, h)
    const result = await generatePptx(
      {
        filename: 'x.pptx',
        slides: [{ layout: 'image', title: 'Picture', image: { path: 'pic.png' } }],
      },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    const pic = onlyPicture(path.join(outputDir, 'x.pptx'))
    expect(pic.w / pic.h).toBeCloseTo(w / h, 2)
    expect(pic.stretched).toBe(false)
    expectInsideSlide(pic)
  })

  it('derives the height from a width given alone', async () => {
    await writeImage(outputDir, 'tall.png', 600, 1200)
    const result = await generatePptx(
      {
        filename: 'x.pptx',
        slides: [{ layout: 'image', title: 'W', image: { path: 'tall.png', width: 2 } }],
      },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    const pic = onlyPicture(path.join(outputDir, 'x.pptx'))
    expect(pic.w).toBeCloseTo(2, 2)
    expect(pic.h).toBeCloseTo(4, 2)
  })

  it('fits the picture inside a width and height given together, at its own proportions', async () => {
    await writeImage(outputDir, 'wide.png', 1600, 800)
    const result = await generatePptx(
      {
        filename: 'x.pptx',
        slides: [
          { layout: 'image', title: 'WH', image: { path: 'wide.png', width: 2, height: 2 } },
        ],
      },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    const pic = onlyPicture(path.join(outputDir, 'x.pptx'))
    expect(pic.w).toBeCloseTo(2, 2)
    expect(pic.h).toBeCloseTo(1, 2)
    expect(pic.stretched).toBe(false)
  })

  it('keeps a chart image passed as chart.path at the chart aspect ratio', async () => {
    await writeImage(outputDir, 'sales.png', 1600, 800)
    const result = await generatePptx(
      {
        filename: 'x.pptx',
        slides: [{ layout: 'title-chart', title: 'Sales', chart: { path: 'sales.png' } }],
      },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    const pic = onlyPicture(path.join(outputDir, 'x.pptx'))
    expect(pic.w / pic.h).toBeCloseTo(2, 2)
    expect(pic.stretched).toBe(false)
  })

  it('keeps a JPEG in a two-column image column at its aspect ratio', async () => {
    await writeImage(outputDir, 'photo.jpg', 800, 600, 'jpeg')
    const result = await generatePptx(
      {
        filename: 'x.pptx',
        slides: [
          {
            layout: 'two-column',
            title: 'Photo',
            columns: {
              left: { type: 'bullets', bullets: ['One'] },
              right: { type: 'image', image: { path: 'photo.jpg' } },
            },
          },
        ],
      },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    const pic = onlyPicture(path.join(outputDir, 'x.pptx'))
    expect(pic.w / pic.h).toBeCloseTo(4 / 3, 2)
  })

  it('does not squash a square logo on the cover', async () => {
    await writeImage(outputDir, 'logo.png', 400, 400)
    const result = await generatePptx(
      {
        filename: 'x.pptx',
        branding: { logoPath: 'logo.png' },
        slides: [{ layout: 'cover', title: 'Deck' }],
      },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    const pic = onlyPicture(path.join(outputDir, 'x.pptx'))
    expect(pic.w / pic.h).toBeCloseTo(1, 2)
  })

  it('embeds a GIF by converting it, instead of writing it under a PNG name', async () => {
    await writeImage(outputDir, 'anim.gif', 60, 30, 'gif')
    const result = await generatePptx(
      {
        filename: 'x.pptx',
        slides: [{ layout: 'image', title: 'GIF', image: 'anim.gif' }],
      },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    const pic = onlyPicture(path.join(outputDir, 'x.pptx'))
    expect(pic.w / pic.h).toBeCloseTo(2, 2)
  })
})

describe('clerum__generate_pptx — small images are not blown up', () => {
  it('draws a tiny image at twice its size at most, and says how to enlarge it', async () => {
    await writeImage(outputDir, 'tiny.png', 40, 30)
    const result = await generatePptx(
      { filename: 't.pptx', slides: [{ layout: 'image', title: 'Icon', image: 'tiny.png' }] },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    const pic = onlyPicture(path.join(outputDir, 't.pptx'))
    expect(pic.w).toBeCloseTo((40 / 96) * 2, 2)
    expect(pic.h).toBeCloseTo((30 / 96) * 2, 2)
    expect(result.content).toMatch(/slides\[0\]\.image: the image is 40×30 pixels/)
    expect(result.content).toMatch(/set width/)
  })

  it('judges a dense image by the pixels it stores, not the density it declares', async () => {
    const file = await writeImage(outputDir, 'dense.png', 40, 30)
    // 192 dpi: the image declares half its pixel size.
    fs.writeFileSync(file, withPngDensity(fs.readFileSync(file), 7559))
    const result = await generatePptx(
      { filename: 'd.pptx', slides: [{ layout: 'image', title: 'Icon', image: 'dense.png' }] },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    expect(onlyPicture(path.join(outputDir, 'd.pptx')).w).toBeCloseTo((40 / 96) * 2, 2)
    expect(result.content).toMatch(/the image is 40×30 pixels/)
  })

  it('still enlarges a tiny image to the width asked for', async () => {
    await writeImage(outputDir, 'tiny.png', 40, 30)
    const result = await generatePptx(
      {
        filename: 't.pptx',
        slides: [{ layout: 'image', title: 'Icon', image: { path: 'tiny.png', width: 4 } }],
      },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    expect(onlyPicture(path.join(outputDir, 't.pptx')).w).toBeCloseTo(4, 2)
    expect(result.content).not.toMatch(/pixels/)
  })

  it('fills the space with an image large enough to stay sharp, without a warning', async () => {
    await writeImage(outputDir, 'big.png', 1200, 900)
    const result = await generatePptx(
      { filename: 'b.pptx', slides: [{ layout: 'image', title: 'Photo', image: 'big.png' }] },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    expect(onlyPicture(path.join(outputDir, 'b.pptx')).h).toBeGreaterThan(5)
    expect(result.content).not.toMatch(/pixels/)
  })
})

describe('clerum__generate_pptx — images that cannot be used are reported', () => {
  it('says which image was left out instead of returning a silent empty slide', async () => {
    const result = await generatePptx(
      {
        filename: 'x.pptx',
        slides: [
          { layout: 'image', title: 'Missing', image: { path: 'nope.png', caption: 'Cap' } },
        ],
      },
      outputDir
    )
    expect(result.success).toBe(true)
    expect(result.content).toMatch(/nope\.png/)
    expect(result.content).toMatch(/slides\[0\]/)
  })

  it('mentions the caption that goes with an image that cannot be used', async () => {
    const result = await generatePptx(
      {
        filename: 'x.pptx',
        slides: [
          {
            layout: 'two-column',
            title: 'Missing',
            columns: {
              left: { type: 'bullets', bullets: ['One'] },
              right: { type: 'image', image: { path: 'nope.png', caption: 'Quarterly photo' } },
            },
          },
        ],
      },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    expect(result.content).toMatch(/slides\[0\]\.columns\.right\.image\.caption/)
  })

  it('uses the file of the same name when given an absolute path from another mode', async () => {
    await writeImage(outputDir, 'sales.png', 1600, 800)
    const result = await generatePptx(
      {
        filename: 'x.pptx',
        slides: [{ layout: 'image', title: 'Chart', image: { path: '/output/sales.png' } }],
      },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    expect(result.content).toMatch(/sales\.png/)
    expect(pictures(slideXml(path.join(outputDir, 'x.pptx'), 1))).toHaveLength(1)
  })

  it('draws the native chart when the chart image is missing but the data came too', async () => {
    const result = await generatePptx(
      {
        filename: 'x.pptx',
        slides: [
          {
            layout: 'title-chart',
            title: 'Revenue',
            chart: {
              path: 'missing.png',
              type: 'bar',
              labels: ['A', 'B'],
              datasets: [{ label: 'S', data: [1, 2] }],
            },
          },
        ],
      },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    expect(slideXml(path.join(outputDir, 'x.pptx'), 1)).toContain('<c:chart ')
    expect(result.content).toMatch(/missing\.png/)
  })

  it('fails the call for a path that escapes the output folder, naming the field', async () => {
    const result = await generatePptx(
      {
        filename: 'x.pptx',
        branding: { logoPath: '../../../etc/passwd' },
        slides: [{ layout: 'cover', title: 'X' }],
      },
      outputDir
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/path traversal blocked/)
    expect(result.error).toMatch(/branding\.logoPath/)
  })

  it('keeps the caption of an image slide inside the slide, below the picture', async () => {
    await writeImage(outputDir, 'tall.png', 600, 1200)
    const result = await generatePptx(
      {
        filename: 'x.pptx',
        slides: [
          { layout: 'image', title: 'T', image: { path: 'tall.png', caption: 'A caption' } },
        ],
      },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    const xml = slideXml(path.join(outputDir, 'x.pptx'), 1)
    const pic = pictures(xml)[0]
    const caption = textShapes(xml).find(s => s.paragraphs[0] === 'A caption')!
    expect(caption.y).toBeGreaterThanOrEqual(pic.y + pic.h - 1e-3)
  })
})
