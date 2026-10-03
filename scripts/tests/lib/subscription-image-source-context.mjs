// A source-only exporter. It reads one clean, real Git commit, scans its exact
// allowlisted bytes locally, then stages a minimal Docker context. No Git repo,
// environment file, runtime config, credential, or ignored file is copied.
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { RunnerAdmissionError, digest } from './subscription-image-runner-contract.mjs'

const refuse = code => {
  throw new RunnerAdmissionError(code)
}
const fixedFiles = [
  'desktop-app/package.json',
  'desktop-app/package-lock.json',
  'desktop-app/tsconfig.json',
  'desktop-app/scripts/verify-electron-runtime.mjs',
  'mcp-host/package.json',
  'mcp-host/package-lock.json',
  ...[
    'subscription-image-input.spec.ts',
    'playwright.subscription-image.config.ts',
    'subscriptionImageFixtures.ts',
    'subscriptionImageRunContract.ts',
    'subscriptionImageChallenge.ts',
    'codexImageChallenge.ts',
    'subscription-tool-screenshot.spec.ts',
    'subscription-gfs-image.spec.ts',
    'subscription-admission-recovery.spec.ts',
    'playwright.subscription-tool-screenshot.config.ts',
    'playwright.subscription-gfs-image.config.ts',
    'playwright.subscription-admission-recovery.config.ts',
    'subscriptionRemainingJourneyConfig.ts',
    'subscriptionRemainingJourneyData.ts',
    'subscriptionRemainingJourneyUi.ts',
    'subscriptionRemainingJourneysContract.ts',
    'navigationHelpers.ts',
  ].map(name => `desktop-app/test/e2e-playwright/${name}`),
  'scripts/e2e/run-subscription-image-journeys.mjs',
  'scripts/e2e/prepare-subscription-remaining-fixtures.mjs',
  'scripts/e2e/prepare-subscription-remaining-fixtures.gfs.mjs',
  'scripts/e2e/prepare-subscription-remaining-fixtures.runtime.mjs',
  'scripts/e2e/prepare-subscription-remaining-fixtures.prepare.mjs',
  'scripts/e2e/fixtures/subscription-image-runner.Dockerfile',
  'scripts/e2e/fixtures/subscription-image-proxy.Dockerfile',
  'scripts/e2e/fixtures/subscription-image-provider.mjs',
  'scripts/e2e/fixtures/subscription-image-decoder.mjs',
  'scripts/e2e/fixtures/subscription-image-challenge.cjs',
  'scripts/e2e/fixtures/subscription-image-session.mjs',
  'scripts/e2e/fixtures/subscription-image-runner.base-image',
  'scripts/e2e/fixtures/subscription-image-admission-pressure.mjs',
  'scripts/tests/lib/subscription-image-runner-contract.mjs',
  'scripts/tests/lib/subscription-image-source-context.mjs',
]
export function allowedSourcePath(filename, packageDirectories = []) {
  if (
    path.isAbsolute(filename) ||
    filename.split('/').includes('..') ||
    /(^|\/)(\.git|node_modules|\.env(?:\..*)?|\.ssh|\.aws|\.gnupg|[^/]*credential[^/]*|[^/]*wallet[^/]*|[^/]*keystore[^/]*|cookies?[^/]*)(\/|$)|\.(pem|key|log)$/i.test(
      filename
    ) ||
    /(^|\/)(__tests__|__snapshots__)(\/|$)|\.test\./.test(filename)
  )
    return false
  return (
    fixedFiles.includes(filename) ||
    [
      'desktop-app/src/',
      'desktop-app/ui/',
      'desktop-app/assets/',
      'desktop-app/renderer/',
      ...packageDirectories.map(directory => `${directory}/`),
    ].some(prefix => filename.startsWith(prefix))
  )
}

export function verifyInputSource(manifest, contextRoot) {
  if (
    manifest.kind !== 'evenfire-subscription-image-input-source-v1' ||
    !/^[a-f0-9]{40}$/.test(manifest.gitHead) ||
    !/^[a-f0-9]{40}$/.test(manifest.gitTree) ||
    !Array.isArray(manifest.files) ||
    !manifest.files.length ||
    manifest.files.length > 20_000
  )
    refuse('INPUT_SOURCE_IDENTITY')
  const seen = new Set()
  for (const row of manifest.files) {
    if (
      !allowedSourcePath(row.path, manifest.packageDirectories) ||
      seen.has(row.path) ||
      !/^[a-f0-9]{40}$/.test(row.gitBlob) ||
      !/^[a-f0-9]{64}$/.test(row.sha256) ||
      !Number.isSafeInteger(row.bytes) ||
      row.bytes < 0
    )
      refuse('INPUT_SOURCE_PATH')
    seen.add(row.path)
    const filename = path.join(contextRoot, row.path),
      stat = fs.lstatSync(filename)
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      fs.realpathSync(filename) !== filename ||
      stat.size !== row.bytes ||
      digest(fs.readFileSync(filename)) !== row.sha256
    )
      refuse('INPUT_SOURCE_BYTES_CHANGED')
  }
  for (const filename of fixedFiles) if (!seen.has(filename)) refuse('INPUT_SOURCE_REQUIRED_FILE')
}

export function exportSourceContext(repoRoot, output, detector) {
  repoRoot = fs.realpathSync(repoRoot)
  if (
    !path.isAbsolute(output) ||
    fs.existsSync(output) ||
    !path.isAbsolute(detector) ||
    fs.realpathSync(detector) !== detector
  )
    refuse('SOURCE_EXPORT_PATH')
  const git = (...args) =>
    execFileSync('git', ['-C', repoRoot, ...args], {
      maxBuffer: 64 * 1024 * 1024,
    })
  if (
    git('rev-parse', '--show-toplevel').toString().trim() !== repoRoot ||
    git('status', '--porcelain=v1', '--untracked-files=normal').length
  )
    refuse('SOURCE_EXPORT_REQUIRES_CLEAN_CHECKOUT')
  const gitHead = git('rev-parse', 'HEAD').toString().trim(),
    gitTree = git('rev-parse', 'HEAD^{tree}').toString().trim()
  const packages = new Set(),
    queue = ['desktop-app', 'mcp-host']
  for (let index = 0; index < queue.length; index++) {
    const body = JSON.parse(git('show', `${gitHead}:${queue[index]}/package.json`).toString())
    for (const value of Object.values({
      ...body.dependencies,
      ...body.devDependencies,
      ...body.optionalDependencies,
    })) {
      if (typeof value !== 'string' || !value.startsWith('file:')) continue
      const directory = path.posix.normalize(path.posix.join(queue[index], value.slice(5)))
      if (!/^packages\/[a-z0-9][a-z0-9-]*$/.test(directory)) refuse('SOURCE_PACKAGE_CLOSURE_PATH')
      if (!packages.has(directory)) {
        packages.add(directory)
        queue.push(directory)
      }
    }
  }
  const directories = [...packages].sort()
  const rows = git('ls-tree', '-r', '-z', '--full-tree', gitHead)
    .toString()
    .split('\0')
    .filter(Boolean)
    .map(row => {
      const split = row.indexOf('\t')
      const [mode, type, blob] = row.slice(0, split).split(' ')
      return { mode, type, blob, path: row.slice(split + 1) }
    })
    .filter(row => allowedSourcePath(row.path, directories))
  const files = []
  // Scan before creating the destination. A RED refusal never leaves an
  // export with sensitive source, and never retries another transport.
  const scan =
    "import runpy,sys; s=runpy.run_path(sys.argv[1]); raw=sys.stdin.buffer.read().decode('utf-8',errors='replace'); sys.exit(91 if s['is_red'](raw) else 0)"
  for (const row of rows) {
    if (row.type !== 'blob' || !['100644', '100755'].includes(row.mode))
      refuse('SOURCE_EXPORT_SYMLINK_OR_SPECIAL')
    const bytes = git('cat-file', 'blob', row.blob)
    const checked = spawnSync('python3', ['-c', scan, detector], {
      input: bytes,
      timeout: 10_000,
      stdio: ['pipe', 'ignore', 'ignore'],
    })
    if (checked.error || checked.status !== 0) refuse('SOURCE_CONTENT_SCAN_REFUSED')
    files.push({
      path: row.path,
      gitBlob: row.blob,
      sha256: digest(bytes),
      bytes: bytes.length,
      executable: row.mode === '100755',
    })
  }
  if (
    git('rev-parse', 'HEAD').toString().trim() !== gitHead ||
    git('status', '--porcelain=v1', '--untracked-files=normal').length
  )
    refuse('SOURCE_CHANGED_DURING_EXPORT')
  fs.mkdirSync(output, { mode: 0o700 })
  for (const row of files) {
    const bytes = git('cat-file', 'blob', row.gitBlob)
    if (digest(bytes) !== row.sha256) refuse('SOURCE_BLOB_CHANGED')
    const filename = path.join(output, row.path)
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
    fs.writeFileSync(filename, bytes, {
      flag: 'wx',
      mode: row.executable ? 0o700 : 0o600,
    })
  }
  const manifest = {
    kind: 'evenfire-subscription-image-input-source-v1',
    gitHead,
    gitTree,
    packageDirectories: directories,
    files,
  }
  verifyInputSource(manifest, output)
  fs.writeFileSync(
    path.join(output, 'subscription-image-input-source.json'),
    JSON.stringify(manifest),
    { flag: 'wx', mode: 0o600 }
  )
  return {
    gitHead,
    gitTree,
    fileCount: files.length,
    inputManifestSha256: digest(JSON.stringify(manifest)),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 5) refuse('SOURCE_EXPORT_ARGUMENTS')
    console.log(JSON.stringify(exportSourceContext(...process.argv.slice(2))))
  } catch (err) {
    console.error(
      JSON.stringify({
        kind: 'source-export-refused',
        code: err instanceof RunnerAdmissionError ? err.code : 'SOURCE_EXPORT_FAILED',
      })
    )
    process.exitCode = 1
  }
}
