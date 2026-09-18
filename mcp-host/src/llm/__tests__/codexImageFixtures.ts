import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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
