import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createPublicKey, type KeyObject, generateKeyPairSync, randomUUID } from 'node:crypto'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type * as Policy from '../../packages/jwt-key-policy/index.js'
import type * as Store from '../../packages/jwt-key-policy/dev-store.js'

type VerifierModule = { config: { jwtPublicKey: string; jwtIssuer: string; jwtAudience: string } }
export type VerifierContractOptions = {
  service: 'rpc-proxy' | 'external-rest-api'
  slot: 'rpc' | 'session'
  envName: string
  configSource: URL
  loadConfig: () => Promise<VerifierModule>
  resetModules: () => void
}
export type VerifierContractCase = { name: string; run: () => void | Promise<void> }

type CryptoFixtures = {
  PUBLIC_KEYS: Readonly<Record<'rpc' | 'session' | 'admin', string>>
  encodings: (pem: string) => Record<string, string>
  certificate: (material: KeyObject) => string
  certificateWithPublic: (publicPem: string) => Promise<string>
}
type RuntimeResult = {
  storeDir: string
  fingerprint?: string
  signatureVerified?: boolean
  storeOperations: number
  code?: string
  reason?: string
  productionDevModeRejected?: boolean
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** Framework-neutral fixture/cases; each caller uses its own test API/types. */
export function createDevJwtVerifierContract(options: VerifierContractOptions) {
  const serviceRoot = dirname(dirname(fileURLToPath(options.configSource)))
  const serviceRequire = createRequire(options.configSource)
  const policy = serviceRequire('@clerum/jwt-key-policy') as typeof Policy
  const storeApi = serviceRequire('@clerum/jwt-key-policy/dev-store') as typeof Store
  const cryptoFixtures = serviceRequire(join(repoRoot, 'packages/jwt-key-policy/test/crypto-fixtures.cjs')) as CryptoFixtures
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const freshPublic = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString().trim()
  const signingPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().trim()
  const cert = cryptoFixtures.certificate(pair.privateKey)
  const encodings = cryptoFixtures.encodings(freshPublic)
  const originalEnv = { ...process.env }
  let artifactRoot: string | undefined
  let layout: string | undefined
  let store: string
  const cases: VerifierContractCase[] = []
  const add = (name: string, run: VerifierContractCase['run']) => cases.push({ name, run })
  const publicPath = () => join(store, `${options.slot}.public.pem`)
  const publish = (pem = freshPublic) => writeFileSync(publicPath(), pem, { mode: 0o644 })
  const fingerprint = (pem: string) => policy.publicKeyPemFingerprint(pem)
  const expectFailure = (code: string, reason?: string) => assert.rejects(options.loadConfig, error => {
    const value = error as { code?: string; reason?: string }
    assert.equal(value.code, code)
    if (reason !== undefined) assert.equal(value.reason, reason)
    return true
  })

  async function withEffectiveUid(values: readonly number[], run: () => Promise<void>): Promise<void> {
    const effectiveUid = process.geteuid
    assert.equal(typeof effectiveUid, 'function', 'Ownership cases require the documented POSIX store platform')
    const descriptor = Object.getOwnPropertyDescriptor(process, 'geteuid')
    let call = 0
    Object.defineProperty(process, 'geteuid', {
      configurable: true, value: () => values[Math.min(call++, values.length - 1)],
    })
    try { await run() } finally {
      if (descriptor) Object.defineProperty(process, 'geteuid', descriptor)
      else delete process.geteuid
    }
  }

  function productionEnvironment(): void {
    process.env.NODE_ENV = 'production'
    delete process.env.CLERUM_DEV_MODE
    const prefix = options.service === 'rpc-proxy' ? 'RPC_PROXY' : 'EXTERNAL_REST_API'
    const values = {
      CORS_ORIGIN: 'http://localhost:3001', JWT_ISSUER: 'control-api',
      JWT_AUDIENCE: options.slot === 'rpc' ? 'rpc-proxy' : 'profile-ui',
      CONTROL_API_BASE_URL: 'http://localhost:8090', CONTROL_API_SERVICE_TOKEN: randomUUID(),
      HCC_BASE_URL: 'http://localhost:8081', HOST_NAMESPACE: 'mcp-host',
      DESKTOP_COOKIE_SECRET: randomUUID(), SANDBOX_UI_COOKIE_SECRET: randomUUID(),
      OAUTH_CALLBACK_BASE_URL: 'http://localhost:8090', GOOGLE_CLIENT_ID: randomUUID(),
      PUBLIC_BASE_URL: 'http://localhost:8091', DESKTOP_RPC_PROXY_BASE_URL: 'http://localhost:8094',
    }
    for (const [name, value] of Object.entries(values)) process.env[`${prefix}_${name}`] = value
  }

  // Compile the actual configuration and its TypeScript closure. Full-service
  // builds and production image validation remain separate evidence lanes.
  function prepare(): void {
    artifactRoot = realpathSync(mkdtempSync(join(tmpdir(), `evenfire-${options.slot}-jwt-artifact-`)))
    execFileSync(process.execPath, [
      serviceRequire.resolve('typescript/bin/tsc'), fileURLToPath(options.configSource),
      '--outDir', artifactRoot, '--rootDir', join(serviceRoot, 'src'),
      '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022',
      '--strict', '--skipLibCheck', '--esModuleInterop',
    ], { cwd: serviceRoot, stdio: ['ignore', 'pipe', 'pipe'], timeout: 45_000, maxBuffer: 256 * 1024 })
  }

  function reset(): void {
    options.resetModules()
    process.env = { ...originalEnv, NODE_ENV: 'test', CLERUM_DEV_MODE: 'true' }
    delete process.env[options.envName]
    layout = realpathSync(mkdtempSync(join(tmpdir(), `evenfire-${options.slot}-verifier-`)))
    store = join(layout, 'store')
    mkdirSync(store, { mode: 0o700 })
    process.env.EVENFIRE_DEV_KEY_STORE = store
  }

  function cleanup(): void {
    process.env = { ...originalEnv }
    if (layout) rmSync(layout, { recursive: true, force: true })
    layout = undefined
    options.resetModules()
  }

  function dispose(): void {
    cleanup()
    if (artifactRoot) rmSync(artifactRoot, { recursive: true, force: true })
    artifactRoot = undefined
  }

  function runRuntime(runtime: 'src' | 'dist', override: string | undefined, configure?: {
    supplied?: string; productionDev?: boolean; denied?: string; consumerOverride?: string
  }): RuntimeResult {
    assert.ok(layout && artifactRoot, 'Prepare the actual consumer artifacts before running a runtime case')
    const moduleDir = join(layout, options.service, runtime)
    const policyDir = join(layout, 'node_modules/@clerum/jwt-key-policy')
    mkdirSync(join(layout, 'control-api'), { recursive: true })
    mkdirSync(moduleDir, { recursive: true })
    mkdirSync(policyDir, { recursive: true })
    for (const name of ['package.json', 'index.cjs', 'index.d.ts', 'dev-store.cjs', 'dev-store.d.ts']) {
      copyFileSync(join(repoRoot, 'packages/jwt-key-policy', name), join(policyDir, name))
    }
    const configPath = join(moduleDir, runtime === 'src' ? 'config.ts' : 'config.js')
    copyFileSync(runtime === 'src' ? options.configSource : join(artifactRoot, 'config.js'), configPath)
    const runner = `
      const path = require('node:path');
      const fs = require('node:fs');
      const crypto = require('node:crypto');
      let storeOperations = 0;
      let storeDir = '';
      for (const name of ['lstatSync', 'openSync', 'mkdirSync', 'readFileSync', 'writeFileSync', 'linkSync', 'unlinkSync']) {
        const original = fs[name];
        fs[name] = (...args) => {
          if (storeDir && typeof args[0] === 'string' && path.resolve(args[0]).startsWith(storeDir)) storeOperations++;
          return original(...args);
        };
      }
      const policy = require(${JSON.stringify(join(policyDir, 'index.cjs'))});
      const storeApi = require(${JSON.stringify(join(policyDir, 'dev-store.cjs'))});
      storeDir = storeApi.resolveDevKeyStoreDir(${JSON.stringify(join(layout, 'control-api'))}, process.env.EVENFIRE_DEV_KEY_STORE);
      const material = storeApi.loadOrCreateDevSigningMaterial(${JSON.stringify(options.slot)}, storeDir);
      storeOperations = 0;
      if (${JSON.stringify(configure?.consumerOverride ?? null)} !== null) process.env.EVENFIRE_DEV_KEY_STORE = ${JSON.stringify(configure?.consumerOverride ?? null)};
      if (${JSON.stringify(configure?.denied ?? null)}) {
        const parse = policy.parseVerifierMaterial;
        policy.parseVerifierMaterial = (raw, source, options) => parse(raw, source, { ...options, fingerprints: [${JSON.stringify(configure?.denied ?? '')}] });
      }
      try {
        const { config } = require(${JSON.stringify(configPath)});
        const input = Buffer.from('actual-verifier-key-contract');
        const signature = crypto.sign('RSA-SHA256', input, material.privatePem);
        process.stdout.write(JSON.stringify({ storeDir, fingerprint: policy.publicKeyPemFingerprint(config.jwtPublicKey),
          signatureVerified: crypto.verify('RSA-SHA256', input, config.jwtPublicKey, signature), storeOperations }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ storeDir, storeOperations, code: error.code, reason: error.reason,
          productionDevModeRejected: /CLERUM_DEV_MODE=true is not allowed with NODE_ENV=production/.test(error.message) }));
      }
    `
    const env = { ...process.env }
    if (override === undefined) delete env.EVENFIRE_DEV_KEY_STORE
    else env.EVENFIRE_DEV_KEY_STORE = override
    delete env[options.envName]
    if (configure?.supplied !== undefined) env[options.envName] = configure.supplied
    if (configure?.productionDev) env.NODE_ENV = 'production'
    const args = runtime === 'src' ? ['--import', serviceRequire.resolve('tsx'), '-e', runner] : ['-e', runner]
    return JSON.parse(execFileSync(process.execPath, args, {
      cwd: join(layout, options.service), env, encoding: 'utf8', timeout: 15_000,
      maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    })) as RuntimeResult
  }

  add('verifies the real producer public identity and distinguishes another identity', async () => {
    const material = storeApi.loadOrCreateDevSigningMaterial(options.slot, store)
    const { config } = await options.loadConfig()
    assert.equal(fingerprint(config.jwtPublicKey), material.fingerprint)
    assert.equal(fingerprint(config.jwtPublicKey) === fingerprint(freshPublic), false)
  })
  for (const runtime of ['src', 'dist'] as const) {
    for (const override of [undefined, '', ' \t ']) {
      add(`${runtime} shares the default store with ${JSON.stringify(override)} override and restarts`, () => {
        const first = runRuntime(runtime, override)
        const second = runRuntime(runtime, override)
        assert.equal(first.storeDir, join(layout!, 'control-api', '.dev-keys'))
        assert.equal(first.signatureVerified, true)
        assert.equal(second.signatureVerified, true)
        assert.equal(second.fingerprint, first.fingerprint)
      })
    }
    add(`${runtime} shares an absolute producer store and restarts`, () => {
      const first = runRuntime(runtime, store)
      const second = runRuntime(runtime, store)
      assert.equal(first.storeDir, store)
      assert.equal(first.signatureVerified, true)
      assert.equal(second.fingerprint, first.fingerprint)
    })
  }
  for (const [name, encoded] of Object.entries(encodings)) {
    for (const origin of ['environment', 'store'] as const) {
      add(`accepts ${name} from ${origin} as canonical SPKI`, async () => {
        if (origin === 'environment') process.env[options.envName] = encoded
        else publish(encoded)
        assert.equal((await options.loadConfig()).config.jwtPublicKey === freshPublic, true)
      })
    }
    for (const [slot, publicPem] of Object.entries(cryptoFixtures.PUBLIC_KEYS)) {
      add(`rejects historical ${slot} in ${name} in production`, async () => {
        productionEnvironment()
        process.env[options.envName] = cryptoFixtures.encodings(publicPem)[name]
        await expectFailure('ERR_JWT_KEY_BANNED', 'banned_identity')
      })
      add(`rejects historical ${slot} in ${name} from the public store`, async () => {
        publish(cryptoFixtures.encodings(publicPem)[name])
        await expectFailure('ERR_JWT_KEY_BANNED', 'banned_identity')
      })
    }
  }
  const carriers = {
    pkcs1: createPublicKey(freshPublic).export({ type: 'pkcs1', format: 'pem' }).toString(),
    certificate: cert,
  }
  for (const [name, pem] of Object.entries(carriers)) {
    for (const origin of ['environment', 'store'] as const) {
      add(`accepts RSA ${name} from ${origin}`, async () => {
        if (origin === 'environment') process.env[options.envName] = pem
        else publish(pem)
        assert.equal(fingerprint((await options.loadConfig()).config.jwtPublicKey), fingerprint(freshPublic))
      })
    }
    for (const [slot, publicPem] of Object.entries(cryptoFixtures.PUBLIC_KEYS)) {
      add(`rejects historical ${slot} as ${name}`, async () => {
        process.env[options.envName] = name === 'certificate'
          ? await cryptoFixtures.certificateWithPublic(publicPem)
          : createPublicKey(publicPem).export({ type: 'pkcs1', format: 'pem' }).toString()
        await expectFailure('ERR_JWT_KEY_BANNED', 'banned_identity')
      })
      add(`rejects historical ${slot} as ${name} from the public store`, async () => {
        const material = name === 'certificate'
          ? await cryptoFixtures.certificateWithPublic(publicPem)
          : createPublicKey(publicPem).export({ type: 'pkcs1', format: 'pem' }).toString()
        publish(material)
        await expectFailure('ERR_JWT_KEY_BANNED', 'banned_identity')
      })
    }
  }
  for (const [name, pem] of Object.entries({
    pkcs8: signingPem, pkcs1: pair.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
  })) {
    add(`accepts legacy ${name} environment input but exports public only`, async () => {
      process.env[options.envName] = pem
      const { config } = await options.loadConfig()
      assert.equal(config.jwtPublicKey === freshPublic, true)
      assert.equal(config.jwtPublicKey.includes('PRIVATE'), false)
    })
    add(`rejects private ${name} in a public store`, async () => {
      publish(pem)
      await expectFailure('ERR_JWT_KEY_INVALID', 'wrong_key_role')
    })
  }
  add('accepts RSA-4096 and refuses RSA-1024 verification material', async () => {
    for (const bits of [4096, 1024]) {
      const publicPem = generateKeyPairSync('rsa', { modulusLength: bits }).publicKey.export({ type: 'spki', format: 'pem' }).toString()
      options.resetModules()
      process.env[options.envName] = publicPem
      if (bits === 4096) assert.equal(fingerprint((await options.loadConfig()).config.jwtPublicKey), fingerprint(publicPem))
      else await expectFailure('ERR_JWT_KEY_INVALID', 'undersized_rsa_key')
    }
  })
  for (const origin of ['environment', 'store'] as const) {
    for (const [name, value] of Object.entries({
      malformed: 'not a PEM key',
      ec: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      publicBundle: `${freshPublic}\n${cryptoFixtures.PUBLIC_KEYS.admin}`,
      mixedBundle: `${cert}\n${signingPem}`,
      reverseMixedBundle: `${signingPem}\n${cert}`,
      certificateBundle: `${cert}\n${cert}`,
      escapedBundle: `${freshPublic}\n${cert}`.replace(/\n/g, '\\n'),
    })) {
      add(`rejects ${name} from ${origin}`, async () => {
        if (origin === 'environment') process.env[options.envName] = value
        else publish(value)
        await expectFailure('ERR_JWT_KEY_INVALID')
      })
    }
  }
  add('explicit material uses zero store I/O with an unused relative override', async () => {
    process.env[options.envName] = freshPublic
    process.env.EVENFIRE_DEV_KEY_STORE = 'unused-relative-store'
    assert.equal(fingerprint((await options.loadConfig()).config.jwtPublicKey), fingerprint(freshPublic))
    const result = runRuntime('dist', store, { supplied: freshPublic, consumerOverride: 'unused-relative-store' })
    assert.equal(result.storeOperations, 0)
    assert.equal(result.fingerprint, fingerprint(freshPublic))
  })
  add('malformed explicit input never falls back to a valid producer store', () => {
    const rejected = runRuntime('dist', store, { supplied: 'malformed explicit input' })
    assert.equal(rejected.code, 'ERR_JWT_KEY_INVALID')
    assert.equal(rejected.storeOperations, 0)
    const valid = runRuntime('dist', store)
    assert.equal(valid.signatureVerified, true)
    assert.equal(valid.storeOperations > 0, true)
  })
  add('generated denied identity fails at the actual emitted config boundary', () => {
    const denied = runRuntime('dist', store, { supplied: freshPublic, denied: fingerprint(freshPublic) })
    assert.equal(denied.code, 'ERR_JWT_KEY_BANNED')
    assert.equal(denied.reason, 'banned_identity')
    assert.equal(denied.storeOperations, 0)
    assert.equal(runRuntime('dist', store).signatureVerified, true)
  })
  add('production dev mode rejects before store access with or without explicit material', () => {
    productionEnvironment()
    process.env.CLERUM_DEV_MODE = 'true'
    for (const supplied of [undefined, freshPublic]) {
      const result = runRuntime('dist', store, { supplied, productionDev: true })
      assert.equal(result.productionDevModeRejected, true)
      assert.equal(result.storeOperations, 0)
    }
  })
  for (const devFlag of [undefined, '', 'false', 'TRUE', '1']) {
    add(`fails closed when dev flag is ${JSON.stringify(devFlag)}`, async () => {
      if (devFlag === undefined) delete process.env.CLERUM_DEV_MODE
      else process.env.CLERUM_DEV_MODE = devFlag
      await assert.rejects(options.loadConfig, new RegExp(`Missing required environment variable: ${options.envName}`))
    })
  }
  for (const value of [undefined, '']) {
    add(`fails closed in production with ${JSON.stringify(value)} material`, async () => {
      productionEnvironment()
      if (value === undefined) delete process.env[options.envName]
      else process.env[options.envName] = value
      await assert.rejects(options.loadConfig, new RegExp(`Missing required environment variable: ${options.envName}`))
    })
  }
  add('rejects relative used store paths', async () => {
    process.env.EVENFIRE_DEV_KEY_STORE = 'relative-store'
    await expectFailure('ERR_JWT_DEV_STORE', 'relative_store_path')
  })
  add('requires existing producer material without generating it', async () => {
    await expectFailure('ERR_JWT_DEV_STORE', 'missing_material')
  })
  for (const suffix of ['', '/', '/.']) {
    add(`rejects final-directory symlinks with ${JSON.stringify(suffix)} suffix`, async () => {
      rmdirSync(store)
      const target = join(layout!, 'target')
      mkdirSync(target, { mode: 0o700 })
      writeFileSync(join(target, `${options.slot}.public.pem`), freshPublic, { mode: 0o644 })
      symlinkSync(target, store)
      process.env.EVENFIRE_DEV_KEY_STORE = store + suffix
      await expectFailure('ERR_JWT_DEV_STORE', 'symbolic_link')
    })
  }
  add('rejects writable public files and broad directory permissions', async () => {
    publish()
    chmodSync(publicPath(), 0o666)
    await expectFailure('ERR_JWT_DEV_STORE', 'insecure_file')
    chmodSync(publicPath(), 0o644)
    chmodSync(store, 0o755)
    options.resetModules()
    await expectFailure('ERR_JWT_DEV_STORE', 'insecure_directory')
  })
  add('rejects public symlinks and non-regular public paths', async () => {
    const target = join(layout!, 'public-target.pem')
    writeFileSync(target, freshPublic, { mode: 0o644 })
    symlinkSync(target, publicPath())
    await expectFailure('ERR_JWT_DEV_STORE', 'symbolic_link')
    rmSync(publicPath())
    mkdirSync(publicPath())
    options.resetModules()
    await expectFailure('ERR_JWT_DEV_STORE', 'not_regular_file')
  })

  add('rejects a regular file where the producer directory must be', async () => {
    rmdirSync(store)
    writeFileSync(store, 'directory contract fixture')
    await expectFailure('ERR_JWT_DEV_STORE', 'invalid_directory')
  })
  add('rejects foreign-owned directories after a same-owner positive control', async () => {
    publish()
    const getUid = process.geteuid
    assert.ok(typeof getUid === 'function', 'Ownership cases require POSIX effective-user support')
    const uid = getUid()
    assert.equal(fingerprint((await options.loadConfig()).config.jwtPublicKey), fingerprint(freshPublic))
    options.resetModules()
    await withEffectiveUid([uid + 1], () => expectFailure('ERR_JWT_DEV_STORE', 'directory_owner_mismatch'))
  })
  add('rejects foreign-owned public files after validating the directory', async () => {
    publish()
    const getUid = process.geteuid
    assert.ok(typeof getUid === 'function', 'Ownership cases require POSIX effective-user support')
    const uid = getUid()
    await withEffectiveUid([uid, uid + 1], () => expectFailure('ERR_JWT_DEV_STORE', 'file_owner_mismatch'))
  })

  return { cases, prepare, reset, cleanup, dispose }
}
