// E2E_GUARDIAN_IPC_FLOW: pure collection admission and fixture shape validation; no launch, network or session access.
import path from 'node:path'
import { pressureCommandDeadlineMs } from '../../../scripts/e2e/fixtures/subscription-image-admission-pressure.mjs'
import type {
  SubscriptionImageProvider,
  SubscriptionImageRun,
} from './subscriptionImageRunContract.js'

export type RemainingJourneySuite = 'tool-screenshot' | 'gfs-image' | 'admission-recovery'
export type JourneyInput = { suite: RemainingJourneySuite; fixtureReceiptPath: string }
export type RuntimeIdentity = {
  hostRef: string
  podUid: string
  imageId: string
}
export type ScreenFixture = RuntimeIdentity & {
  hostImagePath: string
  fixtureImagePath: string
  imageSha256: string
  region: { x: number; y: number; w: 512; h: 512 }
}
export type GfsFixtureFile = {
  name: string
  drive: string
  // API listing retains its database UUID; the model/tool source uses compact rid.
  pickerResourceId: string
  resourceId: string
  version: number
  gfsUri: string
  sizeBytes: number
  mimeType: 'image/png' | 'image/jpeg'
  fixtureImagePath: string
  imageSha256: string
  width: 512
  height: 512
}
export type GfsFixture = RuntimeIdentity & {
  // Actual visible directory names from Shared with me to the fixture folder.
  folderNames: string[]
  files: [GfsFixtureFile, GfsFixtureFile]
}
export type AdmissionFixture = RuntimeIdentity & {
  controlApiPodUid: string
  controlApiImageId: string
  maxInFlight: number
  readDeadlineMs: number
  // The private relay client validates its own sealed metadata and physical
  // socket ownership. This layer never invents a URL, JWT or IPC command.
  pressure: {
    receiptFile: string
    workDeadlineMs: number
    closeGraceMs: number
    commandDeadlineMs: number
  }
  // Main must prove a real eligible fallback exists before testing no-failover.
  fallback: { provider: SubscriptionImageProvider; modelId: string }
}
export type FixtureReceipt = {
  kind: 'evenfire-subscription-remaining-journey-fixture-v1'
  runId: string
  suite: RemainingJourneySuite
  profile: string
  context: string
  sourceManifestSha256: string
  preparedAt: string
  fixtures: Partial<
    Record<SubscriptionImageProvider, ScreenFixture | GfsFixture | AdmissionFixture>
  >
}

const SHA256 = /^[a-f0-9]{64}$/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const IMAGE_ID =
  /^(?:(?:docker-pullable|docker|containerd|cri-o):\/\/)?(?:[\w.:/-]+@)?sha256:[a-f0-9]{64}$/
const SPECIFIC_OPT_IN = {
  'tool-screenshot': 'E2E_SUBSCRIPTION_TOOL_SCREENSHOT',
  'gfs-image': 'E2E_SUBSCRIPTION_GFS_IMAGE',
  'admission-recovery': 'E2E_SUBSCRIPTION_ADMISSION_RECOVERY',
} as const

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}
function insideRunRoot(value: unknown, runRoot: string): value is string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value)
    return false
  const relative = path.relative(runRoot, value)
  return (
    Boolean(relative) &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}
function visibleName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    !/[\x00-\x1f/\\]/.test(value)
  )
}

/** Config admission precedes fixture setup. Missing opt-ins never become skips. */
export function requireRemainingJourney(
  suite: RemainingJourneySuite,
  run: SubscriptionImageRun,
  env: NodeJS.ProcessEnv = process.env
): JourneyInput {
  if (env[SPECIFIC_OPT_IN[suite]] !== '1')
    throw new Error(`${suite} requires ${SPECIFIC_OPT_IN[suite]}=1`)
  if (suite === 'admission-recovery' && run.mode !== 'fixture')
    throw new Error('admission-recovery is a fixture-only physical workload lane')
  const fixtureReceiptPath = env.E2E_SUBSCRIPTION_REMAINING_FIXTURE_RECEIPT
  if (!insideRunRoot(fixtureReceiptPath, run.runRoot))
    throw new Error('Remaining journey fixture receipt must be inside the owned run root')
  return { suite, fixtureReceiptPath }
}

/** Validate data preparation, never a substitute for the subsequently observed UI/tool/wire effects. */
export function validateRemainingFixture(
  value: unknown,
  input: JourneyInput,
  run: SubscriptionImageRun,
  sourceManifestSha256: string
): FixtureReceipt {
  const receipt = record(value, 'Remaining journey fixture receipt is invalid')
  if (
    receipt.kind !== 'evenfire-subscription-remaining-journey-fixture-v1' ||
    receipt.suite !== input.suite ||
    receipt.runId !== run.runId ||
    receipt.profile !== run.profile ||
    receipt.context !== run.context ||
    !SHA256.test(sourceManifestSha256) ||
    receipt.sourceManifestSha256 !== sourceManifestSha256 ||
    typeof receipt.preparedAt !== 'string' ||
    !Number.isFinite(Date.parse(receipt.preparedAt))
  ) {
    throw new Error('Remaining journey fixture does not bind the admitted run/source/stack')
  }
  const fixtures = record(receipt.fixtures, 'Remaining journey fixtures are missing')
  if (Object.keys(fixtures).length !== run.bindings.length)
    throw new Error('Each provider needs one exact fixture binding')
  for (const binding of run.bindings) {
    const fixture = record(fixtures[binding.provider], `Missing actual ${binding.provider} fixture`)
    if (
      fixture.hostRef !== binding.hostRef ||
      typeof fixture.podUid !== 'string' ||
      !UUID.test(fixture.podUid) ||
      typeof fixture.imageId !== 'string' ||
      !IMAGE_ID.test(fixture.imageId)
    ) {
      throw new Error('Fixture Host/pod/image identity is incomplete')
    }
    if (input.suite === 'tool-screenshot') {
      const region = record(fixture.region, 'Screen fixture region is missing')
      if (
        typeof fixture.hostImagePath !== 'string' ||
        !/^\/tmp\/evenfire-qa-screen-[a-f0-9-]{36}\.png$/.test(fixture.hostImagePath) ||
        !insideRunRoot(fixture.fixtureImagePath, run.runRoot) ||
        typeof fixture.imageSha256 !== 'string' ||
        !SHA256.test(fixture.imageSha256) ||
        !Number.isSafeInteger(region.x) ||
        Number(region.x) < 0 ||
        !Number.isSafeInteger(region.y) ||
        Number(region.y) < 0 ||
        region.w !== 512 ||
        region.h !== 512
      )
        throw new Error(
          'Screen fixture must identify actual prepared native pixels and exact capture region'
        )
    } else if (input.suite === 'gfs-image') {
      if (
        !Array.isArray(fixture.folderNames) ||
        fixture.folderNames.length < 1 ||
        fixture.folderNames.length > 8 ||
        !fixture.folderNames.every(visibleName) ||
        !Array.isArray(fixture.files) ||
        fixture.files.length !== 2
      ) {
        throw new Error('GFS fixture needs a visible folder path and two independent files')
      }
      const ids = new Set<string>(),
        names = new Set<string>(),
        digests = new Set<string>()
      for (const raw of fixture.files) {
        const file = record(raw, 'GFS fixture file is invalid')
        if (
          !visibleName(file.name) ||
          typeof file.drive !== 'string' ||
          !/^[a-zA-Z0-9_-]{1,63}$/.test(file.drive) ||
          typeof file.resourceId !== 'string' ||
          !/^[a-f0-9]{32}$/.test(file.resourceId) ||
          typeof file.pickerResourceId !== 'string' ||
          !(/^[a-f0-9]{32}$/.test(file.pickerResourceId) || UUID.test(file.pickerResourceId)) ||
          file.pickerResourceId.replaceAll('-', '').toLowerCase() !== file.resourceId ||
          !Number.isSafeInteger(file.version) ||
          Number(file.version) < 0 ||
          file.gfsUri !== `gfs://${file.drive}/${file.resourceId}` ||
          !Number.isSafeInteger(file.sizeBytes) ||
          Number(file.sizeBytes) < 1 ||
          Number(file.sizeBytes) > 3 * 1024 * 1024 ||
          !['image/png', 'image/jpeg'].includes(String(file.mimeType)) ||
          file.width !== 512 ||
          file.height !== 512 ||
          !insideRunRoot(file.fixtureImagePath, run.runRoot) ||
          typeof file.imageSha256 !== 'string' ||
          !SHA256.test(file.imageSha256)
        ) {
          throw new Error(
            'GFS fixture needs exact grantable source identity and within-budget native pixels'
          )
        }
        ids.add(file.gfsUri)
        names.add(file.name)
        digests.add(file.imageSha256)
      }
      if (ids.size !== 2 || names.size !== 2 || digests.size !== 2)
        throw new Error('GFS ordered challenge requires independent identities and pixels')
    } else {
      const fallback = record(
        fixture.fallback,
        'Admission fixture requires an actual eligible fallback'
      )
      const pressure = record(
        fixture.pressure,
        'Admission pressure requires sealed private relay metadata'
      )
      if (
        typeof pressure.receiptFile !== 'string' ||
        !path.isAbsolute(pressure.receiptFile) ||
        path.resolve(pressure.receiptFile) !== pressure.receiptFile ||
        path.dirname(pressure.receiptFile) !== '/runner-admission' ||
        !/\.json$/.test(pressure.receiptFile) ||
        /(?:^|[-_.])(?:env|token|secret|credential|wallet|cookie|password|private[-_]?key)(?:[-_.]|$)/i.test(
          path.basename(pressure.receiptFile)
        )
      ) {
        throw new Error(
          'Pressure receipt must identify sealed admission metadata, never private account/config files'
        )
      }
      if (
        typeof fixture.controlApiPodUid !== 'string' ||
        !UUID.test(fixture.controlApiPodUid) ||
        typeof fixture.controlApiImageId !== 'string' ||
        !IMAGE_ID.test(fixture.controlApiImageId) ||
        !Number.isSafeInteger(fixture.maxInFlight) ||
        Number(fixture.maxInFlight) < 1 ||
        !Number.isSafeInteger(fixture.readDeadlineMs) ||
        Number(fixture.readDeadlineMs) < 1 ||
        Number(fixture.readDeadlineMs) > 2_147_483_647 ||
        pressure.commandDeadlineMs !==
          pressureCommandDeadlineMs({
            readDeadlineMs: fixture.readDeadlineMs as number,
            workDeadlineMs: pressure.workDeadlineMs as number,
            closeGraceMs: pressure.closeGraceMs as number,
          }) ||
        fallback.provider !== binding.provider ||
        typeof fallback.modelId !== 'string' ||
        !fallback.modelId ||
        fallback.modelId === binding.modelId ||
        fallback.modelId === binding.unsupportedModelId
      ) {
        throw new Error(
          'Admission fixture must bind real owned capacity and an eligible physical fallback'
        )
      }
    }
  }
  return value as FixtureReceipt
}
