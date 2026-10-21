// The release assets the README links to through
//
//   https://github.com/evenfire-ai/evenfire/releases/latest/download/<name>
//
// GitHub resolves `latest` to the newest published, non-prerelease release and
// serves the asset whose name is exactly <name>. The link therefore only keeps
// working if every release carries an asset with the SAME name: a version in
// the name (evenfire-desktop-v0.10.0-mac-arm64.zip) would make the README link
// 404 on the very next cut.
//
// Builds are still uploaded with the version in the name, the way they always
// have been. normalize-release-assets.mjs (run by release-assets.yml when a
// release is published) maps each one onto its stable name, so the convention
// is enforced by the workflow rather than by whoever uploads.
//
// `rename` moves the asset in place: no bytes are transferred, which matters
// for ~300 MB desktop zips, and the release page does not list every build
// twice. `copy` keeps the versioned asset AND adds the stable one; it is for
// the image manifest, whose versioned name the release notes cite by name.

export const LATEST_DOWNLOAD_PREFIX =
  'https://github.com/evenfire-ai/evenfire/releases/latest/download/'

export const DESKTOP_PLATFORMS = [
  'mac-arm64',
  'mac-x64',
  'windows-arm64',
  'windows-x64',
  'linux-arm64',
  'linux-x64',
]

export const RELEASE_ASSETS = [
  ...DESKTOP_PLATFORMS.map(platform => ({
    stable: `evenfire-desktop-${platform}.zip`,
    versioned: tag => `evenfire-desktop-${tag}-${platform}.zip`,
    action: 'rename',
  })),
  {
    stable: 'release-images.json',
    versioned: tag => `release-images-${tag}.json`,
    action: 'copy',
  },
]

// The tag is used verbatim in the versioned name, because that is how the
// assets are uploaded (evenfire-desktop-v0.10.0-..., not ...-0.10.0-...).
export const RELEASE_TAG_RE = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

// Decides what to do with one listing of a release's assets. Pure, so the
// workflow's whole decision is testable without the GitHub API.
//
// `assets` is the API listing ({ id, name, label, state, content_type }).
// Only `state === 'uploaded'` counts: an upload still in flight is listed as
// `starter`, and renaming or copying a half-written file would publish a
// broken download under the stable name.
//
// Returns:
//   actions - { type: 'rename' | 'copy', asset, to } to perform now
//   missing - stable names that have neither form yet (keep waiting)
//   done    - stable names already present (nothing to do; makes re-runs and
//             an uploader who already used the stable name no-ops)
export function planReleaseAssets(assets, tag) {
  if (!RELEASE_TAG_RE.test(tag)) {
    throw new Error(`release tag must look like v1.2.3 or v1.2.3-rc.1, got: ${tag || '(missing)'}`)
  }
  const uploaded = new Map(
    assets.filter(asset => asset.state === 'uploaded').map(asset => [asset.name, asset])
  )
  const actions = []
  const missing = []
  const done = []
  for (const spec of RELEASE_ASSETS) {
    if (uploaded.has(spec.stable)) {
      done.push(spec.stable)
      continue
    }
    const source = uploaded.get(spec.versioned(tag))
    if (!source) {
      missing.push(spec.stable)
      continue
    }
    actions.push({ type: spec.action, asset: source, to: spec.stable })
  }
  return { actions, missing, done }
}

// Every `releases/latest/download/<name>` link in a Markdown document. The
// test uses it to hold the README and RELEASE_ASSETS to the same set: a README
// link with no matching entry here would 404 forever.
export function latestDownloadLinks(markdown) {
  const names = new Set()
  const escaped = LATEST_DOWNLOAD_PREFIX.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  for (const match of markdown.matchAll(new RegExp(`${escaped}([^\\s)"'<>]+)`, 'g'))) {
    names.add(match[1])
  }
  return [...names].sort()
}
