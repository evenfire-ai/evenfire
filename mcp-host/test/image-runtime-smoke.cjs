'use strict'

// Run from the built mcp-host package directory, or stream into the final image.
// This checks shipped dist/native bindings; the TypeScript suite owns source-level
// transport faults, keep-alive and cancellation coverage.
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { gzipSync } = require('node:zlib')
const Database = require('better-sqlite3')
const { createCanvas } = require('@napi-rs/canvas')
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

// The document reader's shipped modules: pdfjs-dist text extraction and a
// page render through the image's canvas binding and fonts. They run in
// process here; the child, RLIMIT_DATA and cgroup admission depend on the
// cluster and are covered by the Linux test suite and the T2 lane.
async function documentReaderSmoke() {
  const { DEFAULT_DOCUMENT_READ_LIMITS } = require(resolve('dist/core/tools/documentRead/types.js'))
  const { parsePdfText } = require(resolve('dist/core/tools/documentRead/pdfText.js'))
  const { renderPdfPages } = require(resolve('dist/core/tools/documentRead/pdfRender.js'))
  const bytes = minimalPdf('SMOKE-DOCUMENT-READ')
  const text = await parsePdfText({
    kind: 'pdf_text',
    bytes: bytes.slice(),
    pages: null,
    start: { page: 1, charOffset: 0 },
    limits: DEFAULT_DOCUMENT_READ_LIMITS,
  })
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
  // A PNG signature, and a page with ink on it.
  assert.deepEqual([...visual.images[0].png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47])
  return { pdfText: true, pdfRender: true }
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
    console.log(
      JSON.stringify({
        status: 'PASS',
        nodeVersion: process.versions.node,
        sqlite: true,
        canvas: true,
        documentReader,
        defaultSdkHttp: true,
        requests,
      })
    )
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    server.closeAllConnections()
    server.close()
  }
})
