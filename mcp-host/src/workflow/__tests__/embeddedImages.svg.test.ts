/**
 * SVGs a model can name in a generator's arguments. Their drawing cost does not
 * follow their size, so costly features are refused up front and the rest is
 * drawn in a child process the host can kill, never on its event loop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as childProcess from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { logger } from '../../logger'
import { INTERNAL_TOOLS } from '../internalTools'

// The real spawn, watched, to read what the renderer process is given.
vi.mock('child_process', async original => {
  const actual = await original<typeof import('child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

const pdf = INTERNAL_TOOLS.find(t => t.name === 'clerum__generate_pdf')!
const markdown = INTERNAL_TOOLS.find(t => t.name === 'clerum__generate_markdown')!

const SVG = 'xmlns="http://www.w3.org/2000/svg"'
const NORMAL = `<svg ${SVG} width="400" height="200"><rect width="400" height="200" fill="#eef"/><circle cx="100" cy="100" r="60" fill="#36c"/></svg>`
// Blurs and morphs a region thirty times the image: about 20 s to draw.
const FILTERED = `<svg ${SVG} width="2048" height="2048"><defs><filter id="f" x="-10" y="-10" width="30" height="30"><feGaussianBlur stdDeviation="500"/><feMorphology radius="200"/><feGaussianBlur stdDeviation="800"/></filter></defs><rect width="2048" height="2048" filter="url(#f)"/></svg>`
const FILTER_PROPERTY = `<svg ${SVG} width="2048" height="2048"><rect width="2048" height="2048" style="filter: blur(400px)"/></svg>`
function useBomb(): string {
  let defs = ''
  for (let level = 0; level < 8; level++) {
    const content =
      level === 0
        ? '<rect width="2048" height="2048"/>'
        : Array.from({ length: 10 }, () => `<use href="#l${level - 1}"/>`).join('')
    defs += `<g id="l${level}">${content}</g>`
  }
  return `<svg ${SVG} width="2048" height="2048"><defs>${defs}</defs><use href="#l7"/></svg>`
}
// No refused feature and under the element budget, yet minutes of drawing.
function slowRects(): string {
  const rect =
    '<rect width="2048" height="2048" fill="none" stroke="#000" stroke-width="40" stroke-dasharray="1 1"/>'
  return `<svg ${SVG} width="2048" height="2048">${rect.repeat(4900)}</svg>`
}

let outputDir: string
beforeEach(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-svg-'))
})
afterEach(() => {
  fs.rmSync(outputDir, { recursive: true, force: true })
})

async function pdfWith(file: string, svg: string) {
  fs.writeFileSync(path.join(outputDir, file), svg)
  return pdf.execute({ filename: 'r.pdf', body: `Chart:\n\n![c](${file})` }, outputDir)
}

describe('SVG images', () => {
  it('draws a plain SVG into the document', async () => {
    const result = await pdfWith('plain.svg', NORMAL)
    expect(result.success, result.error).toBe(true)
    expect(result.content).not.toMatch(/left out/)
    const bytes = fs.readFileSync(path.join(outputDir, result.artifact!.name)).toString('latin1')
    expect(bytes).toMatch(/\/Subtype\s*\/Image/)
  })

  it.each([
    ['a filter element', FILTERED],
    ['a filter property', FILTER_PROPERTY],
    ['nested <use> elements', useBomb()],
  ])('refuses an SVG with %s at once, saying why', async (_, svg) => {
    const started = performance.now()
    const result = await pdfWith('costly.svg', svg)
    expect(performance.now() - started).toBeLessThan(2000)
    expect(result.success, result.error).toBe(true)
    expect(result.content).toMatch(/costly\.svg' uses SVG features this tool does not convert/)
  })

  it('reads no file a body names without an image extension', async () => {
    const note = await markdown.execute({ filename: 'notes.md', content: FILTERED }, outputDir)
    expect(note.success, note.error).toBe(true)
    const started = performance.now()
    const result = await pdf.execute(
      { filename: 'r.pdf', body: 'Notes:\n\n![c](notes.md)' },
      outputDir
    )
    expect(performance.now() - started).toBeLessThan(2000)
    expect(result.success, result.error).toBe(true)
    expect(result.content).toMatch(/'notes\.md' is not an image this tool can read/)
  })

  it('gives up on a slow drawing without stalling the event loop', async () => {
    let longestGap = 0
    let last = performance.now()
    const ticker = setInterval(() => {
      const now = performance.now()
      longestGap = Math.max(longestGap, now - last)
      last = now
    }, 20)
    const started = performance.now()
    try {
      const result = await pdfWith('slow.svg', slowRects())
      expect(result.success, result.error).toBe(true)
      expect(result.content).toMatch(/slow\.svg' took longer than 5 s to draw/)
    } finally {
      clearInterval(ticker)
    }
    expect(performance.now() - started).toBeLessThan(15000)
    expect(longestGap).toBeLessThan(1000)
  }, 30000)
})

describe('an SVG the renderer cannot draw', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('says it could not be drawn and why, and logs the reason, instead of blaming the time', async () => {
    const warn = vi.spyOn(logger, 'warn')
    const result = await pdfWith('broken.svg', `<svg ${SVG} width="40" height="20"><rect width=`)
    expect(result.success, result.error).toBe(true)
    expect(result.content).toMatch(/broken\.svg' could not be drawn/)
    expect(result.content).not.toMatch(/took longer/)
    const logged = warn.mock.calls.find(([, message]) => String(message).includes('SVG'))
    expect(logged?.[0]).toMatchObject({ component: 'EmbeddedImages', reason: 'exit', code: 1 })
  })

  it('says an SVG with no size has nothing to draw, not that it is too large', async () => {
    const result = await pdfWith(
      'zero.svg',
      `<svg ${SVG} width="0" height="10"><rect width="10" height="10"/></svg>`
    )
    expect(result.success, result.error).toBe(true)
    expect(result.content).toMatch(/zero\.svg' has no width or height to draw/)
    expect(result.content).not.toMatch(/more pixels/)
  })

  it('leaves the SVG out, without crashing the Host, when the renderer cannot start', async () => {
    const { EventEmitter } = await import('events')
    const spawn = vi.mocked(childProcess.spawn)
    // A spawn that runs out of file descriptors: no pipes, 'error' on the next tick.
    spawn.mockImplementationOnce((() => {
      const child = Object.assign(new EventEmitter(), {
        pid: undefined,
        stdout: null,
        stderr: null,
        stdin: null,
        kill: () => true,
      })
      process.nextTick(() =>
        child.emit('error', Object.assign(new Error('spawn EMFILE'), { code: 'EMFILE' }))
      )
      return child
    }) as never)
    const result = await pdfWith('plain.svg', NORMAL)
    expect(result.success, result.error).toBe(true)
    expect(result.content).toMatch(/plain\.svg' could not be drawn/)
  })

  it('gives the renderer no environment but a home directory', async () => {
    const spawn = vi.mocked(childProcess.spawn)
    spawn.mockClear()
    await pdfWith('plain.svg', NORMAL)
    const options = spawn.mock.calls.at(-1)?.[2] as { env?: Record<string, string> }
    expect(Object.keys(options.env ?? {})).toEqual(['HOME'])
    expect(options.env!.HOME).not.toBe('')
  })
})

describe('raster images a PDF would decode', () => {
  it('leaves an image over the pixel limit out of a PDF, saying so, and still embeds it in a DOCX', async () => {
    const { createCanvas } = await import('@napi-rs/canvas')
    // 16.4 million pixels in a small file: pdfkit would inflate all of them.
    fs.writeFileSync(
      path.join(outputDir, 'huge.png'),
      createCanvas(4100, 4000).toBuffer('image/png')
    )
    const result = await pdf.execute(
      { filename: 'r.pdf', body: 'Chart:\n\n![c](huge.png)' },
      outputDir
    )
    expect(result.success, result.error).toBe(true)
    expect(result.content).toMatch(/'huge\.png' is 4100 x 4000 pixels, more than the 16 million/)
    const bytes = fs.readFileSync(path.join(outputDir, result.artifact!.name)).toString('latin1')
    expect(bytes).not.toMatch(/\/Subtype\s*\/Image/)
    const docx = INTERNAL_TOOLS.find(t => t.name === 'clerum__generate_docx')!
    const doc = await docx.execute(
      { filename: 'r.docx', body: 'Chart:', images: ['huge.png'] },
      outputDir
    )
    expect(doc.success, doc.error).toBe(true)
    expect(doc.content ?? '').not.toMatch(/huge\.png/)
  }, 30000)
})
