import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { tileChallengeImage } from './e2e-playwright/subscriptionImageChallenge.js'
import type { SubscriptionImageRun } from './e2e-playwright/subscriptionImageRunContract.js'
import { preparedPixelCode } from './e2e-playwright/subscriptionRemainingJourneyData.js'

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
let root: string
beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evenfire-remaining-pixels-unit-')))
  fs.chmodSync(root, 0o700)
})
afterEach(() => {
  for (const name of fs.readdirSync(root)) fs.unlinkSync(path.join(root, name))
})
afterAll(() => {
  fs.rmdirSync(root)
})
// Only the codec/file-admission boundary is exercised here. No Host, account,
// provider or E2E runtime is fabricated by these unit-only run coordinates.
const run = { mode: 'fixture', runId: 'subscription-image-123456789abc' } as SubscriptionImageRun
function image(format: 'png' | 'jpeg' = 'png') {
  const visual = tileChallengeImage(format, { requirePixels: true })
  const fixtureImagePath = path.join(root, `native.${format}`)
  fs.writeFileSync(fixtureImagePath, visual.bytes, { mode: 0o600 })
  return {
    visual,
    fixture: {
      fixtureImagePath,
      imageSha256: digest(visual.bytes),
      sizeBytes: visual.bytes.length,
    },
  }
}

describe('remaining-journey prepared native pixel data', () => {
  it.each(['png', 'jpeg'] as const)(
    'decodes the independently rendered %s pixels after private-file/digest checks',
    async format => {
      const { visual, fixture } = image(format)
      expect(await preparedPixelCode(run, fixture)).toBe(visual.code)
    }
  )
  it('refuses changed image bytes with an old preparation digest', async () => {
    const { fixture } = image()
    const changed = tileChallengeImage('png', { requirePixels: true })
    fs.writeFileSync(fixture.fixtureImagePath, changed.bytes)
    await expect(preparedPixelCode(run, fixture)).rejects.toThrow('changed')
  })
  it('refuses a GFS file with a different physical byte count', async () => {
    const { fixture } = image()
    await expect(
      preparedPixelCode(run, { ...fixture, sizeBytes: fixture.sizeBytes + 1 })
    ).rejects.toThrow('changed')
  })
  it('refuses non-private source files before interpreting their pixels', async () => {
    const { fixture } = image()
    fs.chmodSync(fixture.fixtureImagePath, 0o644)
    await expect(preparedPixelCode(run, fixture)).rejects.toThrow('private')
  })
  it('refuses a symlink source instead of following it', async () => {
    const { fixture } = image()
    const link = path.join(root, 'alias.png')
    fs.symlinkSync(fixture.fixtureImagePath, link)
    await expect(preparedPixelCode(run, { ...fixture, fixtureImagePath: link })).rejects.toThrow()
  })
  it('refuses undecodable bytes even when a receipt contains their correct digest', async () => {
    const fixtureImagePath = path.join(root, 'invalid.png')
    const bytes = Buffer.from('shape-only data is not native image pixels')
    fs.writeFileSync(fixtureImagePath, bytes, { mode: 0o600 })
    await expect(
      preparedPixelCode(run, { fixtureImagePath, imageSha256: digest(bytes) })
    ).rejects.toThrow()
  })
  it('refuses a live oracle belonging to other pixels or another run', async () => {
    const { visual, fixture } = image()
    const oraclePath = `${fixture.fixtureImagePath}.oracle.json`
    for (const patch of [
      { runId: 'subscription-image-ffffffffffff' },
      { imageSha256: 'b'.repeat(64) },
    ]) {
      fs.writeFileSync(
        oraclePath,
        JSON.stringify({
          kind: 'evenfire-subscription-live-pixel-oracle-v1',
          runId: run.runId,
          imageSha256: fixture.imageSha256,
          code: visual.code,
          ...patch,
        }),
        { mode: 0o600 }
      )
      await expect(preparedPixelCode({ ...run, mode: 'real' }, fixture)).rejects.toThrow(
        'rendered pixel oracle'
      )
    }
  })
})
