import electronPath from 'electron'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildDesktopReleasePolicy } from '../../../external-rest-api/src/desktopReleasePolicy.ts'
import { releaseManifest } from '../../../external-rest-api/src/releaseManifest.ts'

const root = fileURLToPath(new URL('../..', import.meta.url))
const source = process.env.EVENFIRE_DESKTOP_UNSIGNED_SOURCE_APP
const fixtures = process.env.EVENFIRE_DESKTOP_RELEASE_FIXTURE_DIR
test(
  'macOS cancels its queued operation job without a helper PID marker',
  {
    skip: process.platform !== 'darwin',
  },
  async () => {
    const id = randomUUID()
    const label = `ai.evenfire.desktop.update.${id}`
    const { stopMacDesktopInstallJob } = await import(
      new URL('../../dist/desktopUpdateInstaller.js', import.meta.url)
    )
    try {
      assert.equal(
        spawnSync('/bin/launchctl', ['submit', '-l', label, '--', '/bin/sleep', '60']).status,
        0
      )
      await stopMacDesktopInstallJob(id)
      assert.equal(
        spawnSync('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`]).status,
        113
      )
    } finally {
      spawnSync('/bin/launchctl', ['remove', label])
    }
  }
)
for (const mode of [
  'success',
  'launch-failure',
  'observer-failure',
  'source-running',
  'other-user-target',
]) {
  test(
    `macOS launchd install lifecycle: ${mode}`,
    {
      skip: process.platform !== 'darwin' || process.arch !== 'arm64' || !source || !fixtures,
      timeout: 180_000,
    },
    async () => {
      assert.ok(process.env.CODEX_SCRATCH_ROOT)
      const parent = path.join(process.env.CODEX_SCRATCH_ROOT, 'evenfire')
      await mkdir(parent, { recursive: true })
      const scratch = await mkdtemp(path.join(parent, 'updater-mac-install-'))
      let operation
      let sourceInstance
      try {
        if (mode === 'source-running' || mode === 'other-user-target') {
          sourceInstance = spawn('/bin/sleep', ['120'], { stdio: 'ignore' })
          await new Promise((resolve, reject) => {
            sourceInstance.once('spawn', resolve)
            sourceInstance.once('error', reject)
          })
          await writeFile(path.join(scratch, 'source-instance.pid'), String(sourceInstance.pid))
        }
        const policyFile = path.join(scratch, 'producer-policy.json')
        await writeFile(
          policyFile,
          JSON.stringify({
            release: JSON.parse(
              await readFile(
                new URL(
                  '../../src/__tests__/fixtures/github-release-v0.12.0.json',
                  import.meta.url
                ),
                'utf8'
              )
            ),
            policy: buildDesktopReleasePolicy(
              releaseManifest,
              'https://github.com/evenfire-ai/evenfire/releases'
            ),
          })
        )
        const env = { ...process.env }
        delete env.ELECTRON_RUN_AS_NODE
        const result = await new Promise((resolve, reject) => {
          const child = spawn(
            electronPath,
            [
              fileURLToPath(new URL('./updater-macos-install.fixture.cjs', import.meta.url)),
              mode,
              root,
              source,
              path.join(fixtures, 'mac-v0.12.0.zip'),
              scratch,
              policyFile,
            ],
            { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 }
          )
          let output = ''
          child.stdout.on('data', chunk => {
            output += chunk
          })
          child.stderr.on('data', chunk => {
            output += chunk
          })
          child.once('error', reject)
          child.once('close', code => resolve({ code, output }))
        })
        operation = JSON.parse(await readFile(path.join(scratch, 'test-operation.json'), 'utf8'))
        assert.equal(result.code, 0, result.output)
        const expected =
          mode === 'success' || mode === 'observer-failure' || mode === 'other-user-target'
            ? '0.12.0'
            : '0.11.9'
        for (let i = 0; i < 600; i++) {
          try {
            const version =
              mode === 'source-running'
                ? '0.11.9'
                : await readFile(path.join(scratch, 'launched-version'), 'utf8')
            const job = spawnSync('/bin/launchctl', [
              'print',
              `gui/${process.getuid()}/ai.evenfire.desktop.update.${operation.id}`,
            ])
            if (version.trim() === expected && job.status === 113) break
          } catch {}
          await new Promise(resolve => setTimeout(resolve, 100))
        }
        const info = spawnSync(
          '/usr/libexec/PlistBuddy',
          [
            '-c',
            'Print :CFBundleShortVersionString',
            path.join(scratch, 'Evenfire.app/Contents/Info.plist'),
          ],
          { encoding: 'utf8' }
        )
        assert.equal(info.stdout.trim(), expected)
        if (mode === 'source-running')
          await assert.rejects(readFile(path.join(scratch, 'launched-version')), { code: 'ENOENT' })
        else
          assert.equal(
            (await readFile(path.join(scratch, 'launched-version'), 'utf8')).trim(),
            expected
          )
        assert.equal(
          spawnSync('/bin/launchctl', [
            'print',
            `gui/${process.getuid()}/ai.evenfire.desktop.update.${operation.id}`,
          ]).status,
          113
        )
        const recovery = (await readdir(scratch)).filter(
          p => p.includes('.evenfire-new-') || p.includes('.evenfire-rollback-')
        )
        if (mode === 'observer-failure' || mode === 'other-user-target')
          assert.deepEqual(recovery, [`Evenfire.app.evenfire-rollback-${operation.id}`])
        else assert.deepEqual(recovery, [])
        if (mode === 'success')
          await assert.rejects(
            readFile(path.join(scratch, 'desktop-update-staging/pending.json')),
            { code: 'ENOENT' }
          )
        else {
          const log = await readFile(path.join(operation.path, 'install.log'), 'utf8')
          assert.match(log, /launch|startup|source/)
          if (mode === 'observer-failure' || mode === 'other-user-target')
            assert.ok(await readFile(path.join(operation.path, 'payload/application.zip')))
          else
            await assert.rejects(readFile(path.join(operation.path, 'payload/application.zip')), {
              code: 'ENOENT',
            })
        }
      } finally {
        if (!operation)
          try {
            operation = JSON.parse(
              await readFile(path.join(scratch, 'test-operation.json'), 'utf8')
            )
          } catch {}
        if (operation)
          spawnSync('/bin/launchctl', ['remove', `ai.evenfire.desktop.update.${operation.id}`])
        if (
          sourceInstance &&
          sourceInstance.exitCode === null &&
          sourceInstance.signalCode === null
        ) {
          const closed = new Promise(resolve => sourceInstance.once('close', resolve))
          sourceInstance.kill('SIGTERM')
          await closed
        }
        await rm(scratch, { recursive: true, force: false })
      }
    }
  )
}
