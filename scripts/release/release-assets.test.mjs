import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  DESKTOP_PLATFORMS,
  LATEST_DOWNLOAD_PREFIX,
  RELEASE_ASSETS,
  latestDownloadLinks,
  planReleaseAssets,
} from './release-assets.mjs'

const README = readFileSync(new URL('../../README.md', import.meta.url), 'utf8')

let nextId = 1
function asset(name, extra = {}) {
  return {
    id: nextId++,
    name,
    label: '',
    state: 'uploaded',
    content_type: 'application/zip',
    ...extra,
  }
}

// The asset list as v0.10.0 actually shipped it.
function versionedUpload(tag) {
  return [
    ...DESKTOP_PLATFORMS.map(platform => asset(`evenfire-desktop-${tag}-${platform}.zip`)),
    asset(`release-images-${tag}.json`, {
      label: `release-images-${tag}.json`,
      content_type: 'application/json',
    }),
  ]
}

test('renames every versioned desktop zip and copies the image manifest', () => {
  const { actions, missing, done } = planReleaseAssets(versionedUpload('v0.10.0'), 'v0.10.0')
  assert.deepEqual(missing, [])
  assert.deepEqual(done, [])
  assert.deepEqual(
    actions.map(({ type, asset: source, to }) => [type, source.name, to]),
    [
      ...DESKTOP_PLATFORMS.map(platform => [
        'rename',
        `evenfire-desktop-v0.10.0-${platform}.zip`,
        `evenfire-desktop-${platform}.zip`,
      ]),
      ['copy', 'release-images-v0.10.0.json', 'release-images.json'],
    ]
  )
})

test('a second pass over the normalized release is a no-op', () => {
  const normalized = [
    ...DESKTOP_PLATFORMS.map(platform => asset(`evenfire-desktop-${platform}.zip`)),
    asset('release-images-v0.10.0.json'),
    asset('release-images.json'),
  ]
  const { actions, missing, done } = planReleaseAssets(normalized, 'v0.10.0')
  assert.deepEqual(actions, [])
  assert.deepEqual(missing, [])
  assert.deepEqual(
    done,
    RELEASE_ASSETS.map(spec => spec.stable)
  )
})

test('reports what has not been uploaded yet instead of acting on it', () => {
  // Published with only the manifest; the zips arrive later.
  const { actions, missing } = planReleaseAssets(
    [asset('release-images-v0.11.0.json', { content_type: 'application/json' })],
    'v0.11.0'
  )
  assert.deepEqual(
    actions.map(action => action.to),
    ['release-images.json']
  )
  assert.deepEqual(
    missing,
    DESKTOP_PLATFORMS.map(platform => `evenfire-desktop-${platform}.zip`)
  )
})

test('ignores an upload that is still in flight', () => {
  const { actions, missing } = planReleaseAssets(
    [asset('evenfire-desktop-v0.11.0-mac-arm64.zip', { state: 'starter' })],
    'v0.11.0'
  )
  assert.equal(actions.length, 0)
  assert.ok(missing.includes('evenfire-desktop-mac-arm64.zip'))
})

test("never touches another release's build", () => {
  // A stale v0.9.0 zip re-attached to v0.10.0 must not become "latest".
  const { actions, missing } = planReleaseAssets(
    [asset('evenfire-desktop-v0.9.0-mac-arm64.zip')],
    'v0.10.0'
  )
  assert.equal(actions.length, 0)
  assert.ok(missing.includes('evenfire-desktop-mac-arm64.zip'))
})

test('rejects a tag that is not a release version', () => {
  for (const tag of ['', '0.10.0', 'latest', 'v0.10', 'v0.10.0/../x']) {
    assert.throws(() => planReleaseAssets([], tag), /release tag must look like/)
  }
  assert.doesNotThrow(() => planReleaseAssets([], 'v0.11.0-rc.1'))
})

test('the README links to exactly the assets every release is given', () => {
  assert.deepEqual(
    latestDownloadLinks(README),
    RELEASE_ASSETS.map(spec => spec.stable).sort(),
    `every ${LATEST_DOWNLOAD_PREFIX}<name> link in README.md must name an asset in ` +
      'RELEASE_ASSETS (or it 404s), and every RELEASE_ASSETS entry should be linked'
  )
})

test('latestDownloadLinks reads Markdown and HTML links alike', () => {
  const doc = [
    `[a](${LATEST_DOWNLOAD_PREFIX}one.zip)`,
    `<a href="${LATEST_DOWNLOAD_PREFIX}two.json">two</a>`,
    `[again](${LATEST_DOWNLOAD_PREFIX}one.zip)`,
    '[other](https://github.com/evenfire-ai/evenfire/releases/download/v0.10.0/three.zip)',
  ].join('\n')
  assert.deepEqual(latestDownloadLinks(doc), ['one.zip', 'two.json'])
})
