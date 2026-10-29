import electronPath from 'electron'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildDesktopReleasePolicy } from '../../../external-rest-api/src/desktopReleasePolicy.ts'
import { releaseManifest } from '../../../external-rest-api/src/releaseManifest.ts'

const desktopRoot = fileURLToPath(new URL('../..', import.meta.url))
const sourceApp = process.env.EVENFIRE_DESKTOP_UNSIGNED_SOURCE_APP
const fixtureDirectory = process.env.EVENFIRE_DESKTOP_RELEASE_FIXTURE_DIR
const available =
  process.platform === 'darwin' && process.arch === 'arm64' && sourceApp && fixtureDirectory

for (const [runtime, mode] of [
  ['Node', 'hash'],
  ['Electron', 'hash'],
  ['Node', 'extract'],
  ['Electron', 'extract'],
  ['Electron', 'stage'],
  ['Electron', 'stage-live'],
  ['Node', 'safety'],
  ['Electron', 'safety'],
]) {
  test(
    `${runtime}: real Forge ASAR ${mode}`,
    {
      skip: !available
        ? 'requires macOS arm64, real Forge source app and release ZIP fixtures'
        : mode === 'stage-live' && process.env.EVENFIRE_DESKTOP_LIVE_RELEASE !== '1'
          ? 'set EVENFIRE_DESKTOP_LIVE_RELEASE=1 to stage directly from public GitHub'
          : false,
      timeout: 180_000,
    },
    async () => {
      assert.ok(process.env.CODEX_SCRATCH_ROOT, 'CODEX_SCRATCH_ROOT is required')
      const parent = path.join(process.env.CODEX_SCRATCH_ROOT, 'evenfire')
      await mkdir(parent, { recursive: true })
      const scratch = await mkdtemp(path.join(parent, 'updater-physical-native-'))
      try {
        const release = JSON.parse(
          await readFile(
            new URL('../../src/__tests__/fixtures/github-release-v0.12.0.json', import.meta.url),
            'utf8'
          )
        )
        const policyFile = path.join(scratch, 'producer-policy.json')
        await writeFile(
          policyFile,
          JSON.stringify({
            release,
            policy: buildDesktopReleasePolicy(
              releaseManifest,
              'https://github.com/evenfire-ai/evenfire/releases'
            ),
          })
        )
        const environment = { ...process.env }
        delete environment.ELECTRON_RUN_AS_NODE
        const args = [
          fileURLToPath(new URL('./updater-physical-filesystem.fixture.cjs', import.meta.url)),
          mode,
          desktopRoot,
          sourceApp,
          path.join(fixtureDirectory, 'mac-v0.12.0.zip'),
          scratch,
          policyFile,
        ]
        const result = await new Promise((resolve, reject) => {
          const child = spawn(runtime === 'Electron' ? electronPath : process.execPath, args, {
            cwd: scratch,
            env: environment,
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 170_000,
          })
          let output = ''
          child.stdout.on('data', chunk => {
            output += chunk
          })
          child.stderr.on('data', chunk => {
            output += chunk
          })
          child.once('error', reject)
          child.once('close', (code, signal) => resolve({ code, signal, output }))
        })
        assert.equal(result.code, 0, `${runtime} ${mode}: ${result.signal ?? ''}\n${result.output}`)
        assert.match(result.output, new RegExp(`PASS ${runtime} ${mode}`))
      } finally {
        await rm(scratch, { recursive: true, force: false })
      }
    }
  )
}
