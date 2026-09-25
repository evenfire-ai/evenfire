import { describe, expect, it } from 'vitest'
import {
  CODEX_COMPOSER_MAX_IMAGE_BYTES,
  CODEX_COMPOSER_MAX_IMAGE_DIMENSION,
  COMPOSER_MAX_IMAGE_BYTES,
  COMPOSER_MAX_TOTAL_IMAGE_BASE64_BYTES,
  composerImageBudget,
} from '../attachments'

const MIB = 1024 * 1024

describe('composerImageBudget', () => {
  it('gives grok-subscription the shared ingress cap with no dimension bound (#784)', () => {
    const budget = composerImageBudget('grok-subscription')
    expect(budget).toEqual({
      maxImageBytes: 16777216,
      total: {
        maxBase64Bytes: 22369624,
        labelBytes: 16777216,
      },
      maxDimension: null,
      sizeUnit: 'MiB',
    })
    // 16 MiB decoded, expressed as base64: the total rpc-proxy and mcp-host
    // accept for one message, not the 20 MiB xAI allows per image.
    expect(budget.maxImageBytes).toBe(16 * MIB)
    expect(budget.total?.maxBase64Bytes).toBe(4 * Math.ceil((16 * MIB) / 3))
    // The copy names the decoded total (16 MiB), not the base64 bytes the
    // picker counts (which would round to "21 MiB").
    expect(budget.total?.labelBytes).toBe(16 * MIB)
    expect(15 * MIB).toBeLessThanOrEqual(budget.maxImageBytes)
    expect(17 * MIB).toBeGreaterThan(budget.maxImageBytes)
  })

  it('keeps the Codex budget unchanged', () => {
    expect(composerImageBudget('codex-subscription')).toEqual({
      maxImageBytes: CODEX_COMPOSER_MAX_IMAGE_BYTES,
      total: null,
      maxDimension: CODEX_COMPOSER_MAX_IMAGE_DIMENSION,
      sizeUnit: 'MiB',
    })
    expect(CODEX_COMPOSER_MAX_IMAGE_BYTES).toBe(16 * MIB)
    expect(CODEX_COMPOSER_MAX_IMAGE_DIMENSION).toBe(2048)
  })

  it.each([undefined, null, 'anthropic', 'openai'])(
    'keeps the general budget for provider %s',
    provider => {
      expect(composerImageBudget(provider)).toEqual({
        maxImageBytes: COMPOSER_MAX_IMAGE_BYTES,
        total: {
          maxBase64Bytes: COMPOSER_MAX_TOTAL_IMAGE_BASE64_BYTES,
          labelBytes: COMPOSER_MAX_TOTAL_IMAGE_BASE64_BYTES,
        },
        maxDimension: null,
        sizeUnit: 'MB',
      })
      expect(COMPOSER_MAX_IMAGE_BYTES).toBe(3 * MIB)
      expect(COMPOSER_MAX_TOTAL_IMAGE_BASE64_BYTES).toBe(8 * MIB)
    }
  )
})
