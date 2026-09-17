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
    { model: TEXT_MODEL, imageSha256: null, responseKind: 'rejected' },
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
