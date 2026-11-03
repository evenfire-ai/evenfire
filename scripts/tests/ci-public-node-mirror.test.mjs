import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const root = new URL('../../', import.meta.url)
const workflow = readFileSync(new URL('.github/workflows/ci-public.yml', root), 'utf8')
const publish = readFileSync(new URL('.github/workflows/build-publish.yml', root), 'utf8')

test('Desktop real-token producer contracts install Control API dependencies', () => {
  const contract = readFileSync(
    new URL('desktop-app/src/__tests__/appService.memoryOnlySessionClock.regression.test.ts', root),
    'utf8'
  )
  assert.match(
    contract,
    /import\('\.\.\/\.\.\/\.\.\/control-api\/src\/utils\/auth\/externalSessionAuthToken\.js'\)/
  )
  const step = workflow
    .slice(workflow.indexOf('- name: Install Control API producer dependencies'))
    .split('\n      - name:')[0]
  const condition = step.match(/^\s+if:\s*(.+)$/m)?.[1]
  assert.ok(condition, 'The producer dependency step must select its consumer jobs')
  assert.match(condition, /^matrix\.service == '[a-z-]+'(?: \|\| matrix\.service == '[a-z-]+')*$/)
  const services = [...condition.matchAll(/matrix\.service == '([a-z-]+)'/g)].map(match => match[1])
  assert.ok(
    services.includes('desktop-app'),
    'The Desktop job must install its real token producer'
  )
  assert.ok(services.includes('external-rest-api'), 'Keep the existing producer consumer')
  assert.match(step, /working-directory: control-api/)
  assert.match(step, /run: npm ci/)
})

for (const service of ['profile-ui', 'mcp-servers/web-search']) {
  test(`${service} uses mirrored Node in public CI and keeps its production default`, () => {
    const dockerfile = readFileSync(new URL(`${service}/Dockerfile`, root), 'utf8')
    const stages = dockerfile.split('\n').filter(line => line.startsWith('FROM '))
    assert.equal(stages.length, 2)
    assert.match(dockerfile, /^ARG NODE_IMAGE=node:24\.22\.1-alpine\n/)
    for (const stage of stages) assert.match(stage, /^FROM \$\{NODE_IMAGE\}(?: AS builder)?$/)
    const step =
      service === 'profile-ui'
        ? workflow.slice(workflow.indexOf('- name: Build Profile UI image builder stage'))
        : workflow.slice(workflow.indexOf('- name: Test web-search image'))
    const command = step.split('\n').find(line => line.includes('docker build'))
    assert.ok(command, 'CI build command must exist')
    assert.match(command, /--build-arg NODE_IMAGE=mirror\.gcr\.io\/library\/node:24\.22\.1-alpine/)
    assert.doesNotMatch(publish, /NODE_IMAGE/)
  })
}

test('public CI runs the Node mirror contract', () => {
  const step = workflow
    .slice(workflow.indexOf('- name: Test subscription image fixtures and memory calibration'))
    .split('\n      - name:')[0]
  assert.match(step, /^\s+scripts\/tests\/ci-public-node-mirror\.test\.mjs\s*\\?$/m)
})
