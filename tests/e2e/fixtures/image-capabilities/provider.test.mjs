/**
 * E2E_GUARDIAN_IPC_FLOW: fixture test, not a browser journey. These tests drive
 * the transport fixture directly; there is no page, route, or renderer HTTP
 * request to await. The user-visible oracle lives in
 * `desktop-app/test/e2e-playwright/qa-recorder-image-capabilities.spec.ts`.
 *
 * Tests for the image-capabilities ZAI chat-completions fixture (issue #654).
 *
 * These tests prove the fixture's own contract: that it reads colors from the PNG
 * pixels rather than from the prompt, that it refuses every shape it does not
 * understand, that it never delegates an external provider origin, and that the
 * evidence it publishes stays sanitized. They are not the journey's E2E oracle.
 */
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { crc32, deflateSync } from 'node:zlib'
import * as providerModule from './provider.mjs'
import { createImageFixtureFetch, validateFixtureEnvironment } from './provider.mjs'

/**
 * The runner's own ephemeral ZAI key for this process, generated here so no test
 * depends on a literal. Only its digest is handed to the fixture, exactly as the
 * real runner publishes it, and the key itself is never written to evidence.
 */
const IMAGE_CAPABILITIES_CREDENTIAL = randomBytes(32).toString('hex')
const IMAGE_CAPABILITIES_CREDENTIAL_SHA256 = createHash('sha256')
  .update(IMAGE_CAPABILITIES_CREDENTIAL)
  .digest('hex')

const FIXTURE_ENV = {
  NODE_ENV: 'test',
  EVENFIRE_IMAGE_CAPABILITIES_FIXTURE: '1',
  IMAGE_CAPABILITIES_RUN_ID: 'image-capabilities-a1b2c3d4e5f6',
  MINIKUBE_PROFILE: 'owned-image-profile',
  CONTROL_API_REAL_PG_CONTEXT: 'owned-image-profile',
  IMAGE_CAPABILITIES_CREDENTIAL_SHA256,
}

const PROVIDER_URL = 'https://api.z.ai/api/coding/paas/v4/chat/completions'
const VISUAL_MODEL = 'glm-5.3-flash'
const TEXT_MODEL = 'glm-5.3'
const TEXT_ONLY_CONTENT = 'IMAGE_FIXTURE_TEXT_OK'

const TILE_COLUMNS = 2
const TILE_ROWS = 3
const TILE_WIDTH = 320
const TILE_HEIGHT = 240

const helperUrl = new URL(
  '../../../../desktop-app/test/e2e-playwright/helpers/qaRecorderImageFixture.ts',
  import.meta.url
)

/**
 * Read the CANONICAL palette out of the Desktop helper the journey actually uses,
 * so this suite fails when the fixture's own table drifts from it instead of
 * quietly agreeing with a duplicated copy.
 */
function canonicalPalette() {
  const source = readFileSync(helperUrl, 'utf8')
  const table = source.slice(source.indexOf('IMAGE_FIXTURE_RGB'))
  const entries = []
  for (const match of table.matchAll(/^\s*(\w+):\s*\[(\d+),\s*(\d+),\s*(\d+)\],/gm))
    entries.push([match[1], Number(match[2]), Number(match[3]), Number(match[4])])
  return entries
}

function pngChunk(type, data, { corruptCrc = false } = {}) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(corruptCrc ? (crc32(typed) ^ 0xffffffff) >>> 0 : crc32(typed), 0)
  return Buffer.concat([length, typed, crc])
}

/**
 * Dependency-free PNG encoder that mirrors the Desktop helper's shape (8-bit
 * truecolor, filter 0, no interlace) with switches for the shapes the fixture
 * must refuse.
 */
function encodePng({
  colors,
  tileWidth = TILE_WIDTH,
  tileHeight = TILE_HEIGHT,
  width: widthOverride,
  height: heightOverride,
  colorType = 2,
  bitDepth = 8,
  interlace = 0,
  filterByte = 0,
  corruptCrc = false,
  truncateBytes = 0,
  signature = true,
} = {}) {
  const width = widthOverride ?? tileWidth * TILE_COLUMNS
  const height = heightOverride ?? tileHeight * TILE_ROWS
  const channels = colorType === 6 ? 4 : 3
  const sampleBytes = bitDepth === 16 ? 2 : 1
  const stride = width * channels * sampleBytes + 1
  const raw = Buffer.alloc(stride * height)

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * stride
    raw[rowStart] = filterByte
    const row = Math.floor(y / tileHeight)
    for (let x = 0; x < width; x += 1) {
      const column = Math.floor(x / tileWidth)
      const [red, green, blue] =
        colors[Math.min(row, TILE_ROWS - 1) * TILE_COLUMNS + Math.min(column, TILE_COLUMNS - 1)]
      let offset = rowStart + 1 + x * channels * sampleBytes
      for (const sample of [red, green, blue]) {
        if (sampleBytes === 2) {
          raw[offset] = 0
          raw[offset + 1] = sample
        } else raw[offset] = sample
        offset += sampleBytes
      }
      if (channels === 4) for (let i = 0; i < sampleBytes; i += 1) raw[offset + i] = 255
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = bitDepth
  ihdr[9] = colorType
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = interlace

  const body = Buffer.concat([
    ...(signature ? [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])] : []),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 }), { corruptCrc }),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
  return truncateBytes > 0 ? body.subarray(0, body.length - truncateBytes) : body
}

/** A canonical 2x3 fixture PNG built from the Desktop helper's own RGB values. */
function palettePng(overrides = {}) {
  const palette = canonicalPalette()
  assert.ok(palette.length >= TILE_COLUMNS * TILE_ROWS, 'canonical palette is too small')
  const picked = palette.slice(0, TILE_COLUMNS * TILE_ROWS)
  return {
    names: picked.map(entry => entry[0]),
    png: encodePng({ colors: picked.map(entry => entry.slice(1)), ...overrides }),
  }
}

function harness({ onEvidence } = {}) {
  const delegated = []
  const fixture = createImageFixtureFetch(
    async (input, init) => {
      delegated.push([input, init])
      return new Response('delegated', { status: 200 })
    },
    {
      runId: FIXTURE_ENV.IMAGE_CAPABILITIES_RUN_ID,
      credentialHash: IMAGE_CAPABILITIES_CREDENTIAL_SHA256,
      onEvidence,
    }
  )
  return { ...fixture, delegated }
}

function authHeaders() {
  return { authorization: `Bearer ${IMAGE_CAPABILITIES_CREDENTIAL}` }
}

function call(fixture, body, { url = PROVIDER_URL, method = 'POST', headers, rawBody } = {}) {
  return fixture.fetch(url, {
    method,
    headers: headers ?? authHeaders(),
    body: rawBody ?? JSON.stringify(body),
  })
}

function chatBody(model, messages, extra = {}) {
  return { model, messages, ...extra }
}

function textMessages(text = 'Reply with a short acknowledgement.') {
  return [{ role: 'user', content: text }]
}

function imageMessages(png, text = 'Reply with the tile colors in reading order.') {
  return [
    {
      role: 'user',
      content: [
        { type: 'text', text },
        {
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${png.toString('base64')}`, detail: 'auto' },
        },
      ],
    },
  ]
}

test('validateFixtureEnvironment accepts the isolated binding', () => {
  validateFixtureEnvironment(FIXTURE_ENV)
})

test('validateFixtureEnvironment rejects every missing or wrong binding', () => {
  for (const key of Object.keys(FIXTURE_ENV))
    assert.throws(() => validateFixtureEnvironment({ ...FIXTURE_ENV, [key]: '' }), key)
  assert.throws(() => validateFixtureEnvironment({ ...FIXTURE_ENV, NODE_ENV: 'production' }))
  assert.throws(() =>
    validateFixtureEnvironment({ ...FIXTURE_ENV, EVENFIRE_IMAGE_CAPABILITIES_FIXTURE: '0' })
  )
  assert.throws(() =>
    validateFixtureEnvironment({ ...FIXTURE_ENV, MINIKUBE_PROFILE: 'not-the-context' })
  )
  assert.throws(() =>
    validateFixtureEnvironment({ ...FIXTURE_ENV, MINIKUBE_PROFILE: 'Bad_Profile' })
  )
  assert.throws(() =>
    validateFixtureEnvironment({
      ...FIXTURE_ENV,
      IMAGE_CAPABILITIES_RUN_ID: 'image-capabilities-zzzzzzzzzzzz',
    })
  )
  assert.throws(() =>
    validateFixtureEnvironment({
      ...FIXTURE_ENV,
      IMAGE_CAPABILITIES_RUN_ID: 'approved-tools-a1b2c3d4e5f6',
    })
  )
  // The binding is a digest, so a short value or the key itself is not one.
  assert.throws(() =>
    validateFixtureEnvironment({
      ...FIXTURE_ENV,
      IMAGE_CAPABILITIES_CREDENTIAL_SHA256: 'a'.repeat(63),
    })
  )
  assert.throws(() =>
    validateFixtureEnvironment({
      ...FIXTURE_ENV,
      IMAGE_CAPABILITIES_CREDENTIAL_SHA256: IMAGE_CAPABILITIES_CREDENTIAL.slice(0, 32),
    })
  )
})

test('the factory refuses to build without a delegate, run id and key digest', () => {
  const delegate = async () => new Response('delegated')
  const runId = FIXTURE_ENV.IMAGE_CAPABILITIES_RUN_ID
  assert.throws(() => createImageFixtureFetch(undefined, { runId }))
  assert.throws(() =>
    createImageFixtureFetch(delegate, { credentialHash: IMAGE_CAPABILITIES_CREDENTIAL_SHA256 })
  )
  assert.throws(() =>
    createImageFixtureFetch(delegate, {
      runId: 'nope',
      credentialHash: IMAGE_CAPABILITIES_CREDENTIAL_SHA256,
    })
  )
  assert.throws(() => createImageFixtureFetch(delegate, { runId, credentialHash: '' }))
  assert.throws(() => createImageFixtureFetch(delegate, { runId, credentialHash: 'not-a-digest' }))
  // A digest is exactly 64 hex characters; a longer value is not one.
  assert.throws(() =>
    createImageFixtureFetch(delegate, {
      runId,
      credentialHash: `${IMAGE_CAPABILITIES_CREDENTIAL}ff`,
    })
  )
})

test('reads the ordered tile colors from the delivered PNG bytes', async () => {
  const { names, png } = palettePng()
  const snapshots = []
  const h = harness({ onEvidence: snapshot => snapshots.push(snapshot) })

  const response = await call(h, chatBody(VISUAL_MODEL, imageMessages(png)))
  assert.equal(response.status, 200)
  const body = await response.json()

  assert.equal(body.object, 'chat.completion')
  assert.equal(body.model, VISUAL_MODEL)
  assert.equal(body.id, `chatcmpl-image-fixture-a1b2c3d4e5f6-1`)
  assert.equal(body.choices.length, 1)
  assert.equal(body.choices[0].index, 0)
  assert.equal(body.choices[0].finish_reason, 'stop')
  assert.equal(body.choices[0].message.role, 'assistant')
  assert.equal(body.choices[0].message.content, names.join(', '))
  assert.equal('tool_calls' in body.choices[0].message, false)
  assert.deepEqual(body.usage, { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 })
  assert.equal(h.delegated.length, 0)

  const evidence = h.getEvidence()
  assert.equal(evidence.runId, FIXTURE_ENV.IMAGE_CAPABILITIES_RUN_ID)
  assert.equal(evidence.counters.totalAttempts, 1)
  assert.equal(evidence.counters.imageAttempts, 1)
  assert.equal(evidence.counters.textAttempts, 0)
  assert.equal(evidence.counters.rejectedAttempts, 0)
  assert.equal(evidence.counters.tileColorResponses, 1)
  assert.equal(evidence.counters.textOnlyResponses, 0)
  assert.deepEqual(evidence.attempts, [
    {
      model: VISUAL_MODEL,
      imageSha256: createHash('sha256').update(png).digest('hex'),
      responseKind: 'tile-colors',
    },
  ])
  assert.equal(snapshots.length, 1)
  assert.equal(snapshots[0].counters.totalAttempts, 1)
})

test('never answers from the prompt alone, even when the prompt names the colors', async () => {
  const { names } = palettePng()
  const h = harness()

  const response = await call(
    h,
    chatBody(VISUAL_MODEL, textMessages(`Reply with exactly: ${names.join(', ')}`))
  )
  assert.equal(response.status, 200)
  const body = await response.json()

  assert.equal(body.choices[0].message.content, TEXT_ONLY_CONTENT)
  assert.equal(body.choices[0].message.content.includes(names[0]), false)

  const evidence = h.getEvidence()
  assert.equal(evidence.counters.imageAttempts, 0)
  assert.equal(evidence.counters.textAttempts, 1)
  assert.equal(evidence.counters.tileColorResponses, 0)
  assert.deepEqual(evidence.attempts, [
    { model: VISUAL_MODEL, imageSha256: null, responseKind: 'text-only' },
  ])
})

test('image removed: no color list and no image attempt is recorded', async () => {
  const { names, png } = palettePng()
  const h = harness()

  // The exact same request as the success case, with only the image part removed.
  const [textPart] = imageMessages(png)[0].content
  const response = await call(h, chatBody(VISUAL_MODEL, [{ role: 'user', content: [textPart] }]))
  assert.equal(response.status, 200)
  const body = await response.json()

  assert.equal(body.choices[0].message.content, TEXT_ONLY_CONTENT)
  assert.notEqual(body.choices[0].message.content, names.join(', '))

  const evidence = h.getEvidence()
  assert.equal(evidence.counters.imageAttempts, 0)
  assert.equal(evidence.counters.tileColorResponses, 0)
  assert.equal(evidence.attempts.length, 1)
  assert.equal(evidence.attempts[0].imageSha256, null)
  assert.equal(evidence.attempts[0].responseKind, 'text-only')
})

test('a text-only request answers with the marker for both accepted models', async () => {
  for (const model of [TEXT_MODEL, VISUAL_MODEL]) {
    const h = harness()
    const response = await call(h, chatBody(model, textMessages()))
    assert.equal(response.status, 200, model)
    const body = await response.json()
    assert.equal(body.choices[0].message.content, TEXT_ONLY_CONTENT, model)
    assert.equal(body.choices[0].finish_reason, 'stop', model)
    const evidence = h.getEvidence()
    assert.equal(evidence.counters.textOnlyResponses, 1, model)
    assert.equal(evidence.counters.tileColorResponses, 0, model)
  }
})

test('the text-only model refuses an image and records the incompatible attempt', async () => {
  const { png } = palettePng()
  const h = harness()

  const response = await call(h, chatBody(TEXT_MODEL, imageMessages(png)))
  assert.equal(response.status, 400)
  const body = await response.json()
  assert.equal(body.error.type, 'fixture_error')
  assert.equal(body.error.code, 'image_not_supported_by_model')

  const evidence = h.getEvidence()
  assert.equal(evidence.counters.textModelImageRefusals, 1)
  assert.equal(evidence.counters.imageAttempts, 1)
  assert.equal(evidence.counters.rejectedAttempts, 1)
  assert.equal(evidence.counters.tileColorResponses, 0)
  assert.deepEqual(evidence.attempts, [
    {
      model: TEXT_MODEL,
      imageSha256: null,
      responseKind: 'rejected',
      reason: 'text-model-image-incompatible',
    },
  ])
})

test('an unsupported model is refused in both payload shapes', async () => {
  const { png } = palettePng()
  for (const messages of [textMessages(), imageMessages(png)]) {
    const h = harness()
    const response = await call(h, chatBody('glm-5.2', messages))
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error.code, 'unsupported_model')
    assert.equal(h.getEvidence().counters.rejectedAttempts, 1)
    assert.equal(h.getEvidence().counters.tileColorResponses, 0)
  }
})

test('more than one image part is refused', async () => {
  const { png } = palettePng()
  const h = harness()
  const messages = imageMessages(png)
  messages[0].content.push(messages[0].content[1])

  const response = await call(h, chatBody(VISUAL_MODEL, messages))
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error.code, 'image-part-count')
  assert.equal(h.getEvidence().counters.imageAttempts, 1)
})

test('refuses image payloads that are not the canonical PNG data URI', async () => {
  const { png } = palettePng()
  const base64 = png.toString('base64')
  const cases = [
    ['jpeg data uri', `data:image/jpeg;base64,${base64}`],
    ['unpadded base64', `data:image/png;base64,${base64.replace(/=+$/, '')}`],
    ['non-base64 payload', 'data:image/png;base64,not*base64!'],
    ['remote reference', 'https://example.test/visual-input.png'],
    ['empty payload', 'data:image/png;base64,'],
  ]

  for (const [label, url] of cases) {
    const h = harness()
    const response = await call(
      h,
      chatBody(VISUAL_MODEL, [
        { role: 'user', content: [{ type: 'image_url', image_url: { url } }] },
      ])
    )
    assert.equal(response.status, 400, label)
    assert.equal((await response.json()).error.code, 'image-not-png-data-uri', label)
    const evidence = h.getEvidence()
    assert.equal(evidence.counters.imageAttempts, 1, label)
    assert.equal(evidence.counters.imageDecodeFailures, 1, label)
  }
})

test('reads a proportionally downscaled grid, not just the exact helper size', async () => {
  const palette = canonicalPalette().slice(0, TILE_COLUMNS * TILE_ROWS)
  const png = encodePng({
    colors: palette.map(entry => entry.slice(1)),
    tileWidth: 8,
    tileHeight: 9,
  })
  const h = harness()

  const response = await call(h, chatBody(VISUAL_MODEL, imageMessages(png)))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.choices[0].message.content, palette.map(entry => entry[0]).join(', '))
})

test('refuses every PNG shape it cannot read pixel-exactly', async () => {
  const cases = [
    ['colour type 6', { colorType: 6 }, 'image-png-unsupported-form'],
    ['bit depth 16', { bitDepth: 16 }, 'image-png-unsupported-form'],
    ['interlaced', { interlace: 1 }, 'image-png-unsupported-form'],
    ['non-zero scanline filter', { filterByte: 1 }, 'image-png-unsupported-form'],
    ['corrupt chunk crc', { corruptCrc: true }, 'image-png-malformed'],
    ['truncated image', { truncateBytes: 8 }, 'image-png-malformed'],
    ['missing signature', { signature: false }, 'image-png-malformed'],
    ['grid that does not divide', { width: 641 }, 'image-tile-grid-mismatch'],
  ]

  for (const [label, overrides, code] of cases) {
    const { png } = palettePng(overrides)
    const h = harness()
    const response = await call(h, chatBody(VISUAL_MODEL, imageMessages(png)))
    assert.equal(response.status, 400, label)
    assert.equal((await response.json()).error.code, code, label)
    const evidence = h.getEvidence()
    assert.equal(evidence.counters.imageAttempts, 1, label)
    assert.equal(evidence.counters.imageDecodeFailures, 1, label)
    assert.equal(evidence.counters.tileColorResponses, 0, label)
    assert.equal(evidence.attempts[0].responseKind, 'rejected', label)
  }
})

test('refuses provider requests it will not read or forward', async () => {
  const { png } = palettePng()
  const validBody = JSON.stringify(chatBody(VISUAL_MODEL, imageMessages(png)))
  const cases = [
    ['GET method', { method: 'GET', body: validBody }, 'method_not_supported'],
    [
      'query string',
      { method: 'POST', body: validBody, url: `${PROVIDER_URL}?x=1` },
      'path_not_captured',
    ],
    [
      'wrong provider path',
      { method: 'POST', body: validBody, url: 'https://api.z.ai/api/coding/paas/v4/models' },
      'path_not_captured',
    ],
    ['buffer body', { method: 'POST', body: Buffer.from(validBody) }, 'unsupported_body'],
    ['oversized body', { method: 'POST', body: 'x'.repeat(8 * 1024 * 1024 + 1) }, 'body_too_large'],
    ['invalid json', { method: 'POST', body: '{' }, 'invalid_json'],
    [
      'missing model and messages',
      { method: 'POST', body: JSON.stringify({ messages: [] }) },
      'missing_model_or_messages',
    ],
  ]

  for (const [label, { method, body, url = PROVIDER_URL }, code] of cases) {
    const h = harness()
    const response = await h.fetch(url, { method, headers: authHeaders(), body })
    assert.equal(response.status, 400, label)
    assert.equal((await response.json()).error.code, code, label)
    assert.equal(h.delegated.length, 0, label)
    assert.equal(h.getEvidence().counters.rejectedAttempts, 1, label)
    assert.equal(h.getEvidence().counters.totalAttempts, 1, label)
  }

  const h = harness()
  const requestForm = await h.fetch(new Request(PROVIDER_URL, { method: 'POST', body: validBody }))
  assert.equal(requestForm.status, 400)
  assert.equal((await requestForm.json()).error.code, 'unsupported_request_form')
  assert.equal(h.delegated.length, 0)
})

test('refuses every external origin it does not own and never delegates', async () => {
  const h = harness()
  const externals = [
    'https://api.openai.com/v1/chat/completions',
    'https://api.anthropic.com/v1/messages',
    'https://api.deepseek.com/chat/completions',
    'https://openrouter.ai/api/v1/chat/completions',
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    'https://example.test/anything',
  ]

  for (const url of externals) {
    const response = await h.fetch(url, { method: 'POST', headers: authHeaders(), body: '{}' })
    assert.equal(response.status, 403, url)
    assert.equal((await response.json()).error.code, 'egress_blocked', url)
  }

  assert.equal(h.delegated.length, 0)
  const evidence = h.getEvidence()
  assert.equal(evidence.counters.blockedEgress, externals.length)
  // A refused origin is not a provider attempt, so it adds no ledger row.
  assert.equal(evidence.counters.totalAttempts, 0)
  assert.deepEqual(evidence.attempts, [])
})

test('delegates internal routes untouched, including their auth', async () => {
  const h = harness()
  const internalAuth = `Bearer ${randomBytes(16).toString('hex')}`
  const internals = [
    'http://control-api.control-plane.svc.cluster.local:8080/healthz',
    'http://chatllm.mcp-host:8080/v1/rpc',
    'http://agent2.mcp-host.svc:8080/status',
    'http://hcc.gfs:8080/ready',
    'http://127.0.0.1:3001/tools',
    'http://localhost:9000/metrics',
  ]

  for (const url of internals) {
    const init = { method: 'POST', headers: { authorization: internalAuth }, body: '{"x":1}' }
    const response = await h.fetch(url, init)
    assert.equal(response.status, 200, url)
    assert.equal(await response.text(), 'delegated', url)
    const [input, passedInit] = h.delegated.at(-1)
    assert.equal(input, url, url)
    // Identical reference: nothing was cloned, rewritten or re-signed.
    assert.equal(passedInit, init, url)
  }

  assert.equal(h.delegated.length, internals.length)
  const evidence = h.getEvidence()
  assert.equal(evidence.counters.totalAttempts, 0)
  assert.equal(evidence.counters.blockedEgress, 0)
  assert.deepEqual(evidence.attempts, [])
})

test('classifies bracketed IPv6 literals before the single-label internal rule', async () => {
  const h = harness()
  const internals = [
    'http://[::1]:8080/healthz',
    'http://[fe80::1]:8080/healthz',
    'http://localhost:8080/healthz',
    'http://127.0.0.1:8080/healthz',
    'http://chatllm:8080/healthz',
  ]
  const externals = ['https://[2606:4700::1111]/cdn-cgi/trace', 'https://example.com/anything']

  for (const url of internals) {
    const response = await h.fetch(url, { method: 'GET' })
    assert.equal(response.status, 200, url)
    assert.equal(await response.text(), 'delegated', url)
  }

  for (const url of externals) {
    const response = await h.fetch(url, { method: 'GET' })
    assert.equal(response.status, 403, url)
    assert.equal((await response.json()).error.code, 'egress_blocked', url)
  }

  assert.equal(h.delegated.length, internals.length)
  const evidence = h.getEvidence()
  assert.equal(evidence.counters.blockedEgress, externals.length)
  assert.equal(evidence.counters.totalAttempts, 0)
})

test('streams SSE when the client asks for a stream', async () => {
  const { names, png } = palettePng()
  const h = harness()

  const response = await call(h, chatBody(VISUAL_MODEL, imageMessages(png), { stream: true }))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/event-stream')

  const text = await response.text()
  assert.match(text, /^data: /)
  assert.match(text, /data: \[DONE\]\n\n$/)

  const frames = text
    .split('\n\n')
    .filter(frame => frame.startsWith('data: ') && !frame.includes('[DONE]'))
    .map(frame => JSON.parse(frame.slice('data: '.length)))

  assert.equal(frames.length, 3)
  for (const frame of frames) {
    assert.equal(frame.object, 'chat.completion.chunk')
    assert.equal(frame.model, VISUAL_MODEL)
    assert.equal(frame.id, 'chatcmpl-image-fixture-a1b2c3d4e5f6-1')
    assert.equal('tool_calls' in frame.choices[0].delta, false)
    assert.equal(frame.choices[0].index, 0)
  }
  assert.equal(frames[0].choices[0].delta.role, 'assistant')
  assert.equal(frames[1].choices[0].delta.content, names.join(', '))
  assert.equal(frames[2].choices[0].finish_reason, 'stop')
  assert.deepEqual(frames[2].usage, { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 })

  assert.equal(h.getEvidence().counters.tileColorResponses, 1)
  assert.equal(h.getEvidence().attempts[0].responseKind, 'tile-colors')
})

test('authenticates on the key digest and never records the key', async () => {
  const h = harness()
  const body = JSON.stringify(chatBody(VISUAL_MODEL, textMessages()))

  assert.equal((await call(h, chatBody(VISUAL_MODEL, textMessages()))).status, 200)

  const refused = [
    ['no header', {}],
    ['wrong scheme', { authorization: `Basic ${IMAGE_CAPABILITIES_CREDENTIAL}` }],
    ['scheme only', { authorization: 'Bearer' }],
    ['wrong key', { authorization: `Bearer ${IMAGE_CAPABILITIES_CREDENTIAL.slice(0, 62)}` }],
    ['digest replayed as key', { authorization: `Bearer ${IMAGE_CAPABILITIES_CREDENTIAL_SHA256}` }],
  ]
  for (const [label, headers] of refused) {
    const response = await h.fetch(PROVIDER_URL, { method: 'POST', headers, body })
    assert.equal(response.status, 401, label)
    assert.equal((await response.json()).error.code, 'unauthorized', label)
  }

  const evidence = h.getEvidence()
  assert.equal(evidence.counters.unauthorizedAttempts, refused.length)
  assert.equal(evidence.counters.totalAttempts, refused.length + 1)
  assert.equal(evidence.counters.textOnlyResponses, 1)
  // The accepted call is recorded first; every later refusal happened before the
  // body was parsed, so it carries no model.
  assert.deepEqual(
    evidence.attempts.map(attempt => attempt.model),
    [VISUAL_MODEL, null, null, null, null, null]
  )

  const serialized = JSON.stringify(evidence)
  assert.equal(serialized.includes(IMAGE_CAPABILITIES_CREDENTIAL), false)
  assert.equal(serialized.includes('authorization'), false)
  assert.equal(serialized.includes('Bearer'), false)
})

test('getEvidence returns a private copy and onEvidence publishes snapshots', async () => {
  const snapshots = []
  const h = harness({ onEvidence: snapshot => snapshots.push(snapshot) })

  await call(h, chatBody(VISUAL_MODEL, textMessages()))
  await call(h, chatBody(TEXT_MODEL, textMessages()))

  assert.equal(snapshots.length, 2)
  assert.equal(snapshots[0].counters.totalAttempts, 1)
  assert.equal(snapshots[1].counters.totalAttempts, 2)
  assert.equal(snapshots[0].attempts.length, 1)
  assert.notEqual(snapshots[0], snapshots[1])

  const first = h.getEvidence()
  first.counters.totalAttempts = 999
  first.attempts.length = 0

  const second = h.getEvidence()
  assert.equal(second.counters.totalAttempts, 2)
  assert.equal(second.attempts.length, 2)
  assert.notEqual(h.getEvidence(), h.getEvidence())
})

// ---------------------------------------------------------------------------
// Documents (issue #678): the Host lists an attached file in the turn-context
// block and offers `clerum__attachment_read`; the text reaches the provider only
// in the tool result of the second request.
// ---------------------------------------------------------------------------

const READ_TOOL = 'clerum__attachment_read'
const ATTACHMENT_ID = 'att-11111111-2222-4333-8444-555555555555'
const DOCUMENT_TEXT = 'ledger token 7f3a9c1e\nsecond line\n'

const readToolDefinition = {
  type: 'function',
  function: {
    name: READ_TOOL,
    description: 'Read an attached file.',
    parameters: { type: 'object' },
  },
}

function documentUserMessage(
  text = 'Summarize the attached file.',
  { bytesField = 'bytes=34' } = {}
) {
  return {
    role: 'user',
    content:
      '<turn-context>\ndate: 2026-09-29\n' +
      `attached_file: id="${ATTACHMENT_ID}" name="notes.txt" class=text ${bytesField} reader=text\n` +
      "If the user's request refers to an attached file, read it with clerum__attachment_read before answering.\n" +
      `</turn-context>\n\n${text}`,
  }
}

function wrappedToolOutput(payload, { name = READ_TOOL } = {}) {
  return `<tool_output name="${name}" sanitized="false">\n${JSON.stringify(payload)}\n</tool_output>`
}

function documentReadResult(text = DOCUMENT_TEXT) {
  return {
    attachmentId: ATTACHMENT_ID,
    referenceId: 'ref-1',
    kind: 'text',
    byteRange: { offset: 0, length: Buffer.byteLength(text) },
    truncated: false,
    text,
  }
}

function documentAnswerMessages(toolContent) {
  return [
    documentUserMessage(),
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call-1', type: 'function', function: { name: READ_TOOL, arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call-1', content: toolContent },
  ]
}

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex')

test('document turn 1: asks for the text with a tool call and carries no file content', async () => {
  const h = harness()

  const response = await call(
    h,
    chatBody(VISUAL_MODEL, [documentUserMessage()], { tools: [readToolDefinition] })
  )
  assert.equal(response.status, 200)
  const body = await response.json()

  assert.equal(body.choices[0].finish_reason, 'tool_calls')
  const [toolCall] = body.choices[0].message.tool_calls
  assert.equal(toolCall.type, 'function')
  assert.equal(toolCall.function.name, READ_TOOL)
  assert.deepEqual(JSON.parse(toolCall.function.arguments), { attachmentId: ATTACHMENT_ID })

  const evidence = h.getEvidence()
  assert.equal(evidence.counters.documentReadRequests, 1)
  assert.equal(evidence.counters.documentAnswers, 0)
  assert.deepEqual(evidence.attempts, [
    {
      model: VISUAL_MODEL,
      imageSha256: null,
      responseKind: 'document-read-requested',
      documentSha256: null,
      documentByteLength: Buffer.byteLength(DOCUMENT_TEXT),
    },
  ])
})

test('document turn 1: the read row records the byte length the Host listed, not a constant', async () => {
  const lengths = []
  for (const bytes of [34, 6_291_456]) {
    const h = harness()
    const response = await call(
      h,
      chatBody(VISUAL_MODEL, [documentUserMessage(undefined, { bytesField: `bytes=${bytes}` })], {
        tools: [readToolDefinition],
      })
    )
    assert.equal(response.status, 200)
    const [row] = h.getEvidence().attempts
    assert.equal(row.responseKind, 'document-read-requested')
    lengths.push(row.documentByteLength)
  }
  assert.deepEqual(lengths, [34, 6_291_456])
})

test('document turn 1: an attached_file line without a usable bytes= is refused, not read', async () => {
  // Liveness witness: the same message with a well-formed field is read.
  const twin = harness()
  const twinResponse = await call(
    twin,
    chatBody(VISUAL_MODEL, [documentUserMessage()], { tools: [readToolDefinition] })
  )
  assert.equal(twinResponse.status, 200)
  assert.equal(twin.getEvidence().counters.documentReadRequests, 1)

  for (const bytesField of [
    'size=34',
    'bytes=',
    'bytes=abc',
    'bytes=34x',
    'bytes=1.5',
    'bytes=-1',
    'bytes=0',
    'bytes=034',
  ]) {
    const h = harness()
    const response = await call(
      h,
      chatBody(VISUAL_MODEL, [documentUserMessage(undefined, { bytesField })], {
        tools: [readToolDefinition],
      })
    )
    assert.equal(response.status, 400, bytesField)
    const evidence = h.getEvidence()
    assert.equal(evidence.counters.documentFailures, 1, bytesField)
    assert.equal(evidence.counters.documentReadRequests, 0, bytesField)
    assert.equal(evidence.attempts[0].responseKind, 'rejected', bytesField)
    assert.equal((await response.json()).error.code, 'document-byte-length-malformed', bytesField)
  }
})

test('document turn 2: the answer is a digest of the delivered text and the ledger records it', async () => {
  const h = harness()

  const response = await call(
    h,
    chatBody(VISUAL_MODEL, documentAnswerMessages(wrappedToolOutput(documentReadResult())), {
      tools: [readToolDefinition],
    })
  )
  assert.equal(response.status, 200)
  const body = await response.json()

  const digest = sha256(DOCUMENT_TEXT)
  assert.equal(body.choices[0].message.content, `DOCUMENT_FIXTURE_SHA256:${digest.slice(0, 16)}`)
  assert.equal(body.choices[0].finish_reason, 'stop')
  assert.deepEqual(h.getEvidence().attempts, [
    {
      model: VISUAL_MODEL,
      imageSha256: null,
      responseKind: 'document-answer',
      documentSha256: digest,
      byteRange: { offset: 0, length: Buffer.byteLength(DOCUMENT_TEXT) },
      truncated: false,
    },
  ])
  assert.equal(h.getEvidence().counters.documentAnswers, 1)
})

test('document turn 2: the answer row records the page the Host delivered, not a constant', async () => {
  const rows = []
  for (const page of [
    { offset: 0, length: 65_536, truncated: true },
    { offset: 0, length: 4_096, truncated: true },
    { offset: 65_536, length: 2_048, truncated: false },
  ]) {
    const h = harness()
    const result = {
      ...documentReadResult(),
      byteRange: { offset: page.offset, length: page.length },
      truncated: page.truncated,
    }
    const response = await call(
      h,
      chatBody(VISUAL_MODEL, documentAnswerMessages(wrappedToolOutput(result)), {
        tools: [readToolDefinition],
      })
    )
    assert.equal(response.status, 200)
    const [row] = h.getEvidence().attempts
    assert.equal(row.responseKind, 'document-answer')
    rows.push({ byteRange: row.byteRange, truncated: row.truncated })
  }
  assert.deepEqual(rows, [
    { byteRange: { offset: 0, length: 65_536 }, truncated: true },
    { byteRange: { offset: 0, length: 4_096 }, truncated: true },
    { byteRange: { offset: 65_536, length: 2_048 }, truncated: false },
  ])
})

test('document turn 2: a page range or truncation flag the fixture cannot read is refused', async () => {
  // Liveness witness: the well-formed result is answered.
  const twin = harness()
  const twinResponse = await call(
    twin,
    chatBody(VISUAL_MODEL, documentAnswerMessages(wrappedToolOutput(documentReadResult())), {
      tools: [readToolDefinition],
    })
  )
  assert.equal(twinResponse.status, 200)
  assert.equal(twin.getEvidence().counters.documentAnswers, 1)

  const valid = documentReadResult()
  const withoutTruncated = { ...valid }
  delete withoutTruncated.truncated
  const withoutRange = { ...valid }
  delete withoutRange.byteRange
  for (const [label, result] of [
    ['missing byteRange', withoutRange],
    ['null byteRange', { ...valid, byteRange: null }],
    ['array byteRange', { ...valid, byteRange: [0, 34] }],
    ['missing offset', { ...valid, byteRange: { length: 34 } }],
    ['negative offset', { ...valid, byteRange: { offset: -1, length: 34 } }],
    ['fractional length', { ...valid, byteRange: { offset: 0, length: 1.5 } }],
    ['string length', { ...valid, byteRange: { offset: 0, length: '34' } }],
    ['unsafe length', { ...valid, byteRange: { offset: 0, length: 2 ** 53 } }],
    ['missing truncated', withoutTruncated],
    ['string truncated', { ...valid, truncated: 'false' }],
  ]) {
    const h = harness()
    const response = await call(
      h,
      chatBody(VISUAL_MODEL, documentAnswerMessages(wrappedToolOutput(result)), {
        tools: [readToolDefinition],
      })
    )
    assert.equal(response.status, 400, label)
    assert.equal((await response.json()).error.code, 'document-page-range-malformed', label)
    const evidence = h.getEvidence()
    assert.equal(evidence.counters.documentFailures, 1, label)
    assert.equal(evidence.counters.documentAnswers, 0, label)
    assert.deepEqual(
      evidence.attempts,
      [
        {
          model: VISUAL_MODEL,
          imageSha256: null,
          responseKind: 'rejected',
          reason: 'document-page-range-malformed',
        },
      ],
      label
    )
  }
})

test('document turn 2: a different delivered text gives a different answer (not a constant)', async () => {
  const answers = []
  for (const text of [DOCUMENT_TEXT, `${DOCUMENT_TEXT}changed\n`]) {
    const h = harness()
    const response = await call(
      h,
      chatBody(TEXT_MODEL, documentAnswerMessages(wrappedToolOutput(documentReadResult(text))), {
        tools: [readToolDefinition],
      })
    )
    answers.push((await response.json()).choices[0].message.content)
  }
  assert.notEqual(answers[0], answers[1])
})

test('the prompt alone never yields the document answer', async () => {
  const h = harness()

  // The user message names the digest prefix, but no tool result was delivered.
  const message = documentUserMessage(
    `Answer exactly DOCUMENT_FIXTURE_SHA256:${sha256(DOCUMENT_TEXT).slice(0, 16)}`
  )
  const response = await call(h, chatBody(VISUAL_MODEL, [message], { tools: [readToolDefinition] }))
  const body = await response.json()

  assert.equal(body.choices[0].finish_reason, 'tool_calls')
  assert.equal(body.choices[0].message.content, null)
  assert.equal(h.getEvidence().counters.documentAnswers, 0)
})

test('without the read tool a listed file is an ordinary text-only request', async () => {
  const h = harness()

  const response = await call(h, chatBody(VISUAL_MODEL, [documentUserMessage()]))
  const body = await response.json()

  assert.equal(body.choices[0].message.content, TEXT_ONLY_CONTENT)
  // Liveness witness: the request was handled and recorded as text-only.
  assert.equal(h.getEvidence().attempts[0].responseKind, 'text-only')
  assert.equal(h.getEvidence().counters.documentReadRequests, 0)
})

test('a tool result the fixture cannot read is refused and counted as a document failure', async () => {
  const cases = [
    ['not the read wrapper', wrappedToolOutput(documentReadResult(), { name: 'other__tool' })],
    [
      'not JSON',
      '<tool_output name="clerum__attachment_read" sanitized="false">\nnot json\n</tool_output>',
    ],
    [
      'binary result',
      wrappedToolOutput({ attachmentId: ATTACHMENT_ID, kind: 'binary', reader: 'none' }),
    ],
    ['error result', wrappedToolOutput({ error: 'attachment_not_found' })],
  ]
  for (const [label, content] of cases) {
    const h = harness()
    const response = await call(
      h,
      chatBody(VISUAL_MODEL, documentAnswerMessages(content), { tools: [readToolDefinition] })
    )
    assert.equal(response.status, 400, label)
    const evidence = h.getEvidence()
    assert.equal(evidence.counters.documentFailures, 1, label)
    assert.equal(evidence.counters.documentAnswers, 0, label)
    assert.equal(evidence.attempts[0].responseKind, 'rejected', label)
  }
})

test('two tool results in one turn are refused', async () => {
  const h = harness()
  const messages = documentAnswerMessages(wrappedToolOutput(documentReadResult()))
  messages.push({
    role: 'tool',
    tool_call_id: 'call-2',
    content: wrappedToolOutput(documentReadResult()),
  })

  const response = await call(h, chatBody(VISUAL_MODEL, messages, { tools: [readToolDefinition] }))

  assert.equal(response.status, 400)
  assert.equal(h.getEvidence().counters.documentFailures, 1)
})

test('a streamed document turn is refused instead of answered', async () => {
  const h = harness()

  const response = await call(
    h,
    chatBody(VISUAL_MODEL, [documentUserMessage()], { tools: [readToolDefinition], stream: true })
  )

  assert.equal(response.status, 400)
  const evidence = h.getEvidence()
  assert.equal(evidence.counters.documentFailures, 1)
  assert.equal(evidence.counters.documentReadRequests, 0)
})

test('image rows keep their original shape (no documentSha256)', async () => {
  const { png } = palettePng()
  const h = harness()

  await call(h, chatBody(VISUAL_MODEL, imageMessages(png)))

  assert.equal('documentSha256' in h.getEvidence().attempts[0], false)
})

/**
 * Declared here, not imported, so the oracle stays independent of the producer:
 * a reason added to the fixture without a test fails the parity check below.
 */
const EXPECTED_REJECTION_REASONS = [
  'document-byte-length-malformed',
  'document-page-range-malformed',
  'document-stream-unsupported',
  'document-tool-output-malformed',
  'document-tool-output-unreadable',
  'document-tool-result-count',
  'image-not-png-data-uri',
  'image-part-count',
  'image-pixel-not-a-tile-color',
  'image-png-malformed',
  'image-png-unsupported-form',
  'image-tile-grid-mismatch',
  'legacy-lease-download-not-offered',
  'legacy-lease-download-result-malformed',
  'legacy-lease-shell-not-offered',
  'legacy-lease-stream-unsupported',
  'legacy-lease-tool-result-count',
  'legacy-lease-tool-result-unexpected',
  'provider-auth-mismatch',
  'provider-body-invalid',
  'provider-body-unsupported',
  'provider-method-unsupported',
  'provider-path-not-captured',
  'provider-request-form-unsupported',
  'text-model-image-incompatible',
  'unsupported-model',
]

test('the fixture publishes exactly the closed set of rejection reasons, frozen', () => {
  const reasons = providerModule.FIXTURE_REJECTION_REASONS
  assert.ok(Array.isArray(reasons), 'FIXTURE_REJECTION_REASONS is exported as an array')
  assert.deepEqual([...reasons].sort(), EXPECTED_REJECTION_REASONS)
  assert.equal(Object.isFrozen(reasons), true)
})

test('every rejected row records its closed-set reason and no request content', async () => {
  const { png } = palettePng()
  const validBody = JSON.stringify(chatBody(VISUAL_MODEL, imageMessages(png)))
  const twoImages = imageMessages(png)
  twoImages[0].content.push(twoImages[0].content[1])
  const fetchWith = (url, init) => h => h.fetch(url, init)
  const cases = [
    [
      'request form',
      h => h.fetch(new Request(PROVIDER_URL, { method: 'POST', body: validBody })),
      null,
      'provider-request-form-unsupported',
    ],
    [
      'GET method',
      fetchWith(PROVIDER_URL, { method: 'GET', headers: authHeaders(), body: validBody }),
      null,
      'provider-method-unsupported',
    ],
    [
      'query string',
      fetchWith(`${PROVIDER_URL}?x=1`, { method: 'POST', headers: authHeaders(), body: validBody }),
      null,
      'provider-path-not-captured',
    ],
    [
      'wrong key',
      fetchWith(PROVIDER_URL, {
        method: 'POST',
        headers: { authorization: 'Bearer not-the-run-key' },
        body: validBody,
      }),
      null,
      'provider-auth-mismatch',
    ],
    [
      'buffer body',
      fetchWith(PROVIDER_URL, {
        method: 'POST',
        headers: authHeaders(),
        body: Buffer.from(validBody),
      }),
      null,
      'provider-body-unsupported',
    ],
    [
      'invalid json',
      fetchWith(PROVIDER_URL, { method: 'POST', headers: authHeaders(), body: '{' }),
      null,
      'provider-body-invalid',
    ],
    [
      'unknown model',
      h => call(h, chatBody('glm-5.2', textMessages())),
      'glm-5.2',
      'unsupported-model',
    ],
    [
      'text model with an image',
      h => call(h, chatBody(TEXT_MODEL, imageMessages(png))),
      TEXT_MODEL,
      'text-model-image-incompatible',
    ],
    [
      'two image parts',
      h => call(h, chatBody(VISUAL_MODEL, twoImages)),
      VISUAL_MODEL,
      'image-part-count',
    ],
    [
      'streamed document turn',
      h =>
        call(
          h,
          chatBody(VISUAL_MODEL, [documentUserMessage()], {
            tools: [readToolDefinition],
            stream: true,
          })
        ),
      VISUAL_MODEL,
      'document-stream-unsupported',
    ],
    [
      'unreadable tool result',
      h =>
        call(
          h,
          chatBody(
            VISUAL_MODEL,
            documentAnswerMessages(wrappedToolOutput({ error: 'attachment_not_found' })),
            { tools: [readToolDefinition] }
          )
        ),
      VISUAL_MODEL,
      'document-tool-output-unreadable',
    ],
  ]
  for (const [label, send, model, reason] of cases) {
    const h = harness()
    const response = await send(h)
    assert.ok(response.status >= 400, label)
    const evidence = h.getEvidence()
    assert.equal(evidence.counters.rejectedAttempts, 1, label)
    // The row carries the fixed reason string and nothing from the request.
    assert.deepEqual(
      evidence.attempts,
      [{ model, imageSha256: null, responseKind: 'rejected', reason }],
      label
    )
    assert.ok(EXPECTED_REJECTION_REASONS.includes(reason), label)
  }

  // Accepted rows never carry a reason; witness: the accepted row exists.
  const accepted = harness()
  assert.equal((await call(accepted, chatBody(VISUAL_MODEL, textMessages()))).status, 200)
  assert.equal(accepted.getEvidence().attempts.length, 1)
  assert.equal(accepted.getEvidence().attempts[0].responseKind, 'text-only')
  assert.equal(Object.hasOwn(accepted.getEvidence().attempts[0], 'reason'), false)
})

// ---------------------------------------------------------------------------
// Legacy processing-lease restart journey (issue #1022): the fixture scripts
// shell_exec, then clerum__gfs_download, then answers from the receipt.
// ---------------------------------------------------------------------------

const LEGACY_MARKER = 'legacy-lease-0123456789abcdef'
const LEGACY_RESOURCE = 'a'.repeat(32)
const LEGACY_SHA = 'b'.repeat(64)
const LEGACY_TOKEN = `${LEGACY_MARKER}-shell-ok`

const toolDefinition = name => ({
  type: 'function',
  function: { name, description: name, parameters: { type: 'object' } },
})
const LEGACY_TOOLS = [toolDefinition('shell_exec'), toolDefinition('clerum__gfs_download')]

function legacyUserMessage(marker = LEGACY_MARKER) {
  return {
    role: 'user',
    content:
      '<turn-context>\ndate: 2026-10-08\n</turn-context>\n\n' +
      `Run the journey. LEGACY_LEASE_JOURNEY marker=${marker} drive=main resourceId=${LEGACY_RESOURCE}`,
  }
}

function legacyMessages(results) {
  const messages = [legacyUserMessage()]
  for (const [index, [name, content]] of results.entries()) {
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: `call-${index}`, type: 'function', function: { name, arguments: '{}' } }],
    })
    messages.push({ role: 'tool', tool_call_id: `call-${index}`, content })
  }
  return messages
}

const wrapped = (name, content) =>
  `<tool_output name="${name}" sanitized="false">\n${content}\n</tool_output>`
const shellResult = content => ['shell_exec', wrapped('shell_exec', content)]
const downloadResult = content => ['clerum__gfs_download', wrapped('clerum__gfs_download', content)]
const receipt = (overrides = {}) =>
  JSON.stringify({
    delivery: 'workspace_file',
    id: '11111111-2222-4333-8444-555555555555',
    path: '.gfs-downloads/input-1/report.pdf',
    sizeBytes: 42,
    sha256: LEGACY_SHA,
    ...overrides,
  })

test('legacy-lease step 1: asks for a shell command whose output token is not in the command', async () => {
  const h = harness()
  const response = await call(
    h,
    chatBody(VISUAL_MODEL, [legacyUserMessage()], { tools: LEGACY_TOOLS })
  )
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.choices[0].finish_reason, 'tool_calls')
  const [toolCall] = body.choices[0].message.tool_calls
  assert.equal(toolCall.function.name, 'shell_exec')
  const { command } = JSON.parse(toolCall.function.arguments)
  // The approval preview shows the marker, but only an executed command can
  // produce the joined token.
  assert.ok(command.includes(LEGACY_MARKER))
  assert.equal(command.includes(LEGACY_TOKEN), false)
  assert.equal(command, `printf '%s-shell-ok\\n' ${LEGACY_MARKER}`)
  const evidence = h.getEvidence()
  assert.equal(evidence.counters.legacyLeaseShellRequests, 1)
  assert.deepEqual(evidence.attempts, [
    { model: VISUAL_MODEL, imageSha256: null, responseKind: 'legacy-lease-shell-requested' },
  ])
})

test('legacy-lease step 2: a shell result with the token asks for the GFS download', async () => {
  const h = harness()
  const response = await call(
    h,
    chatBody(VISUAL_MODEL, legacyMessages([shellResult(`${LEGACY_TOKEN}\n`)]), {
      tools: LEGACY_TOOLS,
    })
  )
  const body = await response.json()
  const [toolCall] = body.choices[0].message.tool_calls
  assert.equal(toolCall.function.name, 'clerum__gfs_download')
  assert.deepEqual(JSON.parse(toolCall.function.arguments), {
    drive: 'main',
    resourceId: LEGACY_RESOURCE,
  })
  assert.equal(h.getEvidence().counters.legacyLeaseDownloadRequests, 1)
  assert.equal(h.getEvidence().attempts[0].responseKind, 'legacy-lease-download-requested')
})

test('legacy-lease step 2: a lease failure before command start is answered with its store code', async () => {
  const h = harness()
  const response = await call(
    h,
    chatBody(
      VISUAL_MODEL,
      legacyMessages([
        shellResult(
          'Processing lease failed before command start: GFS download store failed (download_busy)'
        ),
      ]),
      { tools: LEGACY_TOOLS }
    )
  )
  const body = await response.json()
  assert.equal(body.choices[0].finish_reason, 'stop')
  assert.equal(
    body.choices[0].message.content,
    'LEGACY-LEASE-FIXTURE-SHELL-FAILED code=download_busy'
  )
  const evidence = h.getEvidence()
  assert.equal(evidence.counters.legacyLeaseFailures, 1)
  assert.equal(evidence.counters.legacyLeaseDownloadRequests, 0)
  assert.deepEqual(evidence.attempts, [
    {
      model: VISUAL_MODEL,
      imageSha256: null,
      responseKind: 'legacy-lease-shell-failed',
      failureCode: 'download_busy',
    },
  ])
})

test('legacy-lease step 2: output without the token or a known code is unrecognized, never a download', async () => {
  for (const content of [
    // The command echoed back is not the token.
    `printf '%s-shell-ok\\n' ${LEGACY_MARKER}`,
    'GFS download store failed (not_a_store_code)',
    `${LEGACY_TOKEN}-extra`,
  ]) {
    const h = harness()
    const response = await call(
      h,
      chatBody(VISUAL_MODEL, legacyMessages([shellResult(content)]), { tools: LEGACY_TOOLS })
    )
    const body = await response.json()
    assert.equal(
      body.choices[0].message.content,
      'LEGACY-LEASE-FIXTURE-SHELL-FAILED code=unrecognized',
      content
    )
    assert.equal(h.getEvidence().counters.legacyLeaseDownloadRequests, 0, content)
  }
})

test('legacy-lease step 3: the answer carries the receipt sha256 and byte count', async () => {
  const h = harness()
  const response = await call(
    h,
    chatBody(VISUAL_MODEL, legacyMessages([shellResult(LEGACY_TOKEN), downloadResult(receipt())]), {
      tools: LEGACY_TOOLS,
    })
  )
  const body = await response.json()
  assert.equal(
    body.choices[0].message.content,
    `LEGACY-LEASE-FIXTURE-OK marker=${LEGACY_MARKER} sha256=${LEGACY_SHA} bytes=42`
  )
  const evidence = h.getEvidence()
  assert.equal(evidence.counters.legacyLeaseAnswers, 1)
  assert.deepEqual(evidence.attempts, [
    {
      model: VISUAL_MODEL,
      imageSha256: null,
      responseKind: 'legacy-lease-answer',
      downloadSha256: LEGACY_SHA,
      downloadBytes: 42,
    },
  ])
})

test('legacy-lease step 3: a different receipt gives a different answer (not a constant)', async () => {
  const other = 'c'.repeat(64)
  const h = harness()
  const response = await call(
    h,
    chatBody(
      VISUAL_MODEL,
      legacyMessages([
        shellResult(LEGACY_TOKEN),
        downloadResult(receipt({ sha256: other, sizeBytes: 7 })),
      ]),
      { tools: LEGACY_TOOLS }
    )
  )
  const body = await response.json()
  assert.equal(
    body.choices[0].message.content,
    `LEGACY-LEASE-FIXTURE-OK marker=${LEGACY_MARKER} sha256=${other} bytes=7`
  )
})

test('legacy-lease step 3: a download error is answered with its store code', async () => {
  const h = harness()
  const response = await call(
    h,
    chatBody(
      VISUAL_MODEL,
      legacyMessages([
        shellResult(LEGACY_TOKEN),
        downloadResult('Error: GFS download store failed (workspace_unavailable)'),
      ]),
      { tools: LEGACY_TOOLS }
    )
  )
  const body = await response.json()
  assert.equal(
    body.choices[0].message.content,
    'LEGACY-LEASE-FIXTURE-DOWNLOAD-FAILED code=workspace_unavailable'
  )
  assert.deepEqual(h.getEvidence().attempts, [
    {
      model: VISUAL_MODEL,
      imageSha256: null,
      responseKind: 'legacy-lease-download-failed',
      failureCode: 'workspace_unavailable',
    },
  ])
})

test('legacy-lease turns the fixture cannot use are refused with a closed-set reason', async () => {
  const cases = [
    [
      'shell not offered',
      chatBody(VISUAL_MODEL, [legacyUserMessage()], {
        tools: [toolDefinition('clerum__gfs_download')],
      }),
      'legacy-lease-shell-not-offered',
    ],
    [
      'download not offered',
      chatBody(VISUAL_MODEL, legacyMessages([shellResult(LEGACY_TOKEN)]), {
        tools: [toolDefinition('shell_exec')],
      }),
      'legacy-lease-download-not-offered',
    ],
    [
      'first result from another tool',
      chatBody(VISUAL_MODEL, legacyMessages([downloadResult(receipt())]), { tools: LEGACY_TOOLS }),
      'legacy-lease-tool-result-unexpected',
    ],
    [
      'three results',
      chatBody(
        VISUAL_MODEL,
        legacyMessages([
          shellResult(LEGACY_TOKEN),
          downloadResult(receipt()),
          downloadResult(receipt()),
        ]),
        { tools: LEGACY_TOOLS }
      ),
      'legacy-lease-tool-result-count',
    ],
    [
      'receipt without sha256',
      chatBody(
        VISUAL_MODEL,
        legacyMessages([shellResult(LEGACY_TOKEN), downloadResult(receipt({ sha256: 'x' }))]),
        { tools: LEGACY_TOOLS }
      ),
      'legacy-lease-download-result-malformed',
    ],
    [
      'streamed turn',
      chatBody(VISUAL_MODEL, [legacyUserMessage()], { tools: LEGACY_TOOLS, stream: true }),
      'legacy-lease-stream-unsupported',
    ],
  ]
  for (const [label, body, reason] of cases) {
    const h = harness()
    const response = await call(h, body)
    assert.ok(response.status >= 400, label)
    const evidence = h.getEvidence()
    assert.equal(evidence.counters.legacyLeaseFailures, 1, label)
    assert.deepEqual(
      evidence.attempts,
      [{ model: VISUAL_MODEL, imageSha256: null, responseKind: 'rejected', reason }],
      label
    )
  }
})

test('legacy-lease: a journey line without offered tools is an ordinary text-only request', async () => {
  const h = harness()
  const response = await call(h, chatBody(VISUAL_MODEL, [legacyUserMessage()]))
  const body = await response.json()
  assert.equal(body.choices[0].message.content, TEXT_ONLY_CONTENT)
  // Witness: the request reached the fixture and was answered as text.
  assert.equal(h.getEvidence().counters.textOnlyResponses, 1)
  assert.equal(h.getEvidence().counters.legacyLeaseShellRequests, 0)
})

test('legacy-lease failure codes are a frozen closed set that includes download_busy', () => {
  const codes = providerModule.LEGACY_LEASE_FAILURE_CODES
  assert.equal(Object.isFrozen(codes), true)
  assert.ok(codes.includes('download_busy'))
  assert.ok(codes.includes('unrecognized'))
})
