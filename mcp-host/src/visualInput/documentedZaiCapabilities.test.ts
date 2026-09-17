import { describe, expect, it } from 'vitest'
import {
  DOCUMENTED_ZAI_IMAGE_MODELS,
  OFFICIAL_ZAI_CODING_BASE_URL,
  ZAI_DOCUMENTED_EVIDENCE,
  ZAI_PROVIDER,
  getDocumentedZaiImageCapability,
} from './documentedZaiCapabilities'

const OFFICIAL = OFFICIAL_ZAI_CODING_BASE_URL
const DOCUMENTED_MODEL = 'glm-5.3-flash'

function expectSupported(model: string, baseURL: string | undefined): void {
  expect(getDocumentedZaiImageCapability(model, baseURL)).toEqual({
    status: 'supported',
    provider: 'zai',
    model,
    evidence: 'zai-documented-model-contract',
  })
}

function expectUnknown(model: string, baseURL: string | undefined = OFFICIAL): void {
  expect(getDocumentedZaiImageCapability(model, baseURL)).toEqual({ status: 'unknown' })
}

describe('getDocumentedZaiImageCapability', () => {
  it('reports the documented contract for every table entry', () => {
    expect(ZAI_PROVIDER).toBe('zai')
    expect(ZAI_DOCUMENTED_EVIDENCE).toBe('zai-documented-model-contract')
    expect(OFFICIAL_ZAI_CODING_BASE_URL).toBe('https://api.z.ai/api/coding/paas/v4')
    expect(DOCUMENTED_ZAI_IMAGE_MODELS.length).toBeGreaterThan(0)

    for (const entry of DOCUMENTED_ZAI_IMAGE_MODELS) {
      expectSupported(entry.id, OFFICIAL)
      expectSupported(entry.id, `${OFFICIAL}/`)
      expect(getDocumentedZaiImageCapability(entry.id, undefined)).toEqual({ status: 'unknown' })
    }
  })

  it('keeps unlisted GLM ids unknown on the official endpoint', () => {
    expectUnknown('glm-4.7')
    expectUnknown('glm-5.1')
    expectUnknown('glm-5.3')
    expectUnknown(`${DOCUMENTED_MODEL}-preview`)
  })

  it('does not infer support from whitespace, case, or family prefixes', () => {
    expectUnknown(`  ${DOCUMENTED_MODEL}`)
    expectUnknown(DOCUMENTED_MODEL.toUpperCase())
    expectUnknown(`zai/${DOCUMENTED_MODEL}`)
  })

  it('rejects any transport that is not the official Coding Plan endpoint', () => {
    expectUnknown(DOCUMENTED_MODEL, 'https://api.z.ai/api/paas/v4')
    expectUnknown(DOCUMENTED_MODEL, 'https://api.openai.com/v1')
    expectUnknown(DOCUMENTED_MODEL, 'http://api.z.ai/api/coding/paas/v4')
    expectUnknown(DOCUMENTED_MODEL, 'https://user:pass@api.z.ai/api/coding/paas/v4')
    expectUnknown(DOCUMENTED_MODEL, 'https://api.z.ai/api/coding/paas/v4?x=1')
    expectUnknown(DOCUMENTED_MODEL, 'https://api.z.ai/api/coding/paas/v4#frag')
    expectUnknown(DOCUMENTED_MODEL, 'not-a-url')
  })
})
