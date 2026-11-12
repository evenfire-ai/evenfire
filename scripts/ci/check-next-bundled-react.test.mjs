import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { bundledVersion, checkApp, versionVerdict } from './check-next-bundled-react.mjs'

const SCRIPT = fileURLToPath(new URL('./check-next-bundled-react.mjs', import.meta.url))
const REAL_ADVISORIES = fileURLToPath(
  new URL('./next-bundled-react-advisories.json', import.meta.url)
)
const MARKER = 'Cannot transport a detached buffer'
const CANARY = '19.3.0-canary-278794d7-20261002'
const RSC_FILES = [
  'react-server-dom-webpack/cjs/react-server-dom-webpack-server.node.production.js',
  'react-server-dom-webpack/cjs/react-server-dom-webpack-server.edge.production.js',
  'react-server-dom-turbopack/cjs/react-server-dom-turbopack-server.node.production.js',
  'next-server/app-page.runtime.prod.js',
]
const ADVISORY = {
  id: 'CVE-TEST-1',
  severity: 'critical',
  fixedReactVersions: ['19.0.9', '19.1.10', '19.2.9', '19.3.1'],
  fixMarker: MARKER,
  markerFiles: [
    '^react-server-dom-(webpack|turbopack)/cjs/react-server-dom-(webpack|turbopack)-server\\.(node|edge)\\.(production|development)\\.js$',
    '^next-server/app-page(-turbo)?\\.runtime\\.(prod|dev)\\.js$',
  ],
}

const roots = []
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true })
})

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

// A minimal app dir with node_modules/next laid out like a published next.
function fakeApp({ nextVersion = '16.4.6', reactVersion = CANARY, patched = RSC_FILES } = {}) {
  const app = mkdtempSync(join(tmpdir(), 'next-bundled-react-'))
  roots.push(app)
  const next = join(app, 'node_modules', 'next')
  const compiled = join(next, 'dist', 'compiled')
  write(join(next, 'package.json'), JSON.stringify({ name: 'next', version: nextVersion }))
  write(
    join(compiled, 'react', 'package.json'),
    JSON.stringify({ name: 'react-builtin', main: 'index.js' })
  )
  write(
    join(compiled, 'react', 'cjs', 'react.production.js'),
    `exports.version = "${reactVersion}";`
  )
  for (const flavour of ['webpack', 'turbopack']) {
    write(
      join(compiled, `react-server-dom-${flavour}`, 'package.json'),
      JSON.stringify({
        name: `react-server-dom-${flavour}-builtin`,
        peerDependencies: { react: reactVersion, 'react-dom': reactVersion },
      })
    )
  }
  for (const rel of RSC_FILES) {
    write(join(compiled, rel), patched.includes(rel) ? `throw Error("${MARKER}")` : 'decode()')
  }
  // Source maps quote the marker even in a vulnerable build's neighbours; they must not count.
  write(join(compiled, 'next-server', 'app-page.runtime.prod.js.map'), MARKER)
  return app
}

test('reads the bundled versions from build output when package.json has no version', () => {
  const app = fakeApp()
  const compiled = join(app, 'node_modules', 'next', 'dist', 'compiled')
  assert.equal(bundledVersion(compiled, 'react'), CANARY)
  assert.equal(bundledVersion(compiled, 'react-server-dom-webpack'), CANARY)
  assert.equal(bundledVersion(compiled, 'react-dom'), null)
})

test('passes when every RSC server file carries the fix marker', () => {
  const report = checkApp(fakeApp(), [ADVISORY])
  assert.equal(report.ok, true)
  assert.equal(report.nextVersion, '16.4.6')
  assert.equal(report.bundledReact['react-server-dom-turbopack'], CANARY)
  assert.equal(report.advisories[0].status, 'fixed')
})

test('fails when the marker is missing, even with the same React version string', () => {
  // next 16.4.0 and 16.4.6 bundle the same canary string; only the marker differs.
  const report = checkApp(fakeApp({ nextVersion: '16.4.0', patched: [] }), [ADVISORY])
  assert.equal(report.ok, false)
  assert.equal(report.advisories[0].status, 'vulnerable')
  assert.equal(report.advisories[0].files.length, RSC_FILES.length)
})

test('fails when only the prebundled app-page runtime lacks the fix', () => {
  const patched = RSC_FILES.filter(rel => !rel.startsWith('next-server/'))
  const report = checkApp(fakeApp({ patched }), [ADVISORY])
  assert.equal(report.ok, false)
  assert.deepEqual(report.advisories[0].files, ['next-server/app-page.runtime.prod.js'])
})

test('fails closed when a marker pattern matches no file (next layout changed)', () => {
  const advisory = {
    ...ADVISORY,
    markerFiles: [...ADVISORY.markerFiles, '^renamed-runtime/.*\\.js$'],
  }
  const report = checkApp(fakeApp(), [advisory])
  assert.equal(report.ok, false)
  assert.equal(report.advisories[0].status, 'unverifiable')
  assert.match(report.advisories[0].reason, /renamed-runtime/)
})

test('fails when next is not installed', () => {
  const app = mkdtempSync(join(tmpdir(), 'next-bundled-react-'))
  roots.push(app)
  const report = checkApp(app, [ADVISORY])
  assert.equal(report.ok, false)
  assert.match(report.error, /next is not installed/)
})

test('version-only advisories decide stable builds and refuse canaries', () => {
  const versionOnly = {
    id: 'CVE-TEST-2',
    severity: 'high',
    fixedReactVersions: ['19.1.10', '19.2.9'],
  }
  assert.equal(checkApp(fakeApp({ reactVersion: '19.2.9' }), [versionOnly]).ok, true)
  const old = checkApp(fakeApp({ reactVersion: '19.2.8' }), [versionOnly])
  assert.equal(old.advisories[0].status, 'vulnerable')
  const canary = checkApp(fakeApp(), [versionOnly])
  assert.equal(canary.advisories[0].status, 'unverifiable')
  assert.match(canary.advisories[0].reason, /fixMarker/)
})

test('versionVerdict orders releases within and across fixed lines', () => {
  const fixed = ['19.0.9', '19.1.10', '19.2.9', '19.3.1']
  assert.equal(versionVerdict('19.1.9', fixed).status, 'vulnerable')
  assert.equal(versionVerdict('19.1.10', fixed).status, 'fixed')
  assert.equal(versionVerdict('19.1.12', fixed).status, 'fixed')
  assert.equal(versionVerdict('18.3.1', fixed).status, 'vulnerable')
  assert.equal(versionVerdict('19.4.0', fixed).status, 'fixed')
  assert.equal(versionVerdict('19.3.0', fixed).status, 'vulnerable')
  assert.equal(versionVerdict('19.3.0-canary-cbb046ab-20260731', fixed).status, 'unverifiable')
  assert.equal(versionVerdict('not-a-version', fixed).status, 'unverifiable')
  assert.equal(versionVerdict('20.1.0', ['19.0.9', '21.0.1']).status, 'unverifiable')
})

test('the shipped advisory table is well formed', () => {
  const { advisories } = JSON.parse(readFileSync(REAL_ADVISORIES, 'utf8'))
  assert.ok(advisories.length > 0)
  for (const advisory of advisories) {
    assert.match(advisory.id, /^(CVE|GHSA)-/)
    assert.ok(['low', 'moderate', 'high', 'critical'].includes(advisory.severity))
    assert.ok(advisory.fixedReactVersions.length > 0)
    for (const version of advisory.fixedReactVersions) assert.match(version, /^\d+\.\d+\.\d+$/)
    if (advisory.fixMarker) {
      assert.ok(advisory.markerFiles.length > 0)
      for (const source of advisory.markerFiles) assert.doesNotThrow(() => new RegExp(source))
    }
  }
})

test('CLI exits 1 for a vulnerable app and 0 for a fixed one', () => {
  const advisories = join(fakeApp(), 'advisories.json')
  writeFileSync(advisories, JSON.stringify({ advisories: [ADVISORY] }))
  const bad = spawnSync(
    process.execPath,
    [SCRIPT, '--advisories', advisories, fakeApp({ patched: [] })],
    {
      encoding: 'utf8',
    }
  )
  assert.equal(bad.status, 1, bad.stdout + bad.stderr)
  assert.match(bad.stdout, /FAIL .*next@16\.4\.6/)
  const good = spawnSync(
    process.execPath,
    [SCRIPT, '--advisories', advisories, '--json', fakeApp()],
    {
      encoding: 'utf8',
    }
  )
  assert.equal(good.status, 0, good.stdout + good.stderr)
  assert.equal(JSON.parse(good.stdout)[0].ok, true)
  const usage = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
  assert.equal(usage.status, 2)
})
