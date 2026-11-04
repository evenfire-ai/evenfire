#!/usr/bin/env node
// Shared, read-only certification input checks. Building producers is a
// separate explicit command; checking inputs never installs or touches a cluster.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { verifySuiteManifest } from './password-recovery-suite-contract.mjs'

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const CONTRACT_PATH = 'tests/contracts/certification-inputs.json'
const RECEIPT_PATH = 'control-api/dist/.certification-producer-receipt.json'
const HEX40 = /^[a-f0-9]{40}$/
const HEX64 = /^[a-f0-9]{64}$/
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/

function inside(root, candidate) {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))
}

function validRelative(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !isAbsolute(value) &&
    !value.includes('\\') &&
    value.split('/').every(part => part && part !== '.' && part !== '..' && /^[A-Za-z0-9._-]+$/.test(part))
  )
}

function localPath(root, name, expected = 'file') {
  if (!validRelative(name)) throw new Error('invalid relative path: ' + String(name))
  const path = resolve(root, name)
  if (!inside(resolve(root), path)) throw new Error('path escapes root: ' + name)
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) throw new Error('symbolic link is not accepted: ' + name)
  if (expected === 'file' && !stat.isFile()) throw new Error('expected file: ' + name)
  if (expected === 'directory' && !stat.isDirectory()) throw new Error('expected directory: ' + name)
  if (!inside(realpathSync(root), realpathSync(path))) throw new Error('resolved path escapes root: ' + name)
  return path
}

function uniquePaths(values, label, allowEmpty = false) {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0)) throw new Error(label + ' must be a nonempty array')
  if (values.some(value => !validRelative(value)) || new Set(values).size !== values.length)
    throw new Error(label + ' contains invalid or duplicate paths')
  return values
}

export function loadCertificationContract(root) {
  const contract = JSON.parse(readFileSync(localPath(root, CONTRACT_PATH), 'utf8'))
  const expected = ['version', 'suiteManifest', 'preGateScript', 't1Packages', 't1TestRoots', 'localT1ExtraPackages', 'consumerDependencies', 'consumerArtifacts', 'nativeChecks', 'producers']
  if (!contract || Object.keys(contract).sort().join() !== expected.sort().join() || contract.version !== 1)
    throw new Error('unknown certification input contract schema')
  if (!validRelative(contract.suiteManifest) || !validRelative(contract.preGateScript))
    throw new Error('invalid certification contract path')
  uniquePaths(contract.t1Packages, 't1Packages')
  uniquePaths(contract.t1TestRoots, 't1TestRoots')
  if (contract.t1TestRoots.some(pkg => !contract.t1Packages.includes(pkg))) throw new Error('T1 test roots must be declared packages')
  uniquePaths(contract.localT1ExtraPackages, 'localT1ExtraPackages')
  for (const key of ['consumerDependencies', 'consumerArtifacts']) {
    const map = contract[key]
    if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error(key + ' must be an object')
    for (const [consumer, paths] of Object.entries(map)) {
      if (!validRelative(consumer)) throw new Error('invalid consumer: ' + consumer)
      uniquePaths(paths, key + '.' + consumer)
    }
  }
  if (!contract.nativeChecks || typeof contract.nativeChecks !== 'object' || Array.isArray(contract.nativeChecks))
    throw new Error('nativeChecks must be an object')
  for (const [consumer, checks] of Object.entries(contract.nativeChecks)) {
    if (!validRelative(consumer) || !Array.isArray(checks) || !checks.length) throw new Error('invalid native check declaration')
    for (const check of checks) {
      if (!check || Object.keys(check).sort().join() !== 'kind,package' || !validRelative(check.package) || !['sqlite', 'canvas'].includes(check.kind))
        throw new Error('invalid native check: ' + consumer)
    }
  }
  if (!contract.producers || Object.keys(contract.producers).sort().join() !== 'latestDev,observedDev')
    throw new Error('expected the two historical producer declarations')
  const envs = new Set()
  for (const [id, producer] of Object.entries(contract.producers)) {
    const keys = ['env', 'commit', 'sourceHashes', 'buildPackages', 'artifactDirectories', 'lockfiles', 'runner']
    if (!producer || Object.keys(producer).sort().join() !== keys.sort().join())
      throw new Error('invalid producer schema: ' + id)
    if (!ENV_NAME.test(producer.env) || envs.has(producer.env) || !HEX40.test(producer.commit))
      throw new Error('invalid producer identity: ' + id)
    envs.add(producer.env)
    if (!producer.sourceHashes || typeof producer.sourceHashes !== 'object' || Array.isArray(producer.sourceHashes) || !Object.keys(producer.sourceHashes).length)
      throw new Error('missing producer source hashes: ' + id)
    for (const [name, hash] of Object.entries(producer.sourceHashes))
      if (!validRelative(name) || !HEX64.test(hash)) throw new Error('invalid producer source hash: ' + id)
    uniquePaths(producer.buildPackages, id + '.buildPackages')
    uniquePaths(producer.artifactDirectories, id + '.artifactDirectories')
    uniquePaths(producer.lockfiles, id + '.lockfiles')
    if (!validRelative(producer.runner)) throw new Error('invalid producer runner: ' + id)
  }
  return contract
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  })
}

function git(root, args) {
  const result = run('git', ['-C', root, ...args])
  if (result.error || result.status !== 0) throw new Error('Git inspection failed')
  return result.stdout.trim()
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function treeDigest(root, rel) {
  const directory = localPath(root, rel, 'directory')
  const files = []
  function walk(dir, prefix) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => Buffer.from(a.name).compare(Buffer.from(b.name)))) {
      const child = join(dir, entry.name)
      const name = prefix ? prefix + '/' + entry.name : entry.name
      if (rel + '/' + name === RECEIPT_PATH) continue
      if (entry.isSymbolicLink()) throw new Error('symbolic link in build output: ' + rel + '/' + name)
      if (entry.isDirectory()) walk(child, name)
      else if (entry.isFile()) files.push([name, sha256(child)])
      else throw new Error('non-file in build output: ' + rel + '/' + name)
    }
  }
  walk(directory, '')
  if (!files.length) throw new Error('empty build output: ' + rel)
  const hash = createHash('sha256')
  for (const [name, digest] of files) hash.update(name).update('\0').update(digest).update('\n')
  return hash.digest('hex')
}

function producerRoot(env, producer, id) {
  const value = env[producer.env]
  if (!value || !isAbsolute(value)) throw new Error(id + ': missing absolute ' + producer.env)
  const stat = lstatSync(value)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(id + ': producer path is not a directory')
  return realpathSync(value)
}

function producerState(root, id, producer) {
  if (git(root, ['rev-parse', 'HEAD']) !== producer.commit) throw new Error(id + ': producer commit mismatch')
  if (git(root, ['status', '--porcelain=v1'])) throw new Error(id + ': producer checkout is dirty')
  const sources = {}
  for (const [name, expected] of Object.entries(producer.sourceHashes)) {
    const actual = sha256(localPath(root, name))
    if (actual !== expected) throw new Error(id + ': source hash mismatch: ' + name)
    sources[name] = actual
  }
  return sources
}

function receiptState(root, id, producer, sources) {
  const locks = {}
  for (const name of producer.lockfiles) locks[name] = sha256(localPath(root, name))
  const artifacts = {}
  for (const name of producer.artifactDirectories) artifacts[name] = treeDigest(root, name)
  localPath(root, producer.runner)
  return { version: 1, producer: id, commit: producer.commit, node: process.version, sources, locks, artifacts }
}

export function buildProducer(root, id, env = process.env) {
  const contract = loadCertificationContract(root)
  const producer = contract.producers[id]
  if (!producer) throw new Error('unknown producer: ' + id)
  const input = producerRoot(env, producer, id)
  const sources = producerState(input, id, producer)
  const receipt = resolve(input, RECEIPT_PATH)
  if (existsSync(receipt)) {
    if (lstatSync(receipt).isSymbolicLink() || !inside(realpathSync(input), realpathSync(receipt)))
      throw new Error(id + ': unsafe existing receipt')
    unlinkSync(receipt)
  }
  for (const pkg of producer.buildPackages) {
    const cwd = localPath(input, pkg, 'directory')
    const result = run('npm', ['run', 'build'], { cwd, env, stdio: 'inherit', timeout: 600000 })
    if (result.error || result.status !== 0) throw new Error(id + ': build failed: ' + pkg)
  }
  // Recheck tracked inputs after the build before binding the ignored outputs.
  const after = producerState(input, id, producer)
  if (JSON.stringify(sources) !== JSON.stringify(after)) throw new Error(id + ': producer sources changed during build')
  const data = receiptState(input, id, producer, after)
  const directory = dirname(receipt)
  localPath(input, relative(input, directory), 'directory')
  const temporary = receipt + '.' + process.pid + '.tmp'
  try {
    writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    renameSync(temporary, receipt)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
  return data
}

function verifyProducer(root, id, producer, env) {
  const input = producerRoot(env, producer, id)
  const sources = producerState(input, id, producer)
  const receipt = JSON.parse(readFileSync(localPath(input, RECEIPT_PATH), 'utf8'))
  const expected = receiptState(input, id, producer, sources)
  if (JSON.stringify(receipt) !== JSON.stringify(expected)) throw new Error(id + ': producer build receipt does not match current inputs and outputs')
}

export function listAffectedPackages(root, base, head) {
  if (!base || !head || base.startsWith('-') || head.startsWith('-') || /[\r\n\0]/.test(base + head))
    throw new Error('invalid Git range')
  const result = run('git', ['-C', root, 'diff', '--name-only', '-z', '--diff-filter=ACMRTUXB', base + '...' + head])
  if (result.error || result.status !== 0) throw new Error('cannot inspect affected packages')
  const found = new Set()
  for (const name of result.stdout.split('\0').filter(Boolean)) {
    if (name.includes('\n') || name.includes('\r')) throw new Error('unsupported newline in changed path')
    let current = resolve(root, name)
    if (!inside(resolve(root), current)) throw new Error('changed path escapes repository')
    if (!existsSync(current) || !lstatSync(current).isDirectory()) current = dirname(current)
    while (current !== resolve(root) && inside(resolve(root), current)) {
      if (existsSync(join(current, 'package.json'))) {
        const packageName = relative(resolve(root), current).split(sep).join('/')
        if (!validRelative(packageName)) throw new Error('invalid affected package path')
        found.add(packageName)
        break
      }
      current = dirname(current)
    }
  }
  return [...found]
}

export function listPreGatePackages(root, contract) {
  const text = readFileSync(localPath(root, contract.preGateScript), 'utf8')
  const calls = text.split(/\r?\n/).filter(line =>
    !/^\s*#/.test(line) && /\brun_if_changed\b/.test(line) && !/^\s*run_if_changed\(\)\s*\{/.test(line)
  )
  if (!calls.length) throw new Error('no pre-gate package declarations found')
  const packages = []
  for (const line of calls) {
    const match = /^\s*run_if_changed\s+([A-Za-z0-9._/-]+)\s+"(npm test(?: && npm run build)?)"\s*$/.exec(line)
    if (!match || !validRelative(match[1])) throw new Error('unrecognized pre-gate package declaration')
    packages.push(match[1])
  }
  if (new Set(packages).size !== packages.length) throw new Error('duplicate pre-gate package declaration')
  return packages
}

function addDependencies(packages, contract) {
  // These are test-consumer edges, not transitive runtime edges: importing a
  // sibling's source does not execute that sibling's own test suite.
  for (const consumer of [...packages])
    for (const dependency of contract.consumerDependencies[consumer] || []) packages.add(dependency)
}

function npmInstalled(root, pkg, env) {
  const cwd = localPath(root, pkg, 'directory')
  localPath(root, pkg + '/package.json')
  const result = run('npm', ['ls', '--depth=0', '--json'], { cwd, env })
  if (result.error || result.status !== 0) throw new Error('direct dependencies are incomplete: ' + pkg)
}

export function inspectCertificationInputs(options) {
  const { root, scope, service, base, head, env = process.env } = options
  const contract = loadCertificationContract(root)
  if (!['t2', 't0', 't1', 'ci-t1', 'matrix'].includes(scope)) throw new Error('unknown certification scope')
  const errors = []
  const packages = new Set()
  const testRoots = new Set()
  if (scope === 'matrix') {
    if (!validRelative(service)) throw new Error('invalid matrix service')
    packages.add(service)
    testRoots.add(service)
    addDependencies(packages, contract)
  } else {
    if (scope !== 't0') {
      for (const pkg of contract.t1Packages) packages.add(pkg)
      for (const pkg of contract.t1TestRoots) testRoots.add(pkg)
      if (scope !== 'ci-t1') for (const pkg of contract.localT1ExtraPackages) packages.add(pkg)
    }
    if (scope === 't2' || scope === 't0') {
      // T0 tests only the affected packages; the pre-gate set runs only in T2.
      if (scope === 't2') for (const pkg of listPreGatePackages(root, contract)) packages.add(pkg)
      for (const pkg of listAffectedPackages(root, base, head)) {
        if (!/^tests\/e2e(?:\/|$)/.test(pkg) && !/\/tests\/e2e(?:\/|$)/.test(pkg)) packages.add(pkg)
      }
      for (const pkg of packages) testRoots.add(pkg)
      addDependencies(packages, contract)
    }
    try {
      const manifest = JSON.parse(readFileSync(localPath(root, contract.suiteManifest), 'utf8'))
      verifySuiteManifest(root, manifest)
    } catch (error) {
      errors.push('suite census/manifest: ' + error.message)
    }
    if (scope !== 't0') {
      for (const [id, producer] of Object.entries(contract.producers)) {
        try {
          verifyProducer(root, id, producer, env)
          const input = producerRoot(env, producer, id)
          for (const pkg of producer.buildPackages) npmInstalled(input, pkg, env)
        } catch (error) { errors.push(id + ': ' + error.message) }
      }
    }
  }
  for (const pkg of packages) {
    try { npmInstalled(root, pkg, env) } catch (error) { errors.push(error.message) }
  }
  for (const pkg of testRoots) {
    for (const artifact of contract.consumerArtifacts[pkg] || []) {
      try { localPath(root, artifact) } catch { errors.push('required build artifact is missing: ' + artifact) }
    }
  }
  const nativeCommands = {
    sqlite: "const DB=require('better-sqlite3');const db=new DB(':memory:');db.close()",
    canvas: "require('@napi-rs/canvas')",
  }
  const seenNative = new Set()
  for (const consumer of testRoots) {
    for (const check of contract.nativeChecks[consumer] || []) {
      const identity = check.package + ':' + check.kind
      if (seenNative.has(identity)) continue
      seenNative.add(identity)
      try {
        const cwd = localPath(root, check.package, 'directory')
        const result = run(process.execPath, ['-e', nativeCommands[check.kind]], { cwd, env })
        if (result.error || result.status !== 0) errors.push('native dependency is not loadable: ' + identity)
      } catch (error) { errors.push('native dependency is not loadable: ' + identity) }
    }
  }
  if (packages.has('desktop-app')) {
    try {
      const result = run('npm', ['run', 'verify:electron'], { cwd: localPath(root, 'desktop-app', 'directory'), env })
      if (result.error || result.status !== 0) errors.push('Desktop Electron runtime verification failed')
    } catch { errors.push('Desktop Electron runtime verification failed') }
  }
  return { errors, packages: [...packages] }
}

function parseOptions(args) {
  const allowed = new Set(['root', 'scope', 'service', 'base', 'head', 'producer'])
  const options = {}
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]
    if (!name || !name.startsWith('--') || !allowed.has(name.slice(2)) || options[name.slice(2)] !== undefined || args[i + 1] === undefined)
      throw new Error('invalid certification input arguments')
    options[name.slice(2)] = args[i + 1]
  }
  return options
}

function main() {
  const [command, ...args] = process.argv.slice(2)
  const options = parseOptions(args)
  const root = resolve(options.root || DEFAULT_ROOT)
  if (command === 'pins') {
    const contract = loadCertificationContract(root)
    console.log('observed_commit=' + contract.producers.observedDev.commit)
    console.log('latest_commit=' + contract.producers.latestDev.commit)
  } else if (command === 'build-producer') {
    buildProducer(root, options.producer)
    console.log('PRODUCER_BUILD_RECEIPT=PASS')
  } else if (command === 'list-affected') {
    for (const pkg of listAffectedPackages(root, options.base, options.head)) console.log(pkg)
  } else if (command === 'check') {
    const result = inspectCertificationInputs({ root, ...options })
    if (result.errors.length) {
      for (const error of result.errors) console.error('CERTIFICATION_INPUT_ERROR: ' + error)
      process.exitCode = 1
    } else {
      console.log('CERTIFICATION_INPUTS=PASS packages=' + result.packages.length + ' scope=' + options.scope)
    }
  } else {
    throw new Error('usage: certification-inputs.mjs pins | build-producer | list-affected | check [options]')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main() } catch (error) {
    console.error('CERTIFICATION_INPUT_ERROR: ' + error.message)
    process.exitCode = 1
  }
}
