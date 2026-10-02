// E2E_GUARDIAN_IPC_FLOW: scoped QA data and private frame preparation only.
// The renderer still logs in, selects, attaches, approves and sends visibly.
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { validateRemainingFixture } from '../../desktop-app/test/e2e-playwright/subscriptionRemainingJourneysContract.ts'

const codec = createRequire(import.meta.url)('./fixtures/subscription-image-challenge.cjs')
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const MAX_FRAME_BYTES = 8 * 1024 * 1024
const fail = code => { throw new Error(code) }
const SUITES = ['tool-screenshot', 'gfs-image', 'admission-recovery']
const assetDirectory = (root, suite) => path.join(root, `remaining-${suite}`)
export const remainingAssetPath = (root, suite, name) => path.join(assetDirectory(root, suite), name)

function admitRun(admission, root) {
  if (admission?.mode === 'real') fail('REMAINING_REAL_SUBSCRIPTION_PREPARATION_REQUIRES_OPERATOR')
  if (!SUITES.includes(admission?.suiteId) || admission.mode !== 'fixture' ||
      !/^subscription-image-[a-f0-9]{12}$/.test(admission.runId ?? '') ||
      !/^[a-f0-9]{64}$/.test(admission.sourceManifestSha256 ?? '') ||
      !/^[a-z0-9][a-z0-9-]{0,62}$/.test(admission.profile ?? '') || admission.profile === 'clerum-test' ||
      /(^|[-_])(prod|production)([-_]|$)/i.test(admission.profile) ||
      admission.profile !== admission.context || !path.isAbsolute(root) || path.resolve(root) !== root ||
      !Array.isArray(admission.bindings) || admission.bindings.length !== 2) fail('REMAINING_PREPARATION_RUN_INVALID')
  const providers = admission.bindings.map(binding => binding.provider)
  if (new Set(providers).size !== 2 || !providers.includes('grok-subscription') || !providers.includes('codex-subscription')) {
    fail('REMAINING_PREPARATION_BINDINGS_INVALID')
  }
}

/** Generate actual native PNG/JPEG bytes; no code/answer is returned or persisted. */
export function createRemainingPixelAssets({ admission, runRoot }) {
  admitRun(admission, runRoot)
  if (admission.suiteId === 'admission-recovery') return []
  const assets = []
  for (const binding of admission.bindings) {
    const formats = admission.suiteId === 'gfs-image' ? ['png', 'jpeg'] : ['png']
    for (const format of formats) {
      const { bytes, width, height } = codec.tileChallengeImage(format, { requirePixels: true })
      const name = `${randomUUID()}.${format}`
      assets.push({ provider: binding.provider, name, mimeType: `image/${format}`,
        contentsBase64: bytes.toString('base64'), sha256: sha256(bytes), width, height })
    }
  }
  return assets
}

function canonicalReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || !receipt.fixtures || typeof receipt.fixtures !== 'object') {
    fail('REMAINING_FIXTURE_RECEIPT_INVALID')
  }
  const fixtures = {}
  for (const [provider, raw] of Object.entries(receipt.fixtures ?? {})) {
    const common = { hostRef: raw.hostRef, podUid: raw.podUid, imageId: raw.imageId }
    if (receipt.suite === 'tool-screenshot') {
      fixtures[provider] = { ...common, hostImagePath: raw.hostImagePath,
        fixtureImagePath: raw.fixtureImagePath, imageSha256: raw.imageSha256,
        region: { x: raw.region?.x, y: raw.region?.y, w: raw.region?.w, h: raw.region?.h } }
    } else if (receipt.suite === 'gfs-image') {
      fixtures[provider] = { ...common, folderNames: raw.folderNames,
        files: (raw.files ?? []).map(file => ({ name: file.name, drive: file.drive,
          pickerResourceId: file.pickerResourceId, resourceId: file.resourceId, version: file.version,
          gfsUri: file.gfsUri, sizeBytes: file.sizeBytes, mimeType: file.mimeType,
          fixtureImagePath: file.fixtureImagePath, imageSha256: file.imageSha256, width: file.width, height: file.height })) }
    } else {
      fixtures[provider] = { ...common, controlApiPodUid: raw.controlApiPodUid,
        controlApiImageId: raw.controlApiImageId, maxInFlight: raw.maxInFlight,
        readDeadlineMs: raw.readDeadlineMs, pressure: { receiptFile: raw.pressure?.receiptFile },
        fallback: { provider: raw.fallback?.provider, modelId: raw.fallback?.modelId } }
    }
  }
  return { kind: receipt.kind, runId: receipt.runId, suite: receipt.suite,
    profile: receipt.profile, context: receipt.context, sourceManifestSha256: receipt.sourceManifestSha256,
    preparedAt: receipt.preparedAt, fixtures }
}

/** Combine real preparation results; the caller obtains identities from the runtime/API, never literals. */
export async function buildRemainingFixtureFrame({ admission, runRoot, fixtures, assets }) {
  admitRun(admission, runRoot)
  const receipt = canonicalReceipt({ kind: 'evenfire-subscription-remaining-journey-fixture-v1',
    runId: admission.runId, suite: admission.suiteId, profile: admission.profile, context: admission.context,
    sourceManifestSha256: admission.sourceManifestSha256, preparedAt: new Date().toISOString(), fixtures })
  const frame = { kind: 'evenfire-subscription-remaining-fixture-frame-v1', runId: admission.runId,
    suiteId: admission.suiteId, sourceManifestSha256: admission.sourceManifestSha256, receipt,
    assets: assets.map(({ provider, name, mimeType, contentsBase64, sha256: digest }) =>
      ({ provider, name, mimeType, contentsBase64, sha256: digest })) }
  await validateFrame(frame, admission, runRoot)
  return frame
}

async function validateFrame(frame, admission, root) {
  admitRun(admission, root)
  if (frame?.kind !== 'evenfire-subscription-remaining-fixture-frame-v1' || frame.runId !== admission.runId ||
      frame.suiteId !== admission.suiteId || frame.sourceManifestSha256 !== admission.sourceManifestSha256 ||
      Buffer.byteLength(JSON.stringify(frame)) > MAX_FRAME_BYTES || !Array.isArray(frame.assets)) {
    fail('REMAINING_FIXTURE_FRAME_INVALID')
  }
  const receipt = canonicalReceipt(frame.receipt)
  const receiptPath = path.join(root, `remaining-${admission.suiteId}.json`)
  validateRemainingFixture(receipt, { suite: admission.suiteId, fixtureReceiptPath: receiptPath },
    { ...admission, runRoot: root }, admission.sourceManifestSha256)
  const expected = []
  for (const binding of admission.bindings) {
    const fixture = receipt.fixtures[binding.provider]
    if (admission.suiteId === 'tool-screenshot') expected.push({ provider: binding.provider,
      fixtureImagePath: fixture.fixtureImagePath, imageSha256: fixture.imageSha256, mimeType: 'image/png' })
    else if (admission.suiteId === 'gfs-image') {
      for (const file of fixture.files) expected.push({ provider: binding.provider, ...file })
    }
  }
  if (frame.assets.length !== expected.length) fail('REMAINING_FIXTURE_ASSETS_MISSING')
  const decoded = [], names = new Set()
  for (const asset of frame.assets) {
    if (!/^[a-f0-9-]{36}\.(?:png|jpeg)$/.test(asset.name ?? '') || names.has(asset.name) ||
        typeof asset.contentsBase64 !== 'string' || asset.contentsBase64.length > 4 * 1024 * 1024 ||
        !/^[a-f0-9]{64}$/.test(asset.sha256 ?? '') || !['image/png', 'image/jpeg'].includes(asset.mimeType)) {
      fail('REMAINING_FIXTURE_ASSET_INVALID')
    }
    names.add(asset.name)
    const bytes = Buffer.from(asset.contentsBase64, 'base64')
    const filename = remainingAssetPath(root, admission.suiteId, asset.name)
    const matches = expected.filter(item => item.provider === asset.provider && item.fixtureImagePath === filename &&
      item.imageSha256 === asset.sha256 && item.mimeType === asset.mimeType)
    if (!bytes.length || bytes.length > 3 * 1024 * 1024 || bytes.toString('base64') !== asset.contentsBase64 ||
        sha256(bytes) !== asset.sha256 || matches.length !== 1 ||
        (asset.mimeType === 'image/png' && !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) ||
        (asset.mimeType === 'image/jpeg' && !bytes.subarray(0, 3).equals(Buffer.from([255,216,255]))) ||
        (matches[0].sizeBytes !== undefined && matches[0].sizeBytes !== bytes.length)) fail('REMAINING_FIXTURE_ASSET_MISMATCH')
    // Decoding each received byte sequence rules out shape-only images and an
    // answer table keyed by file names, digests or PNG metadata.
    await codec.decodeTileChallenge(bytes)
    decoded.push({ filename, bytes })
  }
  return { receipt, receiptPath, decoded }
}

/** Runner-only materializer. It imports no CAPI, session, seeder or server modules. */
export async function acceptRemainingFixtureFrame(frame, { admission, runRoot }) {
  const { receipt, receiptPath, decoded } = await validateFrame(frame, admission, runRoot)
  const root = fs.lstatSync(runRoot)
  if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== process.getuid?.() ||
      (root.mode & 0o077) !== 0 || fs.realpathSync(runRoot) !== runRoot) fail('REMAINING_FIXTURE_RUN_ROOT_INVALID')
  const directory = assetDirectory(runRoot, admission.suiteId)
  if (fs.existsSync(directory) || fs.existsSync(receiptPath)) fail('REMAINING_FIXTURE_ALREADY_PREPARED')
  fs.mkdirSync(directory, { mode: 0o700 })
  try {
    for (const { filename, bytes } of decoded) fs.writeFileSync(filename, bytes, { flag: 'wx', mode: 0o600 })
    fs.writeFileSync(receiptPath, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 })
  } catch (error) {
    for (const { filename } of decoded) if (fs.existsSync(filename)) fs.unlinkSync(filename)
    if (fs.existsSync(receiptPath)) fs.unlinkSync(receiptPath)
    fs.rmdirSync(directory)
    throw error
  } finally {
    for (const item of decoded) item.bytes.fill(0)
  }
  return { receiptPath, assets: decoded.map(item => ({ path: item.filename })),
    suiteId: admission.suiteId, sourceManifestSha256: admission.sourceManifestSha256 }
}
