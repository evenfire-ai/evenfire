import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { fitImageSize, loadEmbeddableImage, predecodeImages } from '../embeddedImages'

let outputDir: string

beforeEach(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-embed-'))
})

afterEach(() => {
  fs.rmSync(outputDir, { recursive: true, force: true })
})

async function writeImage(name: string, format: 'png' | 'jpeg' | 'webp', w = 40, h = 20) {
  const canvas = createCanvas(w, h)
  canvas.getContext('2d').fillRect(0, 0, w, h)
  const data = format === 'png' ? canvas.toBuffer('image/png') : await canvas.encode(format)
  fs.writeFileSync(path.join(outputDir, name), data)
}

/** A JPEG with an APP1 Exif segment carrying only the orientation tag. */
function withExifOrientation(jpeg: Buffer, orientation: number): Buffer {
  const tiff = Buffer.from([
    0x4d,
    0x4d,
    0x00,
    0x2a,
    0x00,
    0x00,
    0x00,
    0x08,
    0x00,
    0x01,
    0x01,
    0x12,
    0x00,
    0x03,
    0x00,
    0x00,
    0x00,
    0x01,
    0x00,
    orientation,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
  ])
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])
  const header = Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff])
  return Buffer.concat([jpeg.subarray(0, 2), header, body, jpeg.subarray(2)])
}

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

describe('fitImageSize', () => {
  const box = { width: 500, height: 300 }

  it('keeps proportions and never exceeds the box, even for an explicit size', () => {
    expect(fitImageSize({ width: 1000, height: 500 }, box)).toEqual({ width: 500, height: 250 })
    expect(fitImageSize({ width: 1000, height: 500 }, box, { width: 2000 })).toEqual({
      width: 500,
      height: 250,
    })
    expect(fitImageSize({ width: 100, height: 100 }, box, { height: 900 })).toEqual({
      width: 300,
      height: 300,
    })
  })

  it('reads a width and height given together as a box to fit in', () => {
    expect(fitImageSize({ width: 100, height: 100 }, box, { width: 200, height: 100 })).toEqual({
      width: 100,
      height: 100,
    })
    expect(fitImageSize({ width: 200, height: 100 }, box, { width: 400, height: 400 })).toEqual({
      width: 400,
      height: 200,
    })
    expect(fitImageSize({ width: 100, height: 100 }, box, { width: 1000, height: 1000 })).toEqual({
      width: 300,
      height: 300,
    })
  })
})

describe('loadEmbeddableImage', () => {
  it('accepts a bare filename or an object with path', async () => {
    await writeImage('a.png', 'png')
    const warnings: string[] = []
    expect(loadEmbeddableImage('a.png', outputDir, warnings)).toMatchObject({
      format: 'png',
      width: 40,
      height: 20,
    })
    expect(loadEmbeddableImage({ path: 'a.png' }, outputDir, warnings)?.format).toBe('png')
    expect(warnings).toEqual([])
  })

  it('reads the format from the bytes and converts decoded images to opaque PNG', async () => {
    await writeImage('photo.png', 'jpeg')
    await writeImage('anim.webp', 'webp')
    fs.writeFileSync(
      path.join(outputDir, 'logo.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="10"><rect width="30" height="10"/></svg>'
    )
    await predecodeImages({ images: ['anim.webp', { path: 'logo.svg' }] }, outputDir)
    const warnings: string[] = []
    expect(loadEmbeddableImage('photo.png', outputDir, warnings)?.format).toBe('jpeg')
    const webp = loadEmbeddableImage('anim.webp', outputDir, warnings)
    expect(webp?.format).toBe('png')
    expect(await opaquePixels(webp!.data)).toBe(40 * 20)
    const svg = loadEmbeddableImage('logo.svg', outputDir, warnings)
    expect(svg).toMatchObject({ format: 'png', width: 30, height: 10 })
    expect(await opaquePixels(svg!.data)).toBe(30 * 10)
    expect(warnings).toEqual([])
  })

  it('finds images named inside markdown bodies', async () => {
    await writeImage('inline.webp', 'webp')
    await predecodeImages({ body: 'Intro\n\n![sales](inline.webp)\n' }, outputDir)
    const image = loadEmbeddableImage('inline.webp', outputDir, [])
    expect(await opaquePixels(image!.data)).toBe(40 * 20)
  })

  it('finds a body image whose name holds spaces, in each form markdown writes it', async () => {
    await writeImage('my chart.webp', 'webp')
    await writeImage('image (1).webp', 'webp')
    await predecodeImages(
      { body: '![a](<my chart.webp>)\n\n![b](image (1).webp "Title")' },
      outputDir
    )
    expect(loadEmbeddableImage('my chart.webp', outputDir, [])).toBeDefined()
    expect(loadEmbeddableImage('image (1).webp', outputDir, [])).toBeDefined()
  })

  it('scans a body of unclosed image openings in linear time', async () => {
    const started = performance.now()
    await predecodeImages({ body: '!['.repeat(100000) }, outputDir)
    expect(performance.now() - started).toBeLessThan(5000)
  })

  it('reports an image it was not able to decode instead of drawing it blank', async () => {
    await writeImage('late.webp', 'webp')
    const warnings: string[] = []
    expect(loadEmbeddableImage('late.webp', outputDir, warnings)).toBeUndefined()
    expect(warnings).toEqual(["'late.webp' is not an image this tool can read and was left out."])
  })

  it('rasterizes a huge SVG at a bounded size instead of its declared one', async () => {
    // The canvas library aborts the process when it cannot allocate the bitmap.
    fs.writeFileSync(
      path.join(outputDir, 'huge.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="32000" height="16000"><rect width="32000" height="16000"/></svg>'
    )
    fs.writeFileSync(
      path.join(outputDir, 'inches.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="1000in" height="1000in" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'
    )
    await predecodeImages(['huge.svg', 'inches.svg'], outputDir)
    expect(loadEmbeddableImage('huge.svg', outputDir, [])).toMatchObject({
      width: 2048,
      height: 1024,
    })
    expect(loadEmbeddableImage('inches.svg', outputDir, [])).toMatchObject({
      width: 2048,
      height: 2048,
    })
  })

  it('bounds an SVG size written with an exponent and refuses one it cannot read', async () => {
    const svg = (attrs: string) =>
      `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}><rect width="10" height="10"/></svg>`
    fs.writeFileSync(path.join(outputDir, 'exp.svg'), svg('width="1e9" height="5e8"'))
    fs.writeFileSync(path.join(outputDir, 'calc.svg'), svg('width="calc(1e9px)" height="10"'))
    fs.writeFileSync(
      path.join(outputDir, 'pct.svg'),
      svg('width="100%" height="100%" viewBox="0 0 50 40"')
    )
    await predecodeImages(['exp.svg', 'calc.svg', 'pct.svg'], outputDir)
    expect(loadEmbeddableImage('exp.svg', outputDir, [])).toMatchObject({
      width: 2048,
      height: 1024,
    })
    const warnings: string[] = []
    expect(loadEmbeddableImage('calc.svg', outputDir, warnings)).toBeUndefined()
    expect(warnings[0]).toMatch(/calc\.svg' is not an image this tool can read/)
    expect(loadEmbeddableImage('pct.svg', outputDir, [])).toMatchObject({ width: 50, height: 40 })
  })

  it('does not decode an image whose header declares an enormous size', async () => {
    const gif = Buffer.from(
      'R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==',
      'base64'
    )
    gif.writeUInt16LE(60000, 6)
    gif.writeUInt16LE(60000, 8)
    fs.writeFileSync(path.join(outputDir, 'huge.gif'), gif)
    await predecodeImages(['huge.gif'], outputDir)
    expect(loadEmbeddableImage('huge.gif', outputDir, [])).toBeUndefined()
  })

  it('leaves out, with a warning, what is missing or not an image', () => {
    fs.writeFileSync(path.join(outputDir, 'notes.png'), 'plain text')
    const warnings: string[] = []
    expect(loadEmbeddableImage('missing.png', outputDir, warnings)).toBeUndefined()
    expect(loadEmbeddableImage('notes.png', outputDir, warnings)).toBeUndefined()
    expect(loadEmbeddableImage({ width: 100 }, outputDir, warnings, 'images[2]')).toBeUndefined()
    expect(warnings).toEqual([
      "Image 'missing.png' was not found in the output folder and was left out.",
      "'notes.png' is not an image this tool can read and was left out.",
      'images[2] needs a file name, such as the one clerum__generate_chart returns; it was left out.',
    ])
  })

  it('uses the file of the same name when given an absolute path from elsewhere', async () => {
    await writeImage('chart.png', 'png')
    const warnings: string[] = []
    const image = loadEmbeddableImage('/output/chart.png', outputDir, warnings)
    expect(image?.path).toBe(path.join(path.resolve(outputDir), 'chart.png'))
    expect(warnings[0]).toContain("'/output/chart.png' is outside the output folder")
  })

  it('refuses a link inside the output folder that points outside it', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-outside-'))
    try {
      const canvas = createCanvas(4, 4)
      canvas.getContext('2d').fillRect(0, 0, 4, 4)
      fs.writeFileSync(path.join(outside, 'secret.png'), canvas.toBuffer('image/png'))
      fs.symlinkSync(path.join(outside, 'secret.png'), path.join(outputDir, 'innocent.png'))
      expect(() => loadEmbeddableImage('innocent.png', outputDir, [])).toThrow(
        /path traversal blocked/
      )
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('says a web address is not downloaded', () => {
    const warnings: string[] = []
    expect(
      loadEmbeddableImage('https://example.com/chart.png', outputDir, warnings, 'images[0]')
    ).toBeUndefined()
    expect(warnings[0]).toContain('is a web address or inline data, and images are not downloaded')
  })

  it('turns a photo tagged with an EXIF rotation upright for every format', async () => {
    // 40x20 with the left quarter blue, tagged "rotate 90° clockwise".
    const canvas = createCanvas(40, 20)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ff0000'
    ctx.fillRect(0, 0, 40, 20)
    ctx.fillStyle = '#0000ff'
    ctx.fillRect(0, 0, 10, 20)
    fs.writeFileSync(
      path.join(outputDir, 'photo.jpg'),
      withExifOrientation(canvas.toBuffer('image/jpeg'), 6)
    )
    await predecodeImages(['photo.jpg'], outputDir)
    const image = loadEmbeddableImage('photo.jpg', outputDir, [])!
    expect(image).toMatchObject({ format: 'jpeg', width: 20, height: 40 })
    const decoded = await loadImage(image.data)
    const probe = createCanvas(decoded.width, decoded.height)
    probe.getContext('2d').drawImage(decoded, 0, 0)
    const [r, , b] = probe.getContext('2d').getImageData(10, 2, 1, 1).data
    expect(b).toBeGreaterThan(200)
    expect(r).toBeLessThan(60)
  })

  it('still refuses to leave the output folder', () => {
    expect(() => loadEmbeddableImage('../../etc/passwd', outputDir, [])).toThrow(
      /path traversal blocked/
    )
    expect(() => loadEmbeddableImage('/etc/passwd', outputDir, [])).toThrow(
      /path traversal blocked/
    )
  })
})
