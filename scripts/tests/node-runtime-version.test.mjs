import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertNodeVersion, minimumNodeVersion } from '../check-node-version.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))

test('the repository pins the October 2026 Node 24 security release', () => {
  assert.equal(minimumNodeVersion, '24.22.1')
})

test('the minimum rejects earlier patches, older majors and prereleases', () => {
  for (const version of [
    '20.19.0',
    '23.11.0',
    '24.0.0',
    '24.16.0',
    '24.18.0',
    '24.21.0',
    '24.22.0',
    '24.22.1-rc.1',
    '24',
    'invalid',
  ]) {
    assert.throws(() => assertNodeVersion(version), /is required/)
    assert.throws(() => assertNodeVersion(version, { major: 24 }), /is required/)
  }
})

test('the patched runtime and later Node 24 patches satisfy both contracts', () => {
  for (const version of ['24.22.1', '24.22.2', '24.23.0']) {
    assert.doesNotThrow(() => assertNodeVersion(version))
    assert.doesNotThrow(() => assertNodeVersion(version, { major: 24 }))
  }
})

test('the quickstart permits newer majors while Desktop retains Node 24', () => {
  assert.doesNotThrow(() => assertNodeVersion('26.12.1'))
  assert.throws(() => assertNodeVersion('26.12.1', { major: 24 }), /24.x/)
})

test('the staged Desktop verifier keeps its policy and rejects missing policy files', () => {
  const context = mkdtempSync(path.join(tmpdir(), 'node-runtime-context-'))
  try {
    for (const filename of [
      '.nvmrc',
      'scripts/check-node-version.mjs',
      'desktop-app/scripts/verify-electron-runtime.mjs',
    ]) {
      const destination = path.join(context, filename)
      mkdirSync(path.dirname(destination), { recursive: true })
      copyFileSync(path.join(root, filename), destination)
    }
    // This unit fixture supplies an executable path without launching Electron.
    // It exercises version admission and the staged source-file closure.
    const electron = path.join(context, 'desktop-app/node_modules/electron')
    mkdirSync(electron, { recursive: true })
    const runtime = path.join(electron, 'runtime')
    writeFileSync(runtime, '#!/bin/sh\nexit 0\n')
    chmodSync(runtime, 0o755)
    writeFileSync(
      path.join(electron, 'package.json'),
      JSON.stringify({ type: 'module', main: 'index.js' })
    )
    writeFileSync(path.join(electron, 'index.js'), `export default ${JSON.stringify(runtime)};\n`)
    const verifier = pathToFileURL(
      path.join(context, 'desktop-app/scripts/verify-electron-runtime.mjs')
    ).href
    const run = version =>
      spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          "Object.defineProperty(process.versions, 'node', { value: process.argv[1] }); await import(process.argv[2])",
          version,
          verifier,
        ],
        { encoding: 'utf8', timeout: 5_000 }
      )
    assert.equal(run('24.22.1').status, 0)
    const unpatched = run('24.22.0')
    assert.equal(unpatched.status, 1)
    assert.match(unpatched.stderr, /24\.22\.1 is required/)
    rmSync(path.join(context, '.nvmrc'))
    assert.equal(run('24.22.1').status, 1)
    copyFileSync(path.join(root, '.nvmrc'), path.join(context, '.nvmrc'))
    rmSync(path.join(context, 'scripts/check-node-version.mjs'))
    assert.equal(run('24.22.1').status, 1)
  } finally {
    rmSync(context, { recursive: true, force: true })
  }
})

test('every CI setup-node step uses the repository pin', () => {
  const workflow = readFileSync(
    new URL('../../.github/workflows/ci-public.yml', import.meta.url),
    'utf8'
  )
  const setups = workflow.split(/\n\s+- uses: actions\/setup-node@[^\n]+/).slice(1)
  assert.ok(setups.length > 0)
  for (const setup of setups) {
    const configuration = setup.split(/\n\s+- (?:name:|uses:)/)[0]
    assert.match(configuration, /node-version-file: \.nvmrc/)
    assert.doesNotMatch(configuration, /node-version:/)
  }
})

function checkNodeImages(source, filename) {
  // Builtin module imports are not image references. Retain complete image
  // tags so aliases such as latest/alpine cannot disappear from the gate.
  const images =
    source
      .split('\n')
      .filter(line => !/^\s*(?:#|\/\/|\*)/.test(line))
      .join('\n')
      .replace(/--chown=[^\s]+/g, '')
      .replace(/\b(?:from|import)\s+['"]node:[^'"]+['"]/g, '')
      .replace(/\b(?:require|import)\(\s*['"]node:[^'"]+['"]\s*\)/g, '')
      .match(/\bnode(?::[A-Za-z0-9][A-Za-z0-9_.-]*(?:@sha256:[a-f0-9]+)?|@sha256:[a-f0-9]+)/g) ?? []
  for (const image of images) {
    const version = /^node:(\d+\.\d+\.\d+)(?:-|@|$)/.exec(image)?.[1]
    assert.ok(version, `${filename}: image must pin a complete Node version: ${image}`)
    assert.doesNotThrow(() => assertNodeVersion(version, { major: 24 }), `${filename}: ${image}`)
  }
  return images.length
}

test('image admission rejects floating aliases and old patches in build and executable sources', () => {
  for (const source of [
    'FROM node:latest',
    'ARG NODE_IMAGE=node:alpine',
    'image: node:24-alpine',
    "image ?? 'node:24.22.0-alpine'",
    "const image = 'node:latest'",
    `FROM node@sha256:${'a'.repeat(64)}`,
  ])
    assert.throws(() => checkNodeImages(source, 'unit-image-source'))
  assert.equal(checkNodeImages("image ?? 'node:24.22.1-alpine'", 'unit-image-source'), 1)
  assert.equal(
    checkNodeImages("import fs from 'node:fs'; require('node:http')", 'unit-image-source'),
    0
  )
  assert.equal(checkNodeImages('COPY --chown=node:node server.js ./', 'unit-image-source'), 0)
})

test('tracked direct Node images and executable image defaults pin a patched Node 24 version', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0')
  const executableSources = new Set([
    'scripts/minikube/build-images.sh',
    'mcp-servers/web-search/test/run-network.mjs',
    'desktop-app/test/e2e-playwright/third-party-authn-third-party-mcphost/figureDProviderResources.ts',
  ])
  let references = 0
  for (const filename of files) {
    if (
      !/(?:Dockerfile(?:\.[^/]*)?|[^/]+\.Dockerfile|[^/]+\.base-image|[^/]+\.ya?ml)$/.test(
        filename
      ) &&
      !executableSources.has(filename)
    )
      continue
    references += checkNodeImages(
      readFileSync(new URL(`../../${filename}`, import.meta.url), 'utf8'),
      filename
    )
  }
  assert.ok(references > 0)
})
