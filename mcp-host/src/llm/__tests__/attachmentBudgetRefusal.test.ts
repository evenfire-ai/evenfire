import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  LIMITS as GROK_LIMITS,
  GROK_VISUAL_LIMITS,
  hashCanonicalGrokRequest,
} from '@clerum/grok-provider-attempt-contract'
import {
  LIMITS as CODEX_LIMITS,
  VISUAL_LIMITS as CODEX_VISUAL_LIMITS,
  hashCanonicalCodexRequest,
} from '@clerum/llm-provider-attempt-contract'
import {
  attachmentBudgetRefusalMessageFor,
  buildAttachmentBudgetRefusals,
} from '../attachmentBudgetRefusal'
import { attachmentBudgetRefusalMessage } from '../codexSubscription'
import { PNG_OVER_DIMENSION_BASE64, pngOfDecodedBytesBase64 } from './codexImageFixtures'
import { grokPngOfDecodedBytesBase64 } from './grokImageFixtures'

// #784: the R9-11 refusal table, built from a provider's own limits.

const GROK_TABLE = buildAttachmentBudgetRefusals({
  maxImageBytes: GROK_VISUAL_LIMITS.maxImageBytes,
  maxTotalImageBytes: GROK_VISUAL_LIMITS.maxTotalImageBytes,
  maxVisualRequestBodyBytes: GROK_LIMITS.maxVisualRequestBodyBytes,
})
const CODEX_TABLE = buildAttachmentBudgetRefusals({
  maxImageBytes: CODEX_VISUAL_LIMITS.maxImageBytes,
  maxTotalImageBytes: CODEX_VISUAL_LIMITS.maxTotalImageBytes,
  maxVisualRequestBodyBytes: CODEX_LIMITS.maxVisualRequestBodyBytes,
  maxImageDimension: CODEX_VISUAL_LIMITS.maxImageDimension,
  maxImagePixels: CODEX_VISUAL_LIMITS.maxImagePixels,
})

// Every refusal message below is produced by the contract itself, from its
// valid V2 PNG fixture with one field changed, so a reworded contract message
// breaks this suite instead of leaving the table matching a stale copy.
type TextPart = { type: 'text'; text: string }
type ImagePart = { type: 'image'; data: string }
type FixtureRequest = {
  schemaVersion: string
  messages: Array<{ role: string; content: string; contentParts: Array<TextPart | ImagePart> }>
}

const fixtureRequest = (contractPackage: string): FixtureRequest =>
  JSON.parse(
    readFileSync(
      join(__dirname, `../../../../packages/${contractPackage}/fixtures/visual-requests.json`),
      'utf8'
    )
  ).png

const refusalFrom =
  (contractPackage: string, hash: (raw: unknown) => { ok: boolean; message?: string }) =>
  (change: (request: FixtureRequest) => void): string => {
    const request = fixtureRequest(contractPackage)
    change(request)
    const result = hash(request)
    if (result.ok || typeof result.message !== 'string') {
      throw new Error(`the ${contractPackage} contract accepted a request built to be refused`)
    }
    return result.message
  }

const grokRefusal = refusalFrom('grok-provider-attempt-contract', hashCanonicalGrokRequest)
const codexRefusal = refusalFrom('llm-provider-attempt-contract', hashCanonicalCodexRequest)

const imageParts = (request: FixtureRequest): ImagePart[] =>
  request.messages[0].contentParts.filter((part): part is ImagePart => part.type === 'image')

/** Replaces the fixture image with one image per entry of `data`. */
const withImages =
  (...data: string[]) =>
  (request: FixtureRequest): void => {
    const [image] = imageParts(request)
    const text = request.messages[0].contentParts.filter(part => part.type === 'text')
    request.messages[0].contentParts = [...text, ...data.map(entry => ({ ...image, data: entry }))]
  }

/** Pads the single text part, and `content` with it, by `bytes` ASCII bytes. */
const withTextPadding =
  (bytes: number) =>
  (request: FixtureRequest): void => {
    const message = request.messages[0]
    const text = message.contentParts.find((part): part is TextPart => part.type === 'text')
    if (!text) throw new Error('the fixture has no text part')
    text.text += 'x'.repeat(bytes)
    message.content = text.text
  }

/** Pads the image data. The whole-body ceiling is measured before any image is decoded. */
const withImageDataPadding =
  (bytes: number) =>
  (request: FixtureRequest): void => {
    imageParts(request)[0].data += 'A'.repeat(bytes)
  }

const GROK = {
  perImage: grokRefusal(
    withImages(grokPngOfDecodedBytesBase64(GROK_VISUAL_LIMITS.maxImageBytes + 1))
  ),
  total: grokRefusal(
    withImages(
      grokPngOfDecodedBytesBase64(GROK_VISUAL_LIMITS.maxTotalImageBytes / 2 + 1),
      grokPngOfDecodedBytesBase64(GROK_VISUAL_LIMITS.maxTotalImageBytes / 2 + 1)
    )
  ),
  visualBody: grokRefusal(withImageDataPadding(GROK_LIMITS.maxVisualRequestBodyBytes)),
  outsideImageData: grokRefusal(withTextPadding(GROK_LIMITS.maxRequestBodyBytes)),
  v1Body: grokRefusal(request => {
    request.schemaVersion = 'grok-completion-request.v1'
    request.messages = [
      { role: 'user', content: 'x'.repeat(GROK_LIMITS.maxRequestBodyBytes) },
    ] as FixtureRequest['messages']
  }),
}

const CODEX = {
  perImage: codexRefusal(
    withImages(pngOfDecodedBytesBase64(CODEX_VISUAL_LIMITS.maxImageBytes + 1))
  ),
  dimension: codexRefusal(withImages(PNG_OVER_DIMENSION_BASE64)),
  total: codexRefusal(
    withImages(
      pngOfDecodedBytesBase64(CODEX_VISUAL_LIMITS.maxTotalImageBytes / 2 + 1),
      pngOfDecodedBytesBase64(CODEX_VISUAL_LIMITS.maxTotalImageBytes / 2 + 1)
    )
  ),
  visualBody: codexRefusal(withImageDataPadding(CODEX_LIMITS.maxVisualRequestBodyBytes)),
  outsideImageData: codexRefusal(withTextPadding(CODEX_LIMITS.maxRequestBodyBytes)),
}

// The one message no request can produce today: Codex `maxImagePixels` equals
// `maxImageDimension` squared and the dimension check runs first, so the
// contract's pixel refusal is unreachable through `hashCanonicalCodexRequest`.
// Its wording is read from the contract source, not copied: the template is
// located in `visualPayload.cjs` and filled with the real limit, so a reworded
// contract message stops this suite at load instead of leaving a stale copy.
const codexPixelTemplate = /`(image pixel count exceeds \$\{VISUAL_LIMITS\.maxImagePixels\})`/.exec(
  readFileSync(
    join(__dirname, '../../../../packages/llm-provider-attempt-contract/visualPayload.cjs'),
    'utf8'
  )
)
if (!codexPixelTemplate) {
  throw new Error('the Codex contract no longer has an image pixel count refusal')
}
const CODEX_PIXELS = `messages[0].contentParts[1]: ${codexPixelTemplate[1].replace(
  /\$\{VISUAL_LIMITS\.maxImagePixels\}/,
  String(CODEX_VISUAL_LIMITS.maxImagePixels)
)}`

/**
 * Every row of `table` matches exactly one of the contract's image refusal
 * `messages`, and every message matches exactly one row, so a row cannot be
 * added, dropped or left matching nothing without this failing.
 */
function expectTableCoversExactly(
  table: ReadonlyArray<{ pattern: RegExp }>,
  messages: readonly string[]
): void {
  expect(messages.length).toBeGreaterThan(0)
  expect(table.length).toBe(messages.length)
  for (const message of messages) {
    expect(
      table.filter(row => row.pattern.test(message)),
      message
    ).toHaveLength(1)
  }
  for (const row of table) {
    expect(
      messages.filter(message => row.pattern.test(message)),
      String(row.pattern)
    ).toHaveLength(1)
  }
}

describe('attachmentBudgetRefusal (#784)', () => {
  it('names the Grok limits in the per-image, total and whole-body sentences', () => {
    expect(GROK_VISUAL_LIMITS.maxImageBytes).toBe(20971520)
    expect(GROK_VISUAL_LIMITS.maxTotalImageBytes).toBe(20971520)
    expect(GROK_LIMITS.maxVisualRequestBodyBytes).toBe(36700160)

    expect(attachmentBudgetRefusalMessageFor(GROK_TABLE, GROK.perImage, true)).toBe(
      'An attached image is too large: it exceeds 20 MiB. Reduce its size and send it again.'
    )
    expect(attachmentBudgetRefusalMessageFor(GROK_TABLE, GROK.total, true)).toBe(
      'The attached images are too large together: they exceed 20 MiB in total. Send fewer or smaller images.'
    )
    expect(attachmentBudgetRefusalMessageFor(GROK_TABLE, GROK.visualBody, true)).toBe(
      'The message and its attached images are too large together: they exceed 35 MiB. Send fewer or smaller images.'
    )
  })

  it('has no dimension or pixel rows for Grok, which has no such limit', () => {
    // Witness: the same messages are attachment refusals in a table built with
    // the limits, so the Grok `undefined` is the absence of the rows.
    expect(attachmentBudgetRefusalMessageFor(CODEX_TABLE, CODEX.dimension, true)).toBe(
      `An attached image is too large: its width or height exceeds ${CODEX_VISUAL_LIMITS.maxImageDimension} pixels. Resize it and send it again.`
    )
    expect(attachmentBudgetRefusalMessageFor(CODEX_TABLE, CODEX_PIXELS, true)).toBe(
      `An attached image is too large: it has more than ${CODEX_VISUAL_LIMITS.maxImagePixels.toLocaleString('en-US')} pixels. Resize it and send it again.`
    )
    expectTableCoversExactly(GROK_TABLE, [GROK.perImage, GROK.total, GROK.visualBody])
    expectTableCoversExactly(CODEX_TABLE, [
      CODEX.perImage,
      CODEX.dimension,
      CODEX_PIXELS,
      CODEX.total,
      CODEX.visualBody,
    ])
    expect(attachmentBudgetRefusalMessageFor(GROK_TABLE, CODEX.dimension, true)).toBeUndefined()
    expect(attachmentBudgetRefusalMessageFor(GROK_TABLE, CODEX_PIXELS, true)).toBeUndefined()
  })

  it('blames the whole-body ceiling on an attachment only when the request carries an image', () => {
    expect(attachmentBudgetRefusalMessageFor(GROK_TABLE, GROK.visualBody, true)).toBeDefined()
    expect(attachmentBudgetRefusalMessageFor(GROK_TABLE, GROK.visualBody, false)).toBeUndefined()
    // The per-image row does not depend on the flag: only an image can break it.
    expect(attachmentBudgetRefusalMessageFor(GROK_TABLE, GROK.perImage, false)).toBeDefined()
  })

  it('leaves conversation-volume refusals to the context-length taxonomy', () => {
    expect(
      attachmentBudgetRefusalMessageFor(GROK_TABLE, GROK.outsideImageData, true)
    ).toBeUndefined()
    expect(attachmentBudgetRefusalMessageFor(GROK_TABLE, GROK.v1Body, true)).toBeUndefined()
    // Witness: the same table maps an image refusal in the same call shape.
    expect(attachmentBudgetRefusalMessageFor(GROK_TABLE, GROK.total, true)).toBeDefined()
  })

  it('keeps the Codex export equal to the table built from the Codex limits', () => {
    const corpus: Array<[string, boolean]> = [
      [CODEX.perImage, true],
      [CODEX.dimension, true],
      [CODEX_PIXELS, true],
      [CODEX.total, true],
      [CODEX.visualBody, true],
      [CODEX.visualBody, false],
      [CODEX.outsideImageData, true],
    ]
    let mapped = 0
    for (const [message, carriesImage] of corpus) {
      const expected = attachmentBudgetRefusalMessageFor(CODEX_TABLE, message, carriesImage)
      if (expected !== undefined) mapped += 1
      expect(attachmentBudgetRefusalMessage(message, carriesImage)).toBe(expected)
    }
    // Five image refusals map; the text-only whole body and the non-image
    // share do not. A corpus that mapped nothing would prove nothing.
    expect(mapped).toBe(5)
  })
})
