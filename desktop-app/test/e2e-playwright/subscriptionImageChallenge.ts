// E2E_GUARDIAN_IPC_FLOW: test-only pixels used by Desktop IPC journeys and the external vendor decoder.
import { createRequire } from 'node:module'

const codec = createRequire(__filename)(
  '../../../scripts/e2e/fixtures/subscription-image-challenge.cjs'
) as {
  requirePixelRenderer: () => unknown
  tileChallengeImage: (
    format: 'png' | 'jpeg',
    options: { requirePixels: true }
  ) => {
    code: string
    bytes: Buffer
    width: number
    height: number
  }
  decodeTileChallenge: (bytes: Buffer) => Promise<string>
}
export const requirePixelRenderer = codec.requirePixelRenderer
export const tileChallengeImage = codec.tileChallengeImage
export const decodeTileChallenge = codec.decodeTileChallenge
