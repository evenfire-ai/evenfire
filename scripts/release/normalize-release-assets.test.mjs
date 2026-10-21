// Drives normalize-release-assets.mjs end to end against a local stand-in for
// the GitHub releases API, so the HTTP half (rename, copy through the signed
// redirect, polling, the timeout failure) is proven without touching GitHub.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { DESKTOP_PLATFORMS } from './release-assets.mjs'

const SCRIPT = fileURLToPath(new URL('./normalize-release-assets.mjs', import.meta.url))
const TOKEN = 'test-token'

// A minimal releases API: one release, its assets, rename, download (via a
// redirect, as GitHub does), and upload. `pending` assets appear only after
// the given number of asset listings, to model builds uploaded late.
async function fakeGitHub({ tag, assets, pending = [] }) {
  const state = { assets: [], requests: [], blobAuth: [], listings: 0, nextId: 1 }
  const add = a => state.assets.push({ id: state.nextId++, label: '', state: 'uploaded', ...a })
  assets.forEach(add)

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      state.requests.push(`${req.method} ${url.pathname}`)
      const json = (status, value) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(value))
      }
      if (url.pathname.startsWith('/blob/')) {
        state.blobAuth.push(req.headers.authorization ?? null)
        const source = state.assets.find(a => String(a.id) === url.pathname.slice(6))
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
        return res.end(source.bytes)
      }
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, {})
      const { port } = server.address()
      if (req.method === 'GET' && url.pathname === `/repos/o/r/releases/tags/${tag}`) {
        return json(200, {
          id: 7,
          upload_url: `http://127.0.0.1:${port}/upload/7/assets{?name,label}`,
        })
      }
      if (req.method === 'GET' && url.pathname === '/repos/o/r/releases/7/assets') {
        state.listings += 1
        for (const p of pending.filter(p => p.afterListings === state.listings)) add(p.asset)
        return json(
          200,
          state.assets.map(({ bytes, ...rest }) => rest)
        )
      }
      const assetMatch = url.pathname.match(/^\/repos\/o\/r\/releases\/assets\/(\d+)$/)
      if (assetMatch) {
        const target = state.assets.find(a => String(a.id) === assetMatch[1])
        if (req.method === 'PATCH') {
          Object.assign(target, JSON.parse(body.toString()))
          return json(200, target)
        }
        res.writeHead(302, { Location: `http://127.0.0.1:${port}/blob/${target.id}` })
        return res.end()
      }
      if (req.method === 'POST' && url.pathname === '/upload/7/assets') {
        add({
          name: url.searchParams.get('name'),
          label: url.searchParams.get('label'),
          content_type: req.headers['content-type'],
          bytes: body,
        })
        return json(201, {})
      }
      json(404, { path: url.pathname })
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, state, api: `http://127.0.0.1:${server.address().port}` }
}

function run(api, args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, GITHUB_API_URL: api, GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: TOKEN },
    })
    let output = ''
    child.stdout.on('data', d => (output += d))
    child.stderr.on('data', d => (output += d))
    child.on('close', code => resolve({ code, output }))
  })
}

function versionedRelease(tag) {
  return [
    ...DESKTOP_PLATFORMS.map(platform => ({
      name: `evenfire-desktop-${tag}-${platform}.zip`,
      content_type: 'application/zip',
    })),
    {
      name: `release-images-${tag}.json`,
      label: `release-images-${tag}.json`,
      content_type: 'application/json',
      bytes: Buffer.from('{"images":[]}'),
    },
  ]
}

test('renames the zips, copies the manifest without leaking the token, then is a no-op', async t => {
  const gh = await fakeGitHub({ tag: 'v0.10.0', assets: versionedRelease('v0.10.0') })
  t.after(() => gh.server.close())

  const first = await run(gh.api, ['--tag', 'v0.10.0'])
  assert.equal(first.code, 0, first.output)
  const names = gh.state.assets.map(a => a.name).sort()
  assert.deepEqual(
    names,
    [
      ...DESKTOP_PLATFORMS.map(platform => `evenfire-desktop-${platform}.zip`),
      'release-images-v0.10.0.json',
      'release-images.json',
    ].sort()
  )
  const copy = gh.state.assets.find(a => a.name === 'release-images.json')
  assert.equal(copy.bytes.toString(), '{"images":[]}')
  assert.equal(copy.label, 'release-images.json')
  assert.equal(copy.content_type, 'application/json')
  // The signed blob URL is its own credential; the token must not follow it.
  assert.deepEqual(gh.state.blobAuth, [null])

  const before = gh.state.requests.length
  const second = await run(gh.api, ['--tag', 'v0.10.0'])
  assert.equal(second.code, 0, second.output)
  const writes = gh.state.requests.slice(before).filter(r => !r.startsWith('GET'))
  assert.deepEqual(writes, [])
})

test('waits for builds uploaded after the release is published', async t => {
  const all = versionedRelease('v0.11.0')
  const manifest = all.at(-1)
  const zips = all.slice(0, -1)
  const gh = await fakeGitHub({
    tag: 'v0.11.0',
    assets: [manifest],
    pending: zips.map(asset => ({ afterListings: 2, asset })),
  })
  t.after(() => gh.server.close())

  const result = await run(gh.api, [
    '--tag',
    'v0.11.0',
    '--wait-minutes',
    '1',
    '--poll-seconds',
    '0',
  ])
  assert.equal(result.code, 0, result.output)
  assert.match(result.output, /waiting 0s for: evenfire-desktop-mac-arm64\.zip/)
  assert.ok(gh.state.assets.some(a => a.name === 'evenfire-desktop-linux-x64.zip'))
})

test('fails loudly when a build never arrives', async t => {
  const gh = await fakeGitHub({
    tag: 'v0.11.0',
    assets: versionedRelease('v0.11.0').filter(a => !a.name.includes('windows-arm64')),
  })
  t.after(() => gh.server.close())

  const result = await run(gh.api, ['--tag', 'v0.11.0'])
  assert.equal(result.code, 1)
  assert.match(
    result.output,
    /::error::v0\.11\.0: still missing evenfire-desktop-windows-arm64\.zip/
  )
  // Everything that WAS there is still normalized before failing.
  assert.ok(gh.state.assets.some(a => a.name === 'evenfire-desktop-mac-arm64.zip'))
})

test('--dry-run reports the plan and writes nothing', async t => {
  const gh = await fakeGitHub({ tag: 'v0.10.0', assets: versionedRelease('v0.10.0') })
  t.after(() => gh.server.close())

  const result = await run(gh.api, ['--tag', 'v0.10.0', '--dry-run'])
  assert.equal(result.code, 0, result.output)
  assert.match(
    result.output,
    /would rename evenfire-desktop-v0\.10\.0-mac-arm64\.zip -> evenfire-desktop-mac-arm64\.zip/
  )
  assert.match(result.output, /would copy release-images-v0\.10\.0\.json -> release-images\.json/)
  assert.deepEqual(
    gh.state.requests.filter(r => !r.startsWith('GET')),
    []
  )
})

test('refuses a malformed tag before calling the API', async t => {
  const gh = await fakeGitHub({ tag: 'v0.10.0', assets: [] })
  t.after(() => gh.server.close())

  const result = await run(gh.api, ['--tag', '../../x'])
  assert.equal(result.code, 1)
  assert.match(result.output, /--tag must look like v1\.2\.3/)
  assert.deepEqual(gh.state.requests, [])
})
