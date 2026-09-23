import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import test from 'node:test'
import { buildImageFixture } from '../../../../desktop-app/test/e2e-playwright/helpers/qaRecorderImageFixture.ts'
import { createImageFixtureFetch } from './provider.mjs'

// Uses the real compiled provider and pinned SDK. No outbound request is allowed.
test('the production ZAI serializer and pinned SDK reach the pixel fixture', async () => {
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
  assert.deepEqual(fixture.getEvidence().attempts, [
    {
      model: 'glm-5.3-flash',
      responseKind: 'tile-colors',
      imageSha256: createHash('sha256').update(image.png).digest('hex'),
    },
  ])
})
