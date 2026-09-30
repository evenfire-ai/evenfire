import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import test from 'node:test'
import { buildImageFixture } from '../../../../desktop-app/test/e2e-playwright/helpers/qaRecorderImageFixture.ts'
import { createImageFixtureFetch } from './provider.mjs'

// The pinned SDK reads `globalThis.fetch` once, when `openai/shims/web` first
// loads, so every test in this file shares one fixture and one key. Each test
// asserts only on the ledger rows it appended.
const IMAGE_CAPABILITIES_CREDENTIAL = randomBytes(32).toString('hex')
const fixture = createImageFixtureFetch(
  async () => {
    throw new Error('Unexpected network call')
  },
  {
    runId: 'image-capabilities-123456abcdef',
    credentialHash: createHash('sha256').update(IMAGE_CAPABILITIES_CREDENTIAL).digest('hex'),
  }
)
globalThis.fetch = fixture.fetch
const require = createRequire(new URL('../../../../mcp-host/package.json', import.meta.url))
require('openai/shims/web')

const appendedRows = before => fixture.getEvidence().attempts.slice(before)

// Uses the real compiled provider and pinned SDK. No outbound request is allowed.
test('the production ZAI serializer and pinned SDK reach the pixel fixture', async () => {
  const before = fixture.getEvidence().attempts.length
  const { OpenAICompatibleProvider } = require('./dist/llm/openaiCompatible.js')
  const provider = new OpenAICompatibleProvider(
    {
      id: 'zai',
      baseURL: 'https://api.z.ai/api/coding/paas/v4',
      defaultModel: 'glm-5.3-flash',
    },
    IMAGE_CAPABILITIES_CREDENTIAL,
    'glm-5.3-flash'
  )
  const image = buildImageFixture(654)
  const result = await provider.completeSingleTurnWithTools(
    [
      {
        role: 'user',
        content: 'Read the six tiles',
        contentParts: [
          { type: 'text', text: 'Read the six tiles' },
          { type: 'image', mimeType: 'image/png', data: image.png.toString('base64') },
        ],
      },
    ],
    []
  )
  assert.equal(result.content, image.orderedColors.join(', '))
  assert.deepEqual(appendedRows(before), [
    {
      model: 'glm-5.3-flash',
      responseKind: 'tile-colors',
      imageSha256: createHash('sha256').update(image.png).digest('hex'),
    },
  ])
})

// Issue #678: the same production serializer and pinned SDK, driven through the
// two turns of an attachment read. The turn-context block and the tool-result
// wrapper come from the compiled Host, so the fixture is proven against the
// format the Host really writes and not against a copy of it.
test('the production ZAI serializer and pinned SDK complete an attachment read against the fixture', async () => {
  const before = fixture.getEvidence().attempts.length
  const { OpenAICompatibleProvider } = require('./dist/llm/openaiCompatible.js')
  const { buildTurnContextBlock } = require('./dist/core/orchestration/turnContext.js')
  const { BasicSafety } = require('./dist/core/safety/safety.js')
  const provider = new OpenAICompatibleProvider(
    {
      id: 'zai',
      baseURL: 'https://api.z.ai/api/coding/paas/v4',
      defaultModel: 'glm-5.3-flash',
    },
    IMAGE_CAPABILITIES_CREDENTIAL,
    'glm-5.3-flash'
  )

  const attachmentId = 'att-11111111-2222-4333-8444-555555555555'
  const documentText = `sdk token ${randomBytes(6).toString('hex')}\nsecond line\n`
  const block = buildTurnContextBlock({
    date: new Date('2026-09-29T00:00:00.000Z'),
    channel: { type: 'desktop' },
    attachedFiles: [
      {
        attachmentId,
        name: 'notes.txt',
        class: 'text',
        byteLength: Buffer.byteLength(documentText),
        reader: 'text',
        mismatch: false,
        declaredMediaType: 'text/plain',
        detectedMediaType: 'text/plain',
      },
    ],
  })
  const tools = [
    {
      name: 'clerum__attachment_read',
      description: 'Read an attached file.',
      parameters: { type: 'object', properties: { attachmentId: { type: 'string' } } },
    },
  ]
  const user = { role: 'user', content: `${block}\n\nSummarize the attached file.` }

  const first = await provider.completeSingleTurnWithTools([user], tools)
  // The wire says `tool_calls`; the Host's `mapFinishReason` reports it as `tool_use`.
  assert.equal(first.finish_reason, 'tool_use')
  assert.equal(first.tool_calls?.length, 1)
  assert.equal(first.tool_calls[0].name, 'clerum__attachment_read')
  assert.deepEqual(first.tool_calls[0].arguments, { attachmentId })

  const toolOutput = new BasicSafety().wrapForLlm(
    'clerum__attachment_read',
    JSON.stringify({
      attachmentId,
      referenceId: 'ref-1',
      kind: 'text',
      byteRange: { offset: 0, length: Buffer.byteLength(documentText) },
      truncated: false,
      text: documentText,
    }),
    false
  )
  const second = await provider.completeSingleTurnWithTools(
    [
      user,
      { role: 'assistant', content: '', tool_calls: first.tool_calls },
      { role: 'tool', tool_call_id: first.tool_calls[0].id, content: toolOutput },
    ],
    tools
  )

  const digest = createHash('sha256').update(documentText, 'utf8').digest('hex')
  assert.equal(second.content, `DOCUMENT_FIXTURE_SHA256:${digest.slice(0, 16)}`)
  assert.deepEqual(appendedRows(before), [
    {
      model: 'glm-5.3-flash',
      imageSha256: null,
      responseKind: 'document-read-requested',
      documentSha256: null,
      documentByteLength: Buffer.byteLength(documentText),
    },
    {
      model: 'glm-5.3-flash',
      imageSha256: null,
      responseKind: 'document-answer',
      documentSha256: digest,
    },
  ])
})

// The Host appends ` mismatch=true[ declared=<quoted>] detected=<type>` to the
// attached_file line when the declared and detected media types disagree
// (turnContext.ts). The declared value is client-supplied, so it is quoted and
// may carry spaces and escaped quotes.
for (const declaredMediaType of ['text/plain', 'text/plain; charset="utf-8"']) {
  test(`the fixture asks to read a mismatched attachment declared as ${declaredMediaType}`, async () => {
    const before = fixture.getEvidence().attempts.length
    const { OpenAICompatibleProvider } = require('./dist/llm/openaiCompatible.js')
    const { buildTurnContextBlock } = require('./dist/core/orchestration/turnContext.js')
    const provider = new OpenAICompatibleProvider(
      {
        id: 'zai',
        baseURL: 'https://api.z.ai/api/coding/paas/v4',
        defaultModel: 'glm-5.3-flash',
      },
      IMAGE_CAPABILITIES_CREDENTIAL,
      'glm-5.3-flash'
    )

    const attachmentId = 'att-66666666-7777-4888-9999-000000000000'
    const byteLength = 4321
    const block = buildTurnContextBlock({
      date: new Date('2026-09-29T00:00:00.000Z'),
      channel: { type: 'desktop' },
      attachedFiles: [
        {
          attachmentId,
          name: 'report.txt',
          class: 'pdf',
          byteLength,
          reader: 'pdf',
          mismatch: true,
          declaredMediaType,
          detectedMediaType: 'application/pdf',
        },
      ],
    })
    // The Host really wrote the tail this case is about.
    assert.match(block, / mismatch=true declared="[^\n]*" detected=application\/pdf\n/)
    const tools = [
      {
        name: 'clerum__attachment_read',
        description: 'Read an attached file.',
        parameters: { type: 'object', properties: { attachmentId: { type: 'string' } } },
      },
    ]
    const user = { role: 'user', content: `${block}\n\nSummarize the attached file.` }

    const settled = await provider.completeSingleTurnWithTools([user], tools).then(
      value => ({ value }),
      error => ({ error })
    )

    assert.equal(settled.error?.message, undefined)
    assert.deepEqual(appendedRows(before), [
      {
        model: 'glm-5.3-flash',
        imageSha256: null,
        responseKind: 'document-read-requested',
        documentSha256: null,
        documentByteLength: byteLength,
      },
    ])
    assert.equal(settled.value.finish_reason, 'tool_use')
    assert.equal(settled.value.tool_calls?.length, 1)
    assert.deepEqual(settled.value.tool_calls[0].arguments, { attachmentId })
  })
}
