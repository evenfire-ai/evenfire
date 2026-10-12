// Unit-only protocol and native-pixel controls. No fake session/Ready value in
// this file is runtime evidence or used by the physical preparer.
// E2E_GUARDIAN_IPC_FLOW: source contracts for the private QA preparation channel.
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { createRemainingPixelAssets, buildRemainingFixtureFrame, acceptRemainingFixtureFrame, remainingAssetPath } from './prepare-subscription-remaining-fixtures.mjs'
import { prepareGfsImages } from './prepare-subscription-remaining-fixtures.gfs.mjs'
import { SCREEN_PROGRAM } from './prepare-subscription-remaining-fixtures.runtime.mjs'

const uid = '12345678-1234-4234-8234-123456789abc'
const digest = 'a'.repeat(64)
const admission = { runId: 'subscription-image-123456789abc', mode: 'fixture', suiteId: 'gfs-image',
  profile: 'qa-owned-unit', context: 'qa-owned-unit', sourceManifestSha256: digest,
  bindings: ['grok', 'codex'].map(kind => ({ provider: `${kind}-subscription`, hostRef: `qa-${kind}`,
    modelId: `${kind}-image`, modelLabel: `${kind} Image`, hostLabel: `QA ${kind}` })) }
const root = () => { const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pr806-remaining-prep-unit-'))); fs.chmodSync(dir, 0o700); return dir }
const uuidAt = index => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`

function fixtureMap(runRoot, assets) {
  return Object.fromEntries(admission.bindings.map((binding, providerIndex) => [binding.provider, {
    hostRef: binding.hostRef, podUid: uid, imageId: `sha256:${digest}`,
    folderNames: ['e2e-gfs-unit'], files: assets.filter(asset => asset.provider === binding.provider).map((asset, index) => {
      const pickerResourceId = uuidAt(providerIndex * 10 + index + 1)
      return { name: asset.name, drive: 'main', pickerResourceId, resourceId: pickerResourceId.replaceAll('-', ''),
        gfsUri: `gfs://main/${pickerResourceId.replaceAll('-', '')}`, version: 1,
        sizeBytes: Buffer.from(asset.contentsBase64, 'base64').length, mimeType: asset.mimeType,
        fixtureImagePath: remainingAssetPath(runRoot, admission.suiteId, asset.name), imageSha256: asset.sha256, width: 512, height: 512 }
    })
  }]))
}

test('private frame materializes actual native pixels with no answer metadata', async () => {
  const runRoot = root()
  try {
    const assets = createRemainingPixelAssets({ admission, runRoot })
    assert.equal(assets.length, 4)
    assert.equal(new Set(assets.map(asset => asset.sha256)).size, 4)
    assert.ok(assets.every(asset => !('code' in asset)))
    const fixtures = fixtureMap(runRoot, assets)
    fixtures['grok-subscription'].unusedMetadata = 'must-not-be-published'
    const frame = await buildRemainingFixtureFrame({ admission, runRoot, fixtures, assets })
    assert.ok(!JSON.stringify(frame).includes('must-not-be-published'))
    const result = await acceptRemainingFixtureFrame(frame, { admission, runRoot })
    assert.equal(fs.statSync(result.receiptPath).mode & 0o777, 0o600)
    assert.equal(result.assets.length, 4)
    assert.ok(result.assets.every(item => (fs.statSync(item.path).mode & 0o777) === 0o600))
    await assert.rejects(acceptRemainingFixtureFrame(frame, { admission, runRoot }), /ALREADY_PREPARED/)
  } finally { fs.rmSync(runRoot, { recursive: true, force: true }) }
})

test('fixture source/run mismatch fails before any materialization', async () => {
  const runRoot = root()
  try {
    const assets = createRemainingPixelAssets({ admission, runRoot })
    const frame = await buildRemainingFixtureFrame({ admission, runRoot, fixtures: fixtureMap(runRoot, assets), assets })
    frame.sourceManifestSha256 = 'b'.repeat(64)
    await assert.rejects(acceptRemainingFixtureFrame(frame, { admission, runRoot }), /FRAME_INVALID/)
    assert.deepEqual(fs.readdirSync(runRoot), [])
  } finally { fs.rmSync(runRoot, { recursive: true, force: true }) }
})

test('changed bytes, duplicate assets and traversal cannot publish a receipt', async () => {
  const runRoot = root()
  try {
    const assets = createRemainingPixelAssets({ admission, runRoot })
    const original = await buildRemainingFixtureFrame({ admission, runRoot, fixtures: fixtureMap(runRoot, assets), assets })
    for (const change of [frame => { frame.assets[0].contentsBase64 = frame.assets[1].contentsBase64 },
      frame => { frame.assets[0].name = '../escape.png' }, frame => { frame.assets[0] = frame.assets[1] }]) {
      const frame = structuredClone(original); change(frame)
      await assert.rejects(acceptRemainingFixtureFrame(frame, { admission, runRoot }), /ASSET_/)
      assert.deepEqual(fs.readdirSync(runRoot), [])
    }
  } finally { fs.rmSync(runRoot, { recursive: true, force: true }) }
})

test('real subscription preparation requires its separate operator contract', () => {
  assert.throws(() => createRemainingPixelAssets({ admission: { ...admission, mode: 'real' }, runRoot: '/private/tmp/unit' }), /REQUIRES_OPERATOR/)
})

function apiSession({ inputs, denial, changedContent, missingGrant } = {}) {
  const calls = [], folderId = uuidAt(99), resources = new Map()
  let fileIndex = 0
  const view = (id, name, kind, bytes) => ({ resourceId: id, rid: id.replaceAll('-', ''), drive: 'main',
    gfsUri: `gfs://main/${id.replaceAll('-', '')}`, parentResourceId: kind === 'directory' ? uid : folderId,
    name, kind, bytes, version: 1, path: kind === 'directory' ? '/seeded-parent/e2e-gfs-unit' : `/seeded-parent/e2e-gfs-unit/${name}` })
  return { calls, request: async input => {
    calls.push(input)
    if (denial === calls.length) return { status: 403, json: { error: 'forbidden' } }
    if (input.method === 'PUT') return { status: 200, json: { ok: true, count: 2 } }
    if (input.path.startsWith('/api/v1/gfs/grants?')) return { status: 200, json: { items: missingGrant ? [] : [
      { drive: 'main', resourceId: folderId, subject: { type: 'user', id: uid }, permissions: ['read'], inherit: true },
      { drive: 'main', resourceId: folderId, subject: { type: 'host', id: '1st:mcp-host/qa-grok' }, permissions: ['read'], inherit: true },
    ] } }
    assert.ok(input.path.startsWith('/api/v1/gfs/proxy/v1/resources/'), 'creation/content must use the native CookieGuard proxy')
    if (input.method === 'POST' && input.body.kind === 'directory') return { status: 201, json: { ok: true, data: view(folderId, input.body.name, 'directory', 0) } }
    if (input.method === 'POST') {
      const selected = inputs[fileIndex++], id = uuidAt(fileIndex)
      assert.equal(input.body.contentBase64, selected.contentBase64)
      const data = view(id, selected.name, 'file', Buffer.from(selected.contentBase64, 'base64').length)
      resources.set(data.rid, { data, bytes: Buffer.from(selected.contentBase64, 'base64') })
      return { status: 201, json: { ok: true, data } }
    }
    const selected = resources.get(input.path.split('/')[7])
    if (input.binary) return { status: 200, bytes: changedContent ? Buffer.from('changed unit bytes') : selected.bytes }
    return { status: 200, json: { ok: true, data: selected.data } }
  } }
}
function gfsInput(session, assets) {
  return { session, userId: uid, hostNamespace: 'mcp-host', hostRef: 'qa-grok', parentResourceId: uid,
    folderName: 'e2e-gfs-unit', files: assets.filter(asset => asset.provider === 'grok-subscription').map(asset =>
      ({ name: asset.name, mimeType: asset.mimeType, contentBase64: asset.contentsBase64, sha256: asset.sha256 })) }
}
test('real GFS preparation contract uses create/grant/content/metadata and preserves UUID/rid', async () => {
  const assets = createRemainingPixelAssets({ admission, runRoot: '/private/tmp/unit' })
  const inputs = gfsInput(null, assets).files, session = apiSession({ inputs })
  const result = await prepareGfsImages(gfsInput(session, assets))
  assert.equal(result.files.length, 2)
  assert.deepEqual(result.folderNames, ['seeded-parent', 'e2e-gfs-unit'])
  assert.ok(result.files.every(file => file.pickerResourceId.replaceAll('-', '') === file.resourceId))
  assert.deepEqual(session.calls.filter(call => call.method === 'PUT')[0].body.subjects,
    [{ type: 'user', id: uid }, { type: 'host', id: '1st:mcp-host/qa-grok' }])
  assert.ok(!('session' in result))
  const callable = new Function(`return (${prepareGfsImages.toString()})`)()
  const isolated = apiSession({ inputs })
  const bundledResult = await callable(gfsInput(isolated, assets))
  assert.deepEqual(bundledResult.files, result.files, 'seeder bundle function must execute without captured helpers')
})
test('GFS refusal or wrong read-back bytes cannot produce preparation success', async () => {
  const assets = createRemainingPixelAssets({ admission, runRoot: '/private/tmp/unit' }), inputs = gfsInput(null, assets).files
  for (const options of [{ denial: 1 }, { missingGrant: true }, { changedContent: true }]) {
    await assert.rejects(prepareGfsImages(gfsInput(apiSession({ inputs, ...options }), assets)), /GFS_PREPARE_/)
  }
})
test('X11 preparation payload is valid JavaScript without executing a cluster operation', () => {
  assert.doesNotThrow(() => new vm.Script(SCREEN_PROGRAM))
})
