import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { DERIVED_FIXTURES, EXPECTED_IMAGES } from './approved-tools-image-proof.mjs'

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const profile = 'clerum-fix-fixture-1234abcd'
const head = 'a'.repeat(40)
const originalImage = 'clerum/codex-llm-proxy:test'

function fixture(mode, duringRunner) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'approved-tools-signal-')))
  const copy = name => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
    fs.copyFileSync(path.join(sourceRoot, name), path.join(root, name))
  }
  for (const name of [
    'scripts/e2e/prepare-codex-approved-tools.mjs',
    'scripts/e2e/approved-tools-connection-journal.mjs',
    'scripts/e2e/approved-tools-control-api-lifecycle.mjs',
    'scripts/e2e/approved-tools-image-proof.mjs',
    'scripts/e2e/approved-tools-resource-cleanup.mjs',
    'scripts/release/images-manifest.mjs',
    'tests/e2e/fixtures/codex-subscription/approved-tools-setup/identity-lifecycle.mjs',
    'tests/e2e/fixtures/codex-subscription/approved-tools-setup/seed.mjs',
    'tests/e2e/fixtures/codex-subscription/approved-tools-oauth/provider.mjs',
    'deploy/images.json',
  ]) copy(name)
  const write = (name, value, mode = 0o600) => {
    const file = path.join(root, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, value, { mode })
    return file
  }
  const ids = Object.fromEntries(EXPECTED_IMAGES.map((ref, index) =>
    [ref, `sha256:${String(index + 1).repeat(64)}`]))
  write('deploy/minikube/.image-manifest.json', JSON.stringify({
    profile,
    images: ids,
    sourceRevisions: Object.fromEntries(EXPECTED_IMAGES.map(ref => [ref, head])),
    derivedFrom: Object.fromEntries(DERIVED_FIXTURES.map(({ ref, base }) =>
      [ref, { ref: base, id: ids[base] }])),
  }))
  const deployment = {
    metadata: { uid: 'owned-proxy', resourceVersion: '1' },
    spec: { template: { metadata: { annotations: {} }, spec: { containers: [{
      name: 'codex-llm-proxy', image: originalImage, imagePullPolicy: 'IfNotPresent', env: [],
    }] } } },
  }
  const deploymentFile = write('deployment.json', JSON.stringify(deployment))
  const apiFile = write('control-api.json', JSON.stringify({
    metadata: { uid: 'owned-api', resourceVersion: '1' },
    spec: { template: { metadata: { annotations: {} }, spec: {
      volumes: [], containers: [{ name: 'control-api', image: 'clerum/control-api:test',
        imagePullPolicy: 'IfNotPresent', env: [], volumeMounts: [] }],
    } } },
  }))
  const resourcesFile = write('resources.json', '{}')
  const events = write('events.log', '')
  const forwardPid = write('forward.pid', '')
  const runnerPid = write('runner.pid', '')
  const inventory = write('inventory.json', JSON.stringify(EXPECTED_IMAGES.map(ref =>
    ({ repoTags: [ref], id: ids[ref] }))))
  write('scripts/minikube/require-t2-mutation-lock.sh',
    '#!/usr/bin/env bash\nprintf "lease-checked\\n" >> "$TEST_EVENTS"\n')
  write('scripts/minikube/run-with-deadline.mjs', `
import fs from 'node:fs'
fs.writeFileSync(process.env.TEST_RUNNER_PID, String(process.pid))
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  fs.appendFileSync(process.env.TEST_EVENTS, 'runner-closed\\n')
  process.exit(signal === 'SIGINT' ? 130 : 143)
})
fs.appendFileSync(process.env.TEST_EVENTS, 'runner-started\\n')
setInterval(() => {}, 1000)
`)
  write('scripts/e2e/codex-approved-tools-pf-owner.sh', `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  record) printf '%s' "$3" > "$2" ;;
  matches) test -f "$2" ;;
  cleanup)
    if test -f "$2"; then
      kill -TERM "$(cat "$2")"
      rm "$2"
      printf 'cleanup-forward\\n' >> "$TEST_EVENTS"
    fi ;;
  *) exit 2 ;;
esac
`, 0o700)
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  write('bin/git', `#!${process.execPath}
process.stdout.write('${head}\\n')
`, 0o700)
  write('bin/minikube', `#!${process.execPath}
process.stdout.write(require('node:fs').readFileSync(process.env.TEST_INVENTORY))
`, 0o700)
  write('bin/kubectl', `#!${process.execPath}
const fs = require('node:fs')
const http = require('node:http')
const args = process.argv.slice(2)
const event = name => fs.appendFileSync(process.env.TEST_EVENTS, name + '\\n')
const verb = args.find(value => ['get', 'patch', 'rollout', 'port-forward', 'exec', 'create', 'delete'].includes(value))
const target = args[args.indexOf(verb) + 1]
if (verb === 'get') {
  if (target === 'deployment/control-api') process.stdout.write(fs.readFileSync(process.env.TEST_API))
  else if (target === 'service/codex-llm-proxy') process.stdout.write(JSON.stringify({ spec: { ports: [{ port: 9090 }] } }))
  else if (target === 'configmap/mcp-host-config') process.stdout.write(JSON.stringify({ data: { MCP_HOST_CODEX_SUBSCRIPTION_ENABLED: 'true' } }))
  else if (args.includes('--ignore-not-found=true')) {
    const resources = JSON.parse(fs.readFileSync(process.env.TEST_RESOURCES))
    const name = target.split('/').at(-1)
    if (resources[name]) process.stdout.write(JSON.stringify(resources[name]))
  } else process.stdout.write(fs.readFileSync(process.env.TEST_DEPLOYMENT))
} else if (verb === 'patch') {
  const patch = JSON.parse(args[args.indexOf('-p') + 1])
  const file = target === 'deployment/control-api' ? process.env.TEST_API : process.env.TEST_DEPLOYMENT
  const deployment = JSON.parse(fs.readFileSync(file))
  const container = patch.spec.template.spec.containers[0]
  if (target === 'deployment/codex-llm-proxy' && container.image === '${originalImage}' && process.env.TEST_RESTORE_FAIL === '1') {
    event('restore-attempt')
    process.exit(1)
  }
  deployment.metadata.resourceVersion = String(Number(deployment.metadata.resourceVersion) + 1)
  deployment.spec.template.spec.containers[0] = container
  const annotation = patch.spec.template.metadata.annotations['evenfire.ai/codex-tools-fixture-run']
  if (annotation === null) delete deployment.spec.template.metadata.annotations['evenfire.ai/codex-tools-fixture-run']
  else deployment.spec.template.metadata.annotations['evenfire.ai/codex-tools-fixture-run'] = annotation
  if (target === 'deployment/control-api') deployment.spec.template.spec.volumes = patch.spec.template.spec.volumes
  fs.writeFileSync(file, JSON.stringify(deployment))
  event(target === 'deployment/control-api' ? 'api-patch' :
    container.image === '${originalImage}' ? 'restore-applied' : 'patch-applied')
} else if (verb === 'rollout') {
  event('rollout')
} else if (verb === 'exec') {
  if (args.at(-1).includes('approved-tools-oauth-active.json')) {
    const api = JSON.parse(fs.readFileSync(process.env.TEST_API))
    process.stdout.write(JSON.stringify({ pid: 1, run: api.spec.template.metadata.annotations['evenfire.ai/codex-tools-fixture-run'], profile: process.env.MINIKUBE_PROFILE }))
  } else process.stdout.write('true')
} else if (verb === 'create') {
  const proposed = JSON.parse(fs.readFileSync(0, 'utf8'))
  if (args.includes('--dry-run=server')) process.stdout.write(JSON.stringify(proposed))
  else {
    const resources = JSON.parse(fs.readFileSync(process.env.TEST_RESOURCES))
    const created = { ...proposed, metadata: { ...proposed.metadata,
      uid: 'owned-' + String(Object.keys(resources).length + 1), resourceVersion: '1' } }
    resources[created.metadata.name] = created
    fs.writeFileSync(process.env.TEST_RESOURCES, JSON.stringify(resources))
    process.stdout.write(JSON.stringify(created))
  }
} else if (verb === 'delete') {
  const resources = JSON.parse(fs.readFileSync(process.env.TEST_RESOURCES))
  delete resources[args[args.indexOf('--raw') + 1].split('/').at(-1)]
  fs.writeFileSync(process.env.TEST_RESOURCES, JSON.stringify(resources))
} else if (verb === 'port-forward') {
  const port = Number(args.at(-1).split(':')[0])
  const server = http.createServer((request, response) => {
    event('evidence-request')
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ injected503: process.env.TEST_READY === '1' ? 0 : 1, forwarded: 0 }))
  })
  server.listen(port, '127.0.0.1', () => event('forward-started'))
  fs.writeFileSync(process.env.TEST_FORWARD_PID, String(process.pid))
  process.on('SIGTERM', () => {
    event('forward-exited')
    server.close(() => process.exit(0))
  })
} else {
  process.exit(2)
}
`, 0o700)
  const evidence = path.join(root, '.local-notes/infra/runs/one')
  fs.mkdirSync(evidence, { recursive: true })
  fs.mkdirSync(path.join(root, 'profiles', profile, 'pids'), { recursive: true })
  const scenarios = [83, 150, 250].map(catalogSize => ({
    catalogSize, runId: `approved-tools-${String(catalogSize).padStart(12, '0')}`,
    agentName: `agent-${catalogSize}`, agentDisplayName: `Agent ${catalogSize}`,
    modelName: 'test-model', fixtureUrl: `http://127.0.0.1:${43000 + catalogSize}/`,
  }))
  return {
    root, evidence, deploymentFile, events, forwardPid, runnerPid,
    env: {
      ...process.env,
      PATH: `${bin}:/bin`,
      MINIKUBE_PROFILE: profile,
      CONTROL_API_REAL_PG_CONTEXT: profile,
      APPROVED_TOOLS_CANONICAL_ROOT: root,
      APPROVED_TOOLS_EVIDENCE_DIR: evidence,
      APPROVED_TOOLS_UPSTREAM_MODE: mode,
      CODEX_REAL_UPSTREAM_CONFIRM: '1',
      APPROVED_TOOLS_SCENARIOS: JSON.stringify(scenarios),
      TEST_USER_EMAIL: 'fixture@example.test',
      TEST_USER_PASSWORD: 'fixture-password',
      T2_PROFILE_ROOT: path.join(root, 'profiles'),
      TEST_EVENTS: events,
      TEST_DEPLOYMENT: deploymentFile,
      TEST_INVENTORY: inventory,
      TEST_API: apiFile,
      TEST_RESOURCES: resourcesFile,
      TEST_FORWARD_PID: forwardPid,
      TEST_RUNNER_PID: runnerPid,
      TEST_READY: duringRunner ? '1' : '0',
      TEST_ADMIN_USERNAME: 'fixture-admin',
      TEST_ADMIN_PASSWORD: 'fixture-admin-password',
      APPROVED_TOOLS_UNAUTHORIZED_PASSWORD: 'fixture-unauthorized-password',
    },
  }
}

async function waitForEvent(file, name) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (fs.readFileSync(file, 'utf8').split('\n').includes(name)) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for ${name}: ${fs.readFileSync(file, 'utf8')}`)
}

async function waitForRequest(file) {
  await waitForEvent(file, 'evidence-request')
}

async function interrupt(signal, restoreFails = false, mode = 'real-hybrid', duringRunner = false) {
  const f = fixture(mode, duringRunner)
  const child = spawn(process.execPath, [path.join(f.root,
    'scripts/e2e/prepare-codex-approved-tools.mjs'), 'run'], {
    cwd: f.root,
    env: { ...f.env, TEST_RESTORE_FAIL: restoreFails ? '1' : '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  let stdout = ''
  child.stderr.setEncoding('utf8').on('data', data => { stderr += data })
  child.stdout.setEncoding('utf8').on('data', data => { stdout += data })
  const exited = new Promise(resolve => child.once('exit', (code, receivedSignal) =>
    resolve({ code, receivedSignal })))
  try {
    try {
      if (duringRunner) await waitForEvent(f.events, 'runner-started')
      else await waitForRequest(f.events)
    } catch (error) {
      throw new Error(`${error.message}; exit=${child.exitCode}/${child.signalCode}; CLI stdout: ${stdout}; stderr: ${stderr}`)
    }
    const beforeSignal = fs.readFileSync(f.events, 'utf8')
    assert.match(beforeSignal, /patch-applied/,
      'the proxy patch must be observed before the test sends the signal')
    assert.match(beforeSignal, /forward-started/)
    child.kill(signal)
    const result = await Promise.race([
      exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error('CLI did not exit')), 5000)),
    ])
    const events = fs.readFileSync(f.events, 'utf8')
    assert.ok(Number.isInteger(result.code) && result.code !== 0,
      `signal ${signal} must exit with a non-zero code`)
    assert.match(events, restoreFails ? /restore-attempt/ : /restore-applied/,
      'the signal must attempt to restore the patched proxy')
    if (duringRunner) {
      assert.match(events, /runner-closed/)
      assert.ok(events.indexOf('runner-closed') < events.indexOf('restore-applied'),
        'the runner must close before restoration')
    }
    assert.match(events, /cleanup-forward/, 'the signal must stop the owned forward')
    await waitForEvent(f.events, 'forward-exited')
    assert.match(stderr, new RegExp(`interrupted by ${signal}`))
    assert.equal(JSON.parse(fs.readFileSync(f.deploymentFile)).spec.template.spec.containers[0].image,
      restoreFails ? 'clerum/codex-approved-tools-proxy-e2e:test' : originalImage)
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.evidence, 'fixture-state.json'))).restored,
      !restoreFails)
    if (restoreFails) assert.match(stderr, /restore failed; recovery required/)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    const pid = Number(fs.readFileSync(f.forwardPid, 'utf8'))
    if (Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(pid, 'SIGTERM') } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
    const runner = Number(fs.readFileSync(f.runnerPid, 'utf8'))
    if (Number.isSafeInteger(runner) && runner > 0) {
      try { process.kill(runner, 'SIGTERM') } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
    fs.rmSync(f.root, { recursive: true, force: true })
  }
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`real-hybrid ${signal} restores the proxy and stops its detached forward`,
    { timeout: 15000 }, () => interrupt(signal))
}

test('failed signal restoration retains recovery state and reports the failure',
  { timeout: 15000 }, () => interrupt('SIGTERM', true))

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`deterministic ${signal} restores the proxy and stops its detached forward`,
    { timeout: 30000 }, () => interrupt(signal, false, 'deterministic'))
}

test('SIGTERM stops an active runner before restoring the real-hybrid proxy',
  { timeout: 15000 }, () => interrupt('SIGTERM', false, 'real-hybrid', true))
