#!/usr/bin/env node
// Gives a published release's assets the stable names the README links to
// through releases/latest/download/<name>. What is renamed or copied, and why,
// lives in release-assets.mjs; this file only talks to the GitHub API.
//
//   GITHUB_TOKEN=... GITHUB_REPOSITORY=evenfire-ai/evenfire \
//   node scripts/release/normalize-release-assets.mjs --tag v0.11.0 \
//        [--wait-minutes 120] [--poll-seconds 60] [--dry-run]
//
// The desktop zips are uploaded AFTER the release is published (about half an
// hour later for v0.9.0 and v0.10.0), so --wait-minutes keeps polling until
// every stable name exists. Running out of time is a failure, not a warning:
// while an asset is missing, the README link for it 404s for as long as this
// release is the latest one.
//
// Idempotent: a stable name that already exists is left alone, so re-running
// for a release (or an uploader who already used the stable name) is a no-op.
import { Buffer } from 'node:buffer'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { RELEASE_TAG_RE, planReleaseAssets } from './release-assets.mjs'
import { argValue } from './release-coordinates.mjs'

const API = process.env.GITHUB_API_URL || 'https://api.github.com'
const REPO = process.env.GITHUB_REPOSITORY || 'evenfire-ai/evenfire'
const TOKEN = process.env.GITHUB_TOKEN || ''

function die(message) {
  console.error(`::error::${message}`)
  process.exit(1)
}

function nonNegativeNumber(flag, fallback) {
  const raw = argValue(flag)
  if (raw === '') return fallback
  const value = Number(raw)
  if (raw === undefined || !Number.isFinite(value) || value < 0) {
    die(`${flag} must be a non-negative number, got: ${raw ?? '(missing)'}`)
  }
  return value
}

const tag = argValue('--tag')
const dryRun = process.argv.includes('--dry-run')
const waitMinutes = nonNegativeNumber('--wait-minutes', 0)
const pollSeconds = nonNegativeNumber('--poll-seconds', 60)

if (!RELEASE_TAG_RE.test(tag || '')) {
  die(`--tag must look like v1.2.3 or v1.2.3-rc.1, got: ${tag || '(missing)'}`)
}
if (!TOKEN) die('GITHUB_TOKEN is required')

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
}

async function github(method, url, { body, extraHeaders } = {}) {
  const response = await fetch(/^https?:\/\//.test(url) ? url : `${API}${url}`, {
    method,
    headers: { ...headers, ...extraHeaders },
    body,
  })
  if (!response.ok) {
    throw new Error(`${method} ${url}: HTTP ${response.status} ${await response.text()}`)
  }
  return response.status === 204 ? null : response.json()
}

async function listAssets(releaseId) {
  const assets = []
  for (let page = 1; ; page += 1) {
    const batch = await github(
      'GET',
      `/repos/${REPO}/releases/${releaseId}/assets?per_page=100&page=${page}`
    )
    assets.push(...batch)
    if (batch.length < 100) return assets
  }
}

// The asset endpoint answers with a redirect to signed blob storage. Follow it
// by hand and WITHOUT the token: the signed URL is its own credential, and the
// storage host rejects a request that carries a second one.
async function downloadAsset(asset) {
  const response = await fetch(`${API}/repos/${REPO}/releases/assets/${asset.id}`, {
    headers: { ...headers, Accept: 'application/octet-stream' },
    redirect: 'manual',
  })
  const location = response.headers.get('location')
  const blob =
    location && response.status >= 300 && response.status < 400 ? await fetch(location) : response
  if (!blob.ok) throw new Error(`download ${asset.name}: HTTP ${blob.status}`)
  return Buffer.from(await blob.arrayBuffer())
}

async function perform(release, action) {
  const { asset, to } = action
  if (dryRun) {
    console.log(`would ${action.type} ${asset.name} -> ${to}`)
    return
  }
  if (action.type === 'rename') {
    // A label that merely repeats the old name would keep the versioned name
    // on the release page, so it moves with the name. Any other label is the
    // uploader's and stays.
    const body = { name: to }
    if (asset.label && asset.label === asset.name) body.label = to
    await github('PATCH', `/repos/${REPO}/releases/assets/${asset.id}`, {
      body: JSON.stringify(body),
      extraHeaders: { 'Content-Type': 'application/json' },
    })
  } else {
    const bytes = await downloadAsset(asset)
    const uploadUrl = new URL(release.upload_url.replace(/\{.*\}$/, ''))
    uploadUrl.searchParams.set('name', to)
    uploadUrl.searchParams.set('label', to)
    await github('POST', uploadUrl.toString(), {
      body: bytes,
      extraHeaders: { 'Content-Type': asset.content_type || 'application/octet-stream' },
    })
  }
  console.log(`${action.type === 'rename' ? 'renamed' : 'copied'} ${asset.name} -> ${to}`)
}

async function main() {
  const release = await github('GET', `/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`)
  const deadline = Date.now() + waitMinutes * 60_000

  for (;;) {
    const { actions, missing, done } = planReleaseAssets(await listAssets(release.id), tag)
    for (const name of done) console.log(`ok ${name}`)
    for (const action of actions) await perform(release, action)

    if (missing.length === 0) {
      console.log(`${tag}: every README download link resolves on this release`)
      return
    }
    if (dryRun || Date.now() >= deadline) {
      const message =
        `${tag}: still missing ${missing.join(', ')} ` +
        `(neither the stable name nor its ${tag} upload is on the release)`
      if (dryRun) {
        console.log(message)
        return
      }
      die(`${message}; the README links to these 404 while ${tag} is the latest release`)
    }
    console.log(`waiting ${pollSeconds}s for: ${missing.join(', ')}`)
    await sleep(pollSeconds * 1000)
  }
}

try {
  await main()
} catch (error) {
  die(error instanceof Error ? error.message : String(error))
}
