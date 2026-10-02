import { describe, expect, it } from 'vitest'
import type { SubscriptionImageRun } from './e2e-playwright/subscriptionImageRunContract.js'
import {
  requireRemainingJourney,
  validateRemainingFixture,
} from './e2e-playwright/subscriptionRemainingJourneysContract.js'

// These are shape-only identities. No runtime/session or provider is fabricated
// by the unit fixture; physical ownership remains the independent runner gate.
const digest = 'a'.repeat(64)
const run: SubscriptionImageRun = {
  mode: 'fixture',
  runId: 'subscription-image-123456789abc',
  runnerReceipt: '/private/tmp/unit-run/runner.json',
  runRoot: '/private/tmp/unit-run',
  profile: 'clerum-owned-unit-lane',
  context: 'clerum-owned-unit-lane',
  restUrl: 'http://127.0.0.1:43001',
  rpcUrl: 'http://127.0.0.1:43002',
  bindings: ['grok', 'codex'].map(kind => ({
    provider: `${kind}-subscription` as 'grok-subscription' | 'codex-subscription',
    hostRef: `qa-${kind}`,
    hostLabel: `QA ${kind}`,
    modelId: `${kind}-image`,
    modelLabel: `${kind} Image`,
    unsupportedModelId: `${kind}-text`,
    unsupportedModelLabel: `${kind} Text`,
  })),
}
const input = {
  suite: 'tool-screenshot' as const,
  fixtureReceiptPath: `${run.runRoot}/screens.json`,
}
const env = {
  E2E_SUBSCRIPTION_TOOL_SCREENSHOT: '1',
  E2E_SUBSCRIPTION_REMAINING_FIXTURE_RECEIPT: input.fixtureReceiptPath,
}
function receipt() {
  return {
    kind: 'evenfire-subscription-remaining-journey-fixture-v1',
    suite: input.suite,
    runId: run.runId,
    profile: run.profile,
    context: run.context,
    sourceManifestSha256: digest,
    preparedAt: '2026-10-02T00:00:00.000Z',
    fixtures: Object.fromEntries(
      run.bindings.map(binding => [
        binding.provider,
        {
          hostRef: binding.hostRef,
          podUid: '12345678-1234-4234-8234-123456789abc',
          imageId: `sha256:${digest}`,
          hostImagePath: '/tmp/evenfire-qa-screen-12345678-1234-4234-8234-123456789abc.png',
          fixtureImagePath: `${run.runRoot}/${binding.provider}.png`,
          imageSha256: digest,
          region: { x: 0, y: 0, w: 512, h: 512 },
        },
      ])
    ),
  }
}
function gfsReceipt() {
  return {
    ...receipt(),
    suite: 'gfs-image',
    fixtures: Object.fromEntries(
      run.bindings.map(binding => [
        binding.provider,
        {
          hostRef: binding.hostRef,
          podUid: '12345678-1234-4234-8234-123456789abc',
          imageId: `sha256:${digest}`,
          folderNames: ['owned-qa-folder'],
          files: ['png', 'jpeg'].map((format, index) => ({
            name: `qa-file-${index}.${format}`,
            drive: 'main',
            resourceId: (index ? 'b' : 'c').repeat(32),
            pickerResourceId: `${(index ? 'b' : 'c').repeat(8)}-${(index ? 'b' : 'c').repeat(4)}-${(index ? 'b' : 'c').repeat(4)}-${(index ? 'b' : 'c').repeat(4)}-${(index ? 'b' : 'c').repeat(12)}`,
            version: 4,
            gfsUri: `gfs://main/${(index ? 'b' : 'c').repeat(32)}`,
            sizeBytes: 2048,
            mimeType: `image/${format}`,
            fixtureImagePath: `${run.runRoot}/qa-${binding.provider}-${index}.${format}`,
            imageSha256: (index ? 'b' : 'c').repeat(64),
            width: 512,
            height: 512,
          })),
        },
      ])
    ),
  }
}
function admissionReceipt() {
  return {
    ...receipt(),
    suite: 'admission-recovery',
    fixtures: Object.fromEntries(
      run.bindings.map(binding => [
        binding.provider,
        {
          hostRef: binding.hostRef,
          podUid: '12345678-1234-4234-8234-123456789abc',
          imageId: `sha256:${digest}`,
          controlApiPodUid: 'abcdefab-1234-4234-8234-123456789abc',
          controlApiImageId: `sha256:${digest}`,
          maxInFlight: 1,
          readDeadlineMs: 10000,
          // This suite tests only outer metadata admission. The physical pressure
          // client must reject this unit-only record; it is never used to hold work.
          pressure: { receiptFile: '/runner-admission/unit-pressure-metadata.json' },
          fallback: {
            provider: run.bindings.find(item => item.provider !== binding.provider)!.provider,
            modelId: run.bindings.find(item => item.provider !== binding.provider)!.modelId,
          },
        },
      ])
    ),
  }
}

describe('remaining subscription journeys collection and data-preparation gates', () => {
  it('refuses each missing dedicated opt-in rather than producing skipped success', () => {
    for (const suite of ['tool-screenshot', 'gfs-image', 'admission-recovery'] as const) {
      expect(() => requireRemainingJourney(suite, run, {})).toThrow('requires')
    }
  })
  it('rejects admission saturation in the real subscription mode', () => {
    expect(() =>
      requireRemainingJourney(
        'admission-recovery',
        { ...run, mode: 'real' },
        {
          E2E_SUBSCRIPTION_ADMISSION_RECOVERY: '1',
          E2E_SUBSCRIPTION_REMAINING_FIXTURE_RECEIPT: input.fixtureReceiptPath,
        }
      )
    ).toThrow('fixture-only')
  })
  it.each([
    '/private/tmp/elsewhere/screens.json',
    '/private/tmp/unit-run/../foreign.json',
    'screens.json',
  ])('refuses a fixture outside its physical run root: %s', fixtureReceiptPath => {
    expect(() =>
      requireRemainingJourney('tool-screenshot', run, {
        ...env,
        E2E_SUBSCRIPTION_REMAINING_FIXTURE_RECEIPT: fixtureReceiptPath,
      })
    ).toThrow('owned run root')
  })
  it('admits a dedicated suite without reading a receipt or running setup during collection', () => {
    expect(requireRemainingJourney('tool-screenshot', run, env)).toEqual(input)
  })
  it('accepts exactly bound native-screen fixture metadata', () => {
    const value = receipt()
    expect(validateRemainingFixture(value, input, run, digest)).toBe(value)
  })
  it('refuses a different run, source, or stack', () => {
    for (const patch of [
      { runId: 'subscription-image-ffffffffffff' },
      { sourceManifestSha256: 'b'.repeat(64) },
      { profile: 'other-branch' },
      { context: 'other-branch' },
    ]) {
      expect(() =>
        validateRemainingFixture({ ...receipt(), ...patch }, input, run, digest)
      ).toThrow('run/source/stack')
    }
  })
  it('refuses a screenshot fixture for another actual Host', () => {
    const value = receipt()
    value.fixtures['grok-subscription']!.hostRef = 'different-host'
    expect(() => validateRemainingFixture(value, input, run, digest)).toThrow('Host/pod/image')
  })
  it.each(['imageId', 'podUid'] as const)('refuses unverifiable runtime identity: %s', field => {
    const value = receipt()
    value.fixtures['grok-subscription']![field] = 'unknown'
    expect(() => validateRemainingFixture(value, input, run, digest)).toThrow('Host/pod/image')
  })
  it.each([
    `docker://sha256:${digest}`,
    `containerd://sha256:${digest}`,
    `docker-pullable://ghcr.io/evenfire/qa@sha256:${digest}`,
  ])('preserves the actual Kubernetes image-id form: %s', imageId => {
    const value = receipt()
    value.fixtures['grok-subscription']!.imageId = imageId
    expect(validateRemainingFixture(value, input, run, digest)).toBe(value)
  })
  it('refuses shell syntax in the prepared screen path', () => {
    const value = receipt()
    value.fixtures['grok-subscription']!.hostImagePath += '; command'
    expect(() => validateRemainingFixture(value, input, run, digest)).toThrow('native pixels')
  })
  it('refuses geometry that cannot decode the actual challenge', () => {
    const value = receipt()
    value.fixtures['grok-subscription']!.region.w = 513
    expect(() => validateRemainingFixture(value, input, run, digest)).toThrow('capture region')
  })
  it('rejects missing or extra provider bindings', () => {
    const value = receipt()
    delete value.fixtures['codex-subscription']
    expect(() => validateRemainingFixture(value, input, run, digest)).toThrow(
      'exact fixture binding'
    )
    const extra = receipt()
    extra.fixtures['other-provider'] = extra.fixtures['grok-subscription']!
    expect(() => validateRemainingFixture(extra, input, run, digest)).toThrow(
      'exact fixture binding'
    )
  })
  it('accepts independently named and version-pinned GFS fixture files', () => {
    const value = gfsReceipt()
    expect(validateRemainingFixture(value, { ...input, suite: 'gfs-image' }, run, digest)).toBe(
      value
    )
  })
  it('refuses a GFS URI for a different source', () => {
    const value = gfsReceipt()
    value.fixtures['grok-subscription']!.files[0]!.gfsUri = `gfs://main/${'d'.repeat(32)}`
    expect(() =>
      validateRemainingFixture(value, { ...input, suite: 'gfs-image' }, run, digest)
    ).toThrow('source identity')
  })
  it('refuses a picker UUID that refers to another compact model/tool rid', () => {
    const value = gfsReceipt()
    value.fixtures['grok-subscription']!.files[0]!.pickerResourceId =
      '12345678-1234-4234-8234-123456789abc'
    expect(() =>
      validateRemainingFixture(value, { ...input, suite: 'gfs-image' }, run, digest)
    ).toThrow('source identity')
  })
  it.each(['resourceId', 'name', 'imageSha256'] as const)(
    'refuses repeated GFS identities or pixel content: %s',
    field => {
      const value = gfsReceipt()
      value.fixtures['grok-subscription']!.files[1]![field] =
        value.fixtures['grok-subscription']!.files[0]![field]
      if (field === 'resourceId') {
        value.fixtures['grok-subscription']!.files[1]!.gfsUri =
          value.fixtures['grok-subscription']!.files[0]!.gfsUri
        value.fixtures['grok-subscription']!.files[1]!.pickerResourceId =
          value.fixtures['grok-subscription']!.files[0]!.pickerResourceId
      }
      expect(() =>
        validateRemainingFixture(value, { ...input, suite: 'gfs-image' }, run, digest)
      ).toThrow('independent')
    }
  )
  it('refuses an image that would exceed the actual GFS inline byte budget', () => {
    const value = gfsReceipt()
    value.fixtures['grok-subscription']!.files[0]!.sizeBytes = 3 * 1024 * 1024 + 1
    expect(() =>
      validateRemainingFixture(value, { ...input, suite: 'gfs-image' }, run, digest)
    ).toThrow('within-budget')
  })
  it('refuses an invalid pinned version or a non-visible folder path', () => {
    const value = gfsReceipt()
    value.fixtures['grok-subscription']!.files[0]!.version = -1
    expect(() =>
      validateRemainingFixture(value, { ...input, suite: 'gfs-image' }, run, digest)
    ).toThrow('source identity')
    const path = gfsReceipt()
    path.fixtures['grok-subscription']!.folderNames = ['folder/escape']
    expect(() =>
      validateRemainingFixture(path, { ...input, suite: 'gfs-image' }, run, digest)
    ).toThrow('visible folder path')
  })
  it('requires an eligible fallback, so no-failover cannot pass with no alternate target', () => {
    const value = admissionReceipt()
    value.fixtures['grok-subscription']!.fallback.modelId = run.bindings[0]!.modelId
    expect(() =>
      validateRemainingFixture(value, { ...input, suite: 'admission-recovery' }, run, digest)
    ).toThrow('eligible physical fallback')
  })
  it('rejects pressure metadata with no actual control-api pod identity', () => {
    const value = admissionReceipt()
    value.fixtures['grok-subscription']!.controlApiPodUid = 'unknown'
    expect(() =>
      validateRemainingFixture(value, { ...input, suite: 'admission-recovery' }, run, digest)
    ).toThrow('owned capacity')
  })
  it('rejects pressure without sealed private relay metadata', () => {
    const value = admissionReceipt()
    ;(value.fixtures['grok-subscription'] as unknown as { pressure?: unknown }).pressure = undefined
    expect(() =>
      validateRemainingFixture(value, { ...input, suite: 'admission-recovery' }, run, digest)
    ).toThrow('private relay metadata')
  })
  it.each([0, -1, 1.5])('rejects an invalid physical owner count: %s', count => {
    const value = admissionReceipt()
    value.fixtures['grok-subscription']!.maxInFlight = count
    expect(() =>
      validateRemainingFixture(value, { ...input, suite: 'admission-recovery' }, run, digest)
    ).toThrow('owned capacity')
  })
})
