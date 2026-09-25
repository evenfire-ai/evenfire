import { describe, expect, it } from 'vitest'
import { LIMITS as GROK_LIMITS, GROK_VISUAL_LIMITS } from '@clerum/grok-provider-attempt-contract'
import {
  LIMITS as CODEX_LIMITS,
  VISUAL_LIMITS as CODEX_VISUAL_LIMITS,
} from '@clerum/llm-provider-attempt-contract'
import {
  attachmentBudgetRefusalMessageFor,
  buildAttachmentBudgetRefusals,
} from '../attachmentBudgetRefusal'
import { attachmentBudgetRefusalMessage } from '../codexSubscription'

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

// The contract messages, byte-identical across both contracts (G1).
const PER_IMAGE = (bytes: number) =>
  `messages[0].contentParts[1]: image exceeds ${bytes} decoded bytes`
const DIMENSION = (px: number) => `messages[0].contentParts[1]: image dimension exceeds ${px}`
const PIXELS = (count: number) => `messages[0].contentParts[1]: image pixel count exceeds ${count}`
const TOTAL = (bytes: number) => `request exceeds ${bytes} total image bytes`
const VISUAL_BODY = 'request exceeds maxVisualRequestBodyBytes'
const OUTSIDE_IMAGE_DATA = 'request exceeds maxRequestBodyBytes outside image data'

describe('attachmentBudgetRefusal (#784)', () => {
  it('names the Grok limits in the per-image, total and whole-body sentences', () => {
    expect(GROK_VISUAL_LIMITS.maxImageBytes).toBe(20971520)
    expect(GROK_VISUAL_LIMITS.maxTotalImageBytes).toBe(20971520)
    expect(GROK_LIMITS.maxVisualRequestBodyBytes).toBe(36700160)

    expect(
      attachmentBudgetRefusalMessageFor(
        GROK_TABLE,
        PER_IMAGE(GROK_VISUAL_LIMITS.maxImageBytes),
        true
      )
    ).toBe('An attached image is too large: it exceeds 20 MiB. Reduce its size and send it again.')
    expect(
      attachmentBudgetRefusalMessageFor(
        GROK_TABLE,
        TOTAL(GROK_VISUAL_LIMITS.maxTotalImageBytes),
        true
      )
    ).toBe(
      'The attached images are too large together: they exceed 20 MiB in total. Send fewer or smaller images.'
    )
    expect(attachmentBudgetRefusalMessageFor(GROK_TABLE, VISUAL_BODY, true)).toBe(
      'The message and its attached images are too large together: they exceed 35 MiB. Send fewer or smaller images.'
    )
  })

  it('has no dimension or pixel rows for Grok, which has no such limit', () => {
    // Witness: the same messages are attachment refusals in a table built with
    // the limits, so the Grok `undefined` is the absence of the rows.
    expect(
      attachmentBudgetRefusalMessageFor(
        CODEX_TABLE,
        DIMENSION(CODEX_VISUAL_LIMITS.maxImageDimension),
        true
      )
    ).toBe(
      `An attached image is too large: its width or height exceeds ${CODEX_VISUAL_LIMITS.maxImageDimension} pixels. Resize it and send it again.`
    )
    expect(
      attachmentBudgetRefusalMessageFor(
        CODEX_TABLE,
        PIXELS(CODEX_VISUAL_LIMITS.maxImagePixels),
        true
      )
    ).toBe(
      `An attached image is too large: it has more than ${CODEX_VISUAL_LIMITS.maxImagePixels.toLocaleString('en-US')} pixels. Resize it and send it again.`
    )
    expect(GROK_TABLE).toHaveLength(3)
    expect(CODEX_TABLE).toHaveLength(5)
    expect(
      attachmentBudgetRefusalMessageFor(
        GROK_TABLE,
        DIMENSION(CODEX_VISUAL_LIMITS.maxImageDimension),
        true
      )
    ).toBeUndefined()
    expect(
      attachmentBudgetRefusalMessageFor(
        GROK_TABLE,
        PIXELS(CODEX_VISUAL_LIMITS.maxImagePixels),
        true
      )
    ).toBeUndefined()
  })

  it('blames the whole-body ceiling on an attachment only when the request carries an image', () => {
    expect(attachmentBudgetRefusalMessageFor(GROK_TABLE, VISUAL_BODY, true)).toBeDefined()
    expect(attachmentBudgetRefusalMessageFor(GROK_TABLE, VISUAL_BODY, false)).toBeUndefined()
    // The per-image row does not depend on the flag: only an image can break it.
    expect(
      attachmentBudgetRefusalMessageFor(
        GROK_TABLE,
        PER_IMAGE(GROK_VISUAL_LIMITS.maxImageBytes),
        false
      )
    ).toBeDefined()
  })

  it('leaves conversation-volume refusals to the context-length taxonomy', () => {
    expect(attachmentBudgetRefusalMessageFor(GROK_TABLE, OUTSIDE_IMAGE_DATA, true)).toBeUndefined()
    expect(
      attachmentBudgetRefusalMessageFor(GROK_TABLE, 'request exceeds maxRequestBodyBytes', true)
    ).toBeUndefined()
    // Witness: the same table maps an image refusal in the same call shape.
    expect(
      attachmentBudgetRefusalMessageFor(
        GROK_TABLE,
        TOTAL(GROK_VISUAL_LIMITS.maxTotalImageBytes),
        true
      )
    ).toBeDefined()
  })

  it('keeps the Codex export equal to the table built from the Codex limits', () => {
    const corpus: Array<[string, boolean]> = [
      [PER_IMAGE(CODEX_VISUAL_LIMITS.maxImageBytes), true],
      [DIMENSION(CODEX_VISUAL_LIMITS.maxImageDimension), true],
      [PIXELS(CODEX_VISUAL_LIMITS.maxImagePixels), true],
      [TOTAL(CODEX_VISUAL_LIMITS.maxTotalImageBytes), true],
      [VISUAL_BODY, true],
      [VISUAL_BODY, false],
      [OUTSIDE_IMAGE_DATA, true],
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
