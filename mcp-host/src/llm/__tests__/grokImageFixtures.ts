import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

// The header-only PNG builders are test-only helpers of the Codex contract. The
// Grok contract tests reuse the same file by relative path, so both providers
// are exercised with identical bytes.
const { declaredHeaderPng, declaredHeaderPngOfSize } = createRequire(
  join(__dirname, 'grokImageFixtures.ts')
)('../../../../packages/llm-provider-attempt-contract/testImageFixtures.cjs') as {
  declaredHeaderPng: (width: number, height: number) => Buffer
  declaredHeaderPngOfSize: (targetBytes: number) => Buffer
}

// The Grok contract's own visual corpus: independently decoded 2x2 PNG and
// JPEG images, pinned by sha256 in the fixture.
const fixtures = JSON.parse(
  readFileSync(
    join(
      __dirname,
      '../../../../packages/grok-provider-attempt-contract/fixtures/visual-requests.json'
    ),
    'utf8'
  )
)
const imageData = (format: 'png' | 'jpeg'): string => {
  const part = fixtures[format].messages[0].contentParts.find(
    (entry: { type: string }) => entry.type === 'image'
  )
  if (!part?.data) throw new Error(`Missing Grok ${format} image fixture`)
  return part.data
}

export const GROK_PNG_2X2_BASE64 = imageData('png')
export const GROK_JPEG_2X2_BASE64 = imageData('jpeg')
/** A declared 9000x9000 PNG: over the Codex dimension limit, and Grok has none. */
export const GROK_PNG_9000_BASE64 = declaredHeaderPng(9000, 9000).toString('base64')
/** A structurally valid 2x2 PNG whose decoded length is exactly `decodedBytes`. */
export const grokPngOfDecodedBytesBase64 = (decodedBytes: number): string =>
  declaredHeaderPngOfSize(decodedBytes).toString('base64')
