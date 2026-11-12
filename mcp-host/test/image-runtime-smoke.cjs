'use strict'

// Run from the built mcp-host package directory, or stream into the final image.
// This checks shipped dist/native bindings; the TypeScript suite owns source-level
// transport faults, keep-alive and cancellation coverage.
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { inspect } = require('node:util')
const { gzipSync } = require('node:zlib')
const Database = require('better-sqlite3')
const { createCanvas, loadImage } = require('@napi-rs/canvas')
const { resolve } = require('node:path')
const { OpenAICompatibleProvider } = require(resolve('dist/llm/openaiCompatible.js'))
const db = new Database(':memory:')
assert.equal(db.prepare('SELECT 42 AS value').get().value, 42)
db.close()
const canvas = createCanvas(10, 10)
canvas.getContext('2d').fillRect(0, 0, 10, 10)
assert.ok(canvas.toBuffer('image/png').length > 0)

/** A one-page PDF with one line of standard-font text, built by hand. */
function minimalPdf(text) {
  const content = `BT /F1 24 Tf 20 40 Td (${text}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 100] ' +
      '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = objects.map((body, index) => {
    const offset = pdf.length
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`
    return offset
  })
  const xref = pdf.length
  pdf +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new Uint8Array(Buffer.from(pdf, 'latin1'))
}

/** Dark pixels of a rendered page on its white background. */
async function inkPixels(png) {
  const image = await loadImage(Buffer.from(png))
  const canvas = createCanvas(image.width, image.height)
  const context = canvas.getContext('2d')
  context.drawImage(image, 0, 0)
  const { data } = context.getImageData(0, 0, image.width, image.height)
  let ink = 0
  for (let offset = 0; offset < data.length; offset += 4) {
    if (data[offset] < 128 && data[offset + 1] < 128 && data[offset + 2] < 128) ink += 1
  }
  return { ink, pixels: image.width * image.height }
}

// The document reader's shipped modules, in two parts:
// - In process: pdfjs-dist text extraction, and a page render through the
//   image's canvas binding and the standard font data pdfjs-dist ships.
// - As a child: one pdf_text job through the dist runner. It spawns dist
//   worker.js as a real child with the empty environment (`env: {}`) the
//   runner gives it, sends the job and reads the outcome over IPC. On Linux
//   the spawn goes through `/bin/sh -c 'ulimit -d … && exec'`, so the image's
//   shell, the RLIMIT_DATA premise, the calibrated reserve for this
//   architecture and the cgroup v2 controller must all be usable; macOS spawns
//   node directly.
// The child proves the spawn chain, `env: {}` and IPC from dist. It does not
// prove memory-headroom admission: CI runs this smoke with no `--memory`, so
// the cgroup has no limit and the reader starts with its configured caps.
// Headroom refusals and the cgroup kill path are covered by the TypeScript
// suite (workerMemoryQueue.test.ts).
async function documentReaderSmoke() {
  const { DEFAULT_DOCUMENT_READ_LIMITS } = require(resolve('dist/core/tools/documentRead/types.js'))
  const { parsePdfText } = require(resolve('dist/core/tools/documentRead/pdfText.js'))
  const { renderPdfPages } = require(resolve('dist/core/tools/documentRead/pdfRender.js'))
  const bytes = minimalPdf('SMOKE-DOCUMENT-READ')
  const textJob = {
    kind: 'pdf_text',
    bytes: bytes.slice(),
    pages: null,
    start: { page: 1, charOffset: 0 },
    limits: DEFAULT_DOCUMENT_READ_LIMITS,
  }
  const text = await parsePdfText(textJob)
  assert.equal(text.ok, true, JSON.stringify(text))
  assert.match(text.pages[0].text, /SMOKE-DOCUMENT-READ/)
  const visual = await renderPdfPages({
    kind: 'pdf_visual',
    bytes: bytes.slice(),
    pages: null,
    start: null,
    maxDimension: 1_024,
    maxPixelsPerCall: 4_000_000,
    maxImageBytes: 5_000_000,
    maxTotalImageBytes: 5_000_000,
    limits: DEFAULT_DOCUMENT_READ_LIMITS,
  })
  assert.equal(visual.ok, true, JSON.stringify(visual))
  assert.equal(visual.images.length, 1)
  // A PNG signature, and a page with ink on it: the glyphs were drawn from
  // the shipped font data, not left blank.
  assert.deepEqual([...visual.images[0].png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47])
  const { ink, pixels } = await inkPixels(visual.images[0].png)
  assert.ok(ink > 0 && ink < pixels, `rendered page ink: ${ink} of ${pixels} pixels`)

  const { runDocumentJob } = require(resolve('dist/core/tools/documentRead/workerRunner.js'))
  let child
  try {
    child = await runDocumentJob({ ...textJob, bytes: bytes.slice() })
  } catch (error) {
    // The runner rejects with a fixed message; the job line above it names
    // the exit code and signal.
    throw new Error(`document reader child rejected: ${error?.message ?? error}`, { cause: error })
  }
  // A refused start resolves as host_memory_unavailable; its logged warning
  // names the condition.
  assert.equal(child.ok, true, `document reader child outcome: ${JSON.stringify(child)}`)
  assert.match(child.pages[0].text, /SMOKE-DOCUMENT-READ/, JSON.stringify(child))
  return { pdfText: true, pdfRender: true, pdfRenderInk: true, childPdfText: true }
}

let requests = 0
const server = createServer((request, response) => {
  request.resume()
  request.on('end', () => {
    requests++
    const body = gzipSync(
      Buffer.from(
        JSON.stringify({ choices: [{ message: { content: 'complete' }, finish_reason: 'stop' }] })
      )
    )
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' })
    response.write(body.subarray(0, 7))
    setImmediate(() => response.end(body.subarray(7)))
  })
})
server.listen(0, '127.0.0.1', async () => {
  try {
    const documentReader = await documentReaderSmoke()
    const baseURL = `http://127.0.0.1:${server.address().port}/v1`
    const provider = new OpenAICompatibleProvider(
      { id: 'zai', baseURL, defaultModel: 'runtime-http-test' },
      'local-http-fixture'
    )
    const result = await provider.completeSingleTurn([{ role: 'user', content: 'read' }], {
      signal: AbortSignal.timeout(5000),
    })
    assert.equal(result.content, 'complete')
    assert.equal(requests, 1)
    process.stdout.write(
      JSON.stringify({
        status: 'PASS',
        nodeVersion: process.versions.node,
        sqlite: true,
        canvas: true,
        documentReader,
        defaultSdkHttp: true,
        requests,
      }) + '\n'
    )
  } catch (error) {
    // Not console.error: dist/logger.js, loaded with the provider above,
    // replaces it and would reduce the error to its name.
    process.stderr.write(`${inspect(error, { depth: 8 })}\n`)
    process.exitCode = 1
  } finally {
    server.closeAllConnections()
    server.close()
  }
})
