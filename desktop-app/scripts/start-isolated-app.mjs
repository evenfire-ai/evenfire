/**
 * Run one ISOLATED dev instance of the Evenfire desktop app.
 *
 * Purpose: three PRs (and three minikube targets) have to run the desktop app at
 * the same time on one machine. A normal launch cannot do that because three
 * pieces of state are machine-wide: the `evenfire:`/`clerum:` OS protocol
 * handler, the application name `Evenfire`, and the user-data directory holding
 * the Chromium profile and the stored runtime-config profiles.
 *
 * This launcher therefore gives each run:
 *
 *   - its own per-run directory under the platform application-support
 *     directory (never inside the repository, so profile material cannot end up
 *     in the worktree, in commits or in notes);
 *   - a `--user-data-dir` inside that directory, plus
 *     `CLERUM_DESKTOP_CONFIG_PATH` pointing at a file inside it, so the runtime
 *     config layer cannot read the developer's shared `runtime-configs`
 *     directory even before Electron is ready;
 *   - explicit loopback REST/RPC endpoints taken from the command line;
 *   - a unique visible identity (`PR660 · Minikube30488`) that the app applies to
 *     the process name, the application name and the window title.
 *
 * The app then refuses to register OS protocol handlers and refuses to process
 * deep links, and it verifies the effective runtime (real userData, app path,
 * endpoints, config storage path) against this declaration before initializing
 * any service. A divergence aborts the launch instead of falling back to the
 * shared profile.
 *
 * Safety properties of this script:
 *   - it never copies or reads a session, a keychain entry, a `.env` file or any
 *     private config; it only creates a fresh directory and inspects the
 *     Electron binary and the existing build;
 *   - it never kills, reuses or adopts another instance, and it refuses
 *     `--force-*` passthrough flags;
 *   - the default action is to PRINT THE PLAN. It only spawns Electron with an
 *     explicit `--launch`, which is what keeps this launcher dormant until the
 *     main coordinator wires it up with #654/#651.
 *
 * Usage:
 *   node scripts/start-isolated-app.mjs --target <profile-label> --pr <number> \
 *     --rest-url <rest-origin> --rpc-url <rpc-origin>
 *   node scripts/start-isolated-app.mjs ... --launch
 *
 * Options:
 *   --target <slug>    required, e.g. minikube-30488 (safe slug, 1-64 chars)
 *   --rest-url <url>   required, loopback http(s) URL with an explicit port
 *   --rpc-url <url>    required, loopback http(s) URL with an explicit port
 *   --pr <number>      optional, digits only; makes the label `PR<n> · …`
 *   --base-dir <path>  optional, absolute parent for the per-run directory
 *                      (default: platform application-support directory)
 *   --launch           spawn Electron (default: print the plan only)
 *   --json             print the plan as JSON instead of one log line
 *   --help             print usage
 *   -- <args...>       extra Electron arguments (no `--force-*`, no
 *                      `--user-data-dir`: this script owns both)
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(projectDirectory, '..')

function fail(message) {
  console.error(`[dev-isolation] ${message}`)
  process.exitCode = 1
  return null
}

/**
 * The contract lives in `src/devIsolation.ts`; the launcher consumes the
 * existing compiled build so the two can never disagree about paths, identity
 * or validation.
 */
function loadContract() {
  const compiled = path.join(projectDirectory, 'dist', 'devIsolation.js')
  if (!fs.existsSync(compiled)) {
    fail(
      `missing ${compiled}. Build the main process first: ` +
        `(cd ${path.relative(repoRoot, projectDirectory)} && npm run build:main)`
    )
    return null
  }
  try {
    return require(compiled)
  } catch (error) {
    fail(`could not load ${compiled}: ${error instanceof Error ? error.message : error}`)
    return null
  }
}

function parseArgs(argv) {
  const options = { launch: false, json: false, passthrough: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--') {
      options.passthrough = argv.slice(index + 1)
      break
    }
    if (argument === '--launch') {
      options.launch = true
      continue
    }
    if (argument === '--json') {
      options.json = true
      continue
    }
    if (argument === '--help' || argument === '-h') {
      options.help = true
      continue
    }
    const next = argv[index + 1]
    const readValue = name => {
      if (typeof next !== 'string' || next.startsWith('--')) {
        fail(`${name} requires a value`)
        return null
      }
      index += 1
      return next
    }
    if (argument === '--target') options.target = readValue('--target')
    else if (argument === '--pr') options.pr = readValue('--pr')
    else if (argument === '--rest-url') options.restUrl = readValue('--rest-url')
    else if (argument === '--rpc-url') options.rpcUrl = readValue('--rpc-url')
    else if (argument === '--base-dir') options.baseDir = readValue('--base-dir')
    else {
      fail(`unknown argument ${argument}`)
      return null
    }
    if (options.target === null || options.pr === null) return null
    if (options.restUrl === null || options.rpcUrl === null || options.baseDir === null) return null
  }
  return options
}

function assertPassthroughAllowed(passthrough) {
  for (const argument of passthrough) {
    if (argument.startsWith('--force-')) {
      return fail(`refusing passthrough flag ${argument}: forced flags are not allowed`)
    }
    if (argument === '--user-data-dir' || argument.startsWith('--user-data-dir=')) {
      return fail('refusing passthrough --user-data-dir: the launcher owns the isolated profile')
    }
  }
  return true
}

function resolveElectronBinary() {
  let binary
  try {
    binary = require('electron')
  } catch {
    return fail('Electron is not installed. Run: (cd desktop-app && npm run verify:electron)')
  }
  if (typeof binary !== 'string' || !binary) {
    return fail(
      'Electron runtime path is unavailable. Run: (cd desktop-app && npm run verify:electron)'
    )
  }
  try {
    fs.accessSync(binary, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK)
  } catch {
    return fail(`Electron runtime is not executable at ${binary}. Run: npm run verify:electron`)
  }
  return binary
}

function createRunDirectory(contract, options) {
  const baseDirResult = contract.admitIsolationBaseDir({
    requested: options.baseDir,
    repoRoot,
    platform: process.platform,
    homedir: os.homedir(),
    env: process.env,
  })
  if (!baseDirResult.ok) {
    return fail(`${baseDirResult.code}: ${baseDirResult.message}`)
  }
  const prefix = ['evenfire', options.pr ? `pr${options.pr}` : '', options.target, '']
    .filter(Boolean)
    .join('-')
  fs.mkdirSync(baseDirResult.baseDir, { recursive: true, mode: 0o700 })
  const realBase = fs.realpathSync.native(baseDirResult.baseDir)
  const realAdmission = contract.admitIsolationBaseDir({
    requested: realBase,
    repoRoot: fs.realpathSync.native(repoRoot),
    platform: process.platform,
    homedir: os.homedir(),
    env: process.env,
  })
  if (!realAdmission.ok) return fail(realAdmission.code)
  const runDir = fs.mkdtempSync(path.join(realBase, `${prefix}-`))
  const runPaths = contract.devIsolationPaths(runDir)
  fs.mkdirSync(runPaths.userDataDir, { recursive: true, mode: 0o700 })
  return runPaths
}

function childEnvironment(contract, runPaths, options, appPath) {
  return {
    ...process.env,
    [contract.DEV_ISOLATION_ENABLE_ENV]: '1',
    [contract.DEV_ISOLATION_ENV.runDir]: runPaths.runDir,
    [contract.DEV_ISOLATION_ENV.restUrl]: options.restUrl,
    [contract.DEV_ISOLATION_ENV.rpcUrl]: options.rpcUrl,
    [contract.DEV_ISOLATION_ENV.target]: options.target,
    ...(options.pr ? { [contract.DEV_ISOLATION_ENV.pr]: options.pr } : {}),
    [contract.DEV_ISOLATION_ENV.appPath]: appPath,
    EXTERNAL_REST_API_BASE_URL: options.restUrl,
    RPC_PROXY_BASE_URL: options.rpcUrl,
    EVENFIRE_RENDERER_URL: '',
    // Second isolation layer: the runtime-config layer reads this file instead
    // of the shared `runtime-configs` directory, including before Electron ready.
    CLERUM_DESKTOP_CONFIG_PATH: runPaths.configPath,
  }
}

function planRecord(plan, runPaths, electronBinary, entrypoint, launch) {
  return {
    kind: 'evenfire-dev-isolation-plan',
    mode: launch ? 'launch' : 'plan-only',
    target: plan.identity.target,
    label: plan.label,
    appName: plan.appName,
    runDir: runPaths.runDir,
    userDataDir: runPaths.userDataDir,
    configPath: runPaths.configPath,
    restUrl: plan.restUrl,
    rpcUrl: plan.rpcUrl,
    appPath: plan.appPath ?? '',
    electron: electronBinary ?? '',
    entrypoint,
  }
}

function printRecord(contract, record, json) {
  if (json) {
    console.log(JSON.stringify(record, null, 2))
    return
  }
  console.log(contract.formatDevIsolationLogLine(record))
}

function writeRunMetadata(runPaths, record, pid) {
  const metadata = { ...record, pid }
  const temporary = `${runPaths.recordPath}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, runPaths.recordPath)
  fs.writeFileSync(runPaths.pidPath, `${pid}\n`, { mode: 0o600 })
}

function launch(contract, plan, runPaths, options, electronBinary, entrypoint, record) {
  const env = childEnvironment(contract, runPaths, options, path.dirname(entrypoint))
  // Self-check with the same contract the app applies: a declaration this
  // launcher cannot itself validate must never reach Electron.
  const decision = contract.resolveDevIsolation(env, [
    contract.DEV_ISOLATION_FLAG,
    '--user-data-dir',
    runPaths.userDataDir,
  ])
  if (decision.mode !== 'isolated') {
    const detail =
      decision.mode === 'refused' ? `${decision.code}: ${decision.message}` : decision.mode
    return fail(`the launcher's own declaration does not validate: ${detail}`)
  }

  const child = spawn(
    electronBinary,
    [`--user-data-dir=${runPaths.userDataDir}`, contract.DEV_ISOLATION_FLAG, entrypoint],
    { env, cwd: projectDirectory, stdio: 'inherit' }
  )
  if (typeof child.pid !== 'number') {
    return fail('Electron did not start')
  }
  writeRunMetadata(runPaths, record, child.pid)
  console.log(`[dev-isolation] launched pid=${child.pid} entrypoint=${entrypoint}`)
  console.log(`[dev-isolation] metadata=${runPaths.recordPath}`)

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => child.kill(signal))
  }
  child.once('error', error => {
    console.error(`[dev-isolation] Electron failed to start: ${error.message}`)
    process.exitCode = 1
  })
  child.once('exit', (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 0)
  })
  return true
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!options) return
  if (options.help) {
    console.log('See the header of scripts/start-isolated-app.mjs for usage.')
    return
  }
  if (!options.target || !options.restUrl || !options.rpcUrl) {
    fail('--target, --rest-url and --rpc-url are required')
    return
  }
  if (!assertPassthroughAllowed(options.passthrough)) return

  const contract = loadContract()
  if (!contract) return

  const entrypoint = path.join(projectDirectory, 'dist', 'main.js')
  if (!fs.existsSync(entrypoint)) {
    fail(`missing ${entrypoint}. Build first: (cd desktop-app && npm run build:main)`)
    return
  }
  const electronBinary = resolveElectronBinary()
  if (!electronBinary) return

  const runPaths = createRunDirectory(contract, options)
  if (!runPaths) return

  const env = childEnvironment(contract, runPaths, options, path.dirname(entrypoint))
  const decision = contract.resolveDevIsolation(env, [
    contract.DEV_ISOLATION_FLAG,
    '--user-data-dir',
    runPaths.userDataDir,
  ])
  if (decision.mode !== 'isolated') {
    const detail =
      decision.mode === 'refused' ? `${decision.code}: ${decision.message}` : decision.mode
    fail(`the launcher's declaration does not validate: ${detail}`)
    return
  }
  const plan = decision.plan
  const record = planRecord(plan, runPaths, electronBinary, entrypoint, options.launch)
  printRecord(contract, record, options.json)

  if (!options.launch) {
    console.log(
      '[dev-isolation] plan only: nothing was launched. ' +
        'Re-run with --launch once the coordinator enables the isolated lane.'
    )
    return
  }
  launch(contract, plan, runPaths, options, electronBinary, entrypoint, record)
}

main()
