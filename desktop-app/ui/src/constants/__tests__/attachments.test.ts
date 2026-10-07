import { describe, expect, it } from 'vitest'
import {
  CODEX_COMPOSER_MAX_IMAGE_BYTES,
  CODEX_COMPOSER_MAX_IMAGE_DIMENSION,
  CODEX_COMPOSER_MAX_TOTAL_IMAGE_DECODED_BYTES,
  COMPOSER_MAX_IMAGE_BYTES,
  COMPOSER_MAX_TOTAL_IMAGE_BASE64_BYTES,
  composerImageBudget,
  composerImageCountedBytes,
} from '../attachments'

const MIB = 1024 * 1024

describe('composerImageBudget', () => {
  it('gives grok-subscription the shared ingress cap with no dimension bound (#784)', () => {
    const budget = composerImageBudget('grok-subscription')
    expect(budget).toEqual({
      maxImageBytes: 16777216,
      total: {
        counts: 'decoded',
        maxBytes: 16777216,
        labelBytes: 16777216,
      },
      maxDimension: null,
      sizeUnit: 'MiB',
    })
    // The total is the decoded 16 MiB that rpc-proxy and mcp-host accept for
    // one message, not the 20 MiB xAI allows per image. The composer sums the
    // decoded `sizeBytes` of each image, so the check matches the ingress to
    // the byte.
    expect(budget.maxImageBytes).toBe(16 * MIB)
    expect(budget.total?.maxBytes).toBe(16 * MIB)
    expect(budget.total?.labelBytes).toBe(16 * MIB)
    expect(15 * MIB).toBeLessThanOrEqual(budget.maxImageBytes)
    expect(17 * MIB).toBeGreaterThan(budget.maxImageBytes)
  })

  it('holds Codex to the decoded 16 MiB image total that rpc-proxy and mcp-host enforce', () => {
    expect(composerImageBudget('codex-subscription')).toEqual({
      maxImageBytes: CODEX_COMPOSER_MAX_IMAGE_BYTES,
      total: {
        counts: 'decoded',
        maxBytes: CODEX_COMPOSER_MAX_TOTAL_IMAGE_DECODED_BYTES,
        labelBytes: CODEX_COMPOSER_MAX_TOTAL_IMAGE_DECODED_BYTES,
      },
      maxDimension: CODEX_COMPOSER_MAX_IMAGE_DIMENSION,
      sizeUnit: 'MiB',
    })
    expect(CODEX_COMPOSER_MAX_IMAGE_BYTES).toBe(16 * MIB)
    expect(CODEX_COMPOSER_MAX_TOTAL_IMAGE_DECODED_BYTES).toBe(16 * MIB)
    expect(CODEX_COMPOSER_MAX_IMAGE_DIMENSION).toBe(2048)
  })

  it.each([undefined, null, 'anthropic', 'openai'])(
    'keeps the general budget for provider %s',
    provider => {
      expect(composerImageBudget(provider)).toEqual({
        maxImageBytes: COMPOSER_MAX_IMAGE_BYTES,
        total: {
          counts: 'base64',
          maxBytes: COMPOSER_MAX_TOTAL_IMAGE_BASE64_BYTES,
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

describe('composerImageCountedBytes', () => {
  // 5 base64 characters decode to 3 bytes or fewer, so the two units differ.
  const attachment = { dataBase64: 'AAAAA', sizeBytes: 3 }

  it('counts decoded bytes for a decoded total', () => {
    const total = composerImageBudget('grok-subscription').total
    expect(total).not.toBeNull()
    expect(composerImageCountedBytes(total!, attachment)).toBe(3)
  })

  it('counts base64 characters for a base64 total', () => {
    const total = composerImageBudget('anthropic').total
    expect(total).not.toBeNull()
    expect(composerImageCountedBytes(total!, attachment)).toBe(5)
  })
})
