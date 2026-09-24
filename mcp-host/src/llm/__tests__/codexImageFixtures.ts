import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const { declaredHeaderPng } = createRequire(join(__dirname, 'codexImageFixtures.ts'))(
  '../../../../packages/llm-provider-attempt-contract/testImageFixtures.cjs'
) as { declaredHeaderPng: (width: number, height: number) => Buffer }

// Shared, independently decoded 2x2 fixtures; structural acceptance alone
// does not prove that a header-only substitute actually decodes.
const fixtures = JSON.parse(
  readFileSync(
    join(
      __dirname,
      '../../../../packages/llm-provider-attempt-contract/fixtures/visual-requests.json'
    ),
    'utf8'
  )
)
const imageData = (format: 'png' | 'jpeg'): string => {
  const part = fixtures[format].messages[0].contentParts.find(
    (entry: { type: string }) => entry.type === 'image'
  )
  if (!part?.data) throw new Error(`Missing ${format} image fixture`)
  return part.data
}

export const PNG_2X2_BASE64 = imageData('png')
export const JPEG_2X2_BASE64 = imageData('jpeg')
export const PNG_OVER_DIMENSION_BASE64 = declaredHeaderPng(3000, 3000).toString('base64')
