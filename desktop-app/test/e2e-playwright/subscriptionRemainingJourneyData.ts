// E2E_GUARDIAN_IPC_FLOW: read-only fixture preparation evidence, never auth/chat/tool execution.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { decodeTileChallenge, requirePixelRenderer } from './subscriptionImageChallenge.js'
import type { SubscriptionImageRun } from './subscriptionImageRunContract.js'
import {
  type FixtureReceipt,
  type JourneyInput,
  validateRemainingFixture,
} from './subscriptionRemainingJourneysContract.js'

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

function privateBytes(filename: string, maxBytes: number): Buffer {
  if (fs.realpathSync(path.dirname(filename)) !== path.dirname(filename))
    throw new Error('Fixture parent must not be a symlink')
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const stat = fs.fstatSync(fd)
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size < 1 ||
      stat.size > maxBytes
    ) {
      throw new Error('Fixture data must be bounded, private and physically owned')
    }
    return fs.readFileSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

export function readRemainingFixture(
  input: JourneyInput,
  run: SubscriptionImageRun
): FixtureReceipt {
  const sourcePath = path.resolve(__dirname, '../../../subscription-image-source.json')
  const sourceManifestSha256 = digest(fs.readFileSync(sourcePath))
  return validateRemainingFixture(
    JSON.parse(privateBytes(input.fixtureReceiptPath, 64 * 1024).toString('utf8')),
    input,
    run,
    sourceManifestSha256
  )
}

/** Only the test decodes its prepared fixture bytes; no answer crosses to the vendor fixture. */
export async function preparedPixelCode(
  run: SubscriptionImageRun,
  fixture: { fixtureImagePath: string; imageSha256: string; sizeBytes?: number }
): Promise<string> {
  const bytes = privateBytes(fixture.fixtureImagePath, 3 * 1024 * 1024)
  if (
    digest(bytes) !== fixture.imageSha256 ||
    (fixture.sizeBytes !== undefined && bytes.length !== fixture.sizeBytes)
  ) {
    throw new Error('Prepared native image bytes changed before the journey')
  }
  const native = requirePixelRenderer() as {
    loadImage: (bytes: Buffer) => Promise<{ width: number; height: number }>
  }
  const image = await native.loadImage(bytes)
  if (image.width !== 512 || image.height !== 512)
    throw new Error('Prepared challenge must have actual 512x512 decoded pixels')
  if (run.mode === 'fixture') return decodeTileChallenge(bytes)
  // G8 uses text rendered in actual pixels. Main seals its independently generated
  // 64-bit challenge as a private sidecar, never a name, provider prompt or config.
  const oracle = JSON.parse(
    privateBytes(`${fixture.fixtureImagePath}.oracle.json`, 1024).toString('utf8')
  ) as {
    kind?: string
    runId?: string
    imageSha256?: string
    code?: string
  }
  if (
    oracle.kind !== 'evenfire-subscription-live-pixel-oracle-v1' ||
    oracle.runId !== run.runId ||
    oracle.imageSha256 !== fixture.imageSha256 ||
    typeof oracle.code !== 'string' ||
    !/^[A-F0-9]{16}$/.test(oracle.code)
  ) {
    throw new Error('G8 requires the independently rendered pixel oracle for this image and run')
  }
  return oracle.code
}
