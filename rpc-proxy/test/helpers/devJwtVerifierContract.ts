import { execFileSync } from 'node:child_process'
import { createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  BANNED_DEV_JWT_PUBLIC_KEY_FINGERPRINTS,
  publicKeyPemFingerprint,
} from '../../../control-api/src/bannedDevSigningKeys.js'
import { loadOrGenerateDevJwtPrivateKey } from '../../../control-api/src/devSigningKeys.js'
import { BANNED_DEV_JWT_PUBLIC_KEYS } from '../../../control-api/test/fixtures/bannedDevJwtPublicKeys.js'

type VerifierModule = {
  config: { jwtPublicKey: string; jwtIssuer: string; jwtAudience: string }
}

type VerifierContract = {
  testApi: Pick<
    typeof import('vitest'),
    'afterEach' | 'beforeEach' | 'describe' | 'expect' | 'it' | 'vi'
  >
  service: 'rpc-proxy' | 'external-rest-api'
  slot: 'rpc' | 'session'
  envName: string
  configSource: URL
  loadConfig: () => Promise<VerifierModule>
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const freshPublic = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .publicKey.export({ type: 'spki', format: 'pem' })
  .toString()
  .trim()
const encodings = {
  spki: (pem: string) => pem,
  escaped: (pem: string) => pem.replace(/\n/g, '\\n'),
  crlf: (pem: string) => pem.replace(/\n/g, '\r\n'),
  'escaped-crlf': (pem: string) => pem.replace(/\n/g, '\\r\\n'),
  pkcs1: (pem: string) => createPublicKey(pem).export({ type: 'pkcs1', format: 'pem' }).toString(),
}

/**
 * Both standalone services share this test contract. Identity cases use the
 * real producer; written public files only exercise encodings and filesystem
 * rejection, where no signing identity is being claimed.
 * Caller-supplied test APIs respect the services' distinct Vitest versions.
 */
export function defineDevJwtVerifierContract(contract: VerifierContract): void {
  const { afterEach, beforeEach, describe, expect, it, vi } = contract.testApi
  // CI installs only the selected service's dependencies. Resolve from its
  // source module, even when this shared test helper belongs to the sibling.
  const serviceRequire = createRequire(contract.configSource)
  const jwt = serviceRequire('jsonwebtoken') as typeof import('jsonwebtoken')
  const ts = serviceRequire('typescript') as typeof import('typescript')
  const originalEnv = { ...process.env }
  let layout: string
  let store: string
  const publicFile = `${contract.slot}.public.pem`

  beforeEach(() => {
    vi.resetModules()
    process.env = { ...originalEnv, NODE_ENV: 'test', CLERUM_DEV_MODE: 'true' }
    delete process.env[contract.envName]
    // Node canonicalizes require.__dirname; macOS aliases /var to /private/var.
    layout = realpathSync(mkdtempSync(join(tmpdir(), `evenfire-${contract.slot}-verifier-`)))
    store = join(layout, 'store')
    mkdirSync(store, { mode: 0o700 })
    process.env.EVENFIRE_DEV_KEY_STORE = store
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.env = originalEnv
    rmSync(layout, { recursive: true, force: true })
    vi.resetModules()
  })

  function publishPublic(pem = freshPublic): void {
    writeFileSync(join(store, publicFile), pem, { mode: 0o644 })
  }

  function useProductionEnvironment(): void {
    process.env.NODE_ENV = 'production'
    delete process.env.CLERUM_DEV_MODE
    const prefix = contract.service === 'rpc-proxy' ? 'RPC_PROXY' : 'EXTERNAL_REST_API'
    const values = [
      ['CORS_ORIGIN', 'http://localhost:3001'],
      ['JWT_ISSUER', 'control-api'],
      ['JWT_AUDIENCE', contract.slot === 'rpc' ? 'rpc-proxy' : 'profile-ui'],
      ['CONTROL_API_BASE_URL', 'http://localhost:8090'],
      ['CONTROL_API_SERVICE_TOKEN', randomUUID()],
      ['HCC_BASE_URL', 'http://localhost:8081'],
      ['HOST_NAMESPACE', 'mcp-host'],
      ['DESKTOP_COOKIE_SECRET', randomUUID()],
      ['SANDBOX_UI_COOKIE_SECRET', randomUUID()],
      ['OAUTH_CALLBACK_BASE_URL', 'http://localhost:8090'],
      ['GOOGLE_CLIENT_ID', randomUUID()],
      ['PUBLIC_BASE_URL', 'http://localhost:8091'],
      ['DESKTOP_RPC_PROXY_BASE_URL', 'http://localhost:8094'],
      ['DESKTOP_APP_NAME', 'Evenfire'],
      ['DESKTOP_RELEASE_BASE_URL', 'http://localhost:8091/releases'],
    ]
    Object.assign(
      process.env,
      Object.fromEntries(values.map(([name, value]) => [`${prefix}_${name}`, value]))
    )
  }

  function runIsolatedRuntime(runtime: 'src' | 'dist', override: string | undefined) {
    const producerDir = join(layout, 'control-api', runtime)
    const verifierDir = join(layout, contract.service, runtime)
    mkdirSync(producerDir, { recursive: true })
    mkdirSync(verifierDir, { recursive: true })
    const producerSource = join(repoRoot, 'control-api/src/devSigningKeys.ts')
    const producerPath = join(producerDir, `devSigningKeys.${runtime === 'src' ? 'ts' : 'js'}`)
    const verifierPath = join(verifierDir, `config.${runtime === 'src' ? 'ts' : 'js'}`)
    if (runtime === 'src') {
      copyFileSync(producerSource, producerPath)
      copyFileSync(contract.configSource, verifierPath)
    } else {
      for (const [source, destination] of [
        [producerSource, producerPath],
        [contract.configSource, verifierPath],
      ] as const) {
        writeFileSync(
          destination,
          ts.transpileModule(readFileSync(source, 'utf8'), {
            compilerOptions: {
              module: ts.ModuleKind.CommonJS,
              target: ts.ScriptTarget.ES2022,
              esModuleInterop: true,
            },
          }).outputText
        )
      }
    }
    // Retain the real validation dependency without duplicating its contents.
    writeFileSync(
      join(producerDir, 'bannedDevSigningKeys.js'),
      `module.exports = require(${JSON.stringify(join(repoRoot, 'control-api/src/bannedDevSigningKeys.ts'))})`
    )
    const runner = `
      const producer = require(${JSON.stringify(producerPath)});
      const material = producer.loadOrGenerateDevJwtPrivateKey(${JSON.stringify(contract.slot)});
      const { config } = require(${JSON.stringify(verifierPath)});
      const jwt = require(${JSON.stringify(serviceRequire.resolve('jsonwebtoken'))});
      const signedJwt = jwt.sign({ sub: 'isolated-dev-key-store' }, material, {
        algorithm: 'RS256', issuer: config.jwtIssuer, audience: config.jwtAudience
      });
      const claims = jwt.verify(signedJwt, config.jwtPublicKey, {
        algorithms: ['RS256'], issuer: config.jwtIssuer, audience: config.jwtAudience
      });
      process.stdout.write(JSON.stringify({
        storeDir: producer.defaultDevSigningKeyStoreDir(), sub: claims.sub, audience: claims.aud
      }));
    `
    const env = { ...process.env }
    delete env[contract.envName]
    if (override === undefined) delete env.EVENFIRE_DEV_KEY_STORE
    else env.EVENFIRE_DEV_KEY_STORE = override
    return JSON.parse(
      execFileSync(process.execPath, ['--import', serviceRequire.resolve('tsx'), '-e', runner], {
        cwd: join(layout, contract.service),
        env,
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 64 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    ) as { storeDir: string; sub: string; audience: string }
  }

  describe(`${contract.service} dev JWT verifier contract`, () => {
    it('verifies a real producer RS256 token from an explicit absolute store', async () => {
      const material = loadOrGenerateDevJwtPrivateKey(contract.slot, store)
      const { config } = await contract.loadConfig()
      expect(publicKeyPemFingerprint(config.jwtPublicKey)).toBe(
        publicKeyPemFingerprint(
          createPublicKey(material).export({ type: 'spki', format: 'pem' }).toString()
        )
      )
      const signedJwt = jwt.sign({ sub: 'dev-key-store-contract' }, material, {
        algorithm: 'RS256',
        issuer: config.jwtIssuer,
        audience: config.jwtAudience,
      })
      expect(
        jwt.verify(signedJwt, config.jwtPublicKey, {
          algorithms: ['RS256'],
          issuer: config.jwtIssuer,
          audience: config.jwtAudience,
        })
      ).toMatchObject({ sub: 'dev-key-store-contract', aud: config.jwtAudience })
    })
    for (const runtime of ['src', 'dist'] as const) {
      it.each([undefined, '', ' \t '])(
        `${runtime} shares the default producer store when override is %j`,
        override => {
          const result = runIsolatedRuntime(runtime, override)
          expect(result.storeDir).toBe(join(layout, 'control-api', '.dev-keys'))
          expect(result.sub).toBe('isolated-dev-key-store')
          expect(result.audience).toBe(contract.slot === 'rpc' ? 'rpc-proxy' : 'profile-ui')
        }
      )
      it(`${runtime} shares an explicit absolute producer store`, () => {
        const result = runIsolatedRuntime(runtime, store)
        expect(result.storeDir).toBe(store)
        expect(result.sub).toBe('isolated-dev-key-store')
      })
    }
    it('matches the canonical signing-key fingerprint denylist', async () => {
      // Keep standalone runtime guards private; compare their explicit local
      // identities, then test every canonical public fixture behavior below.
      const declaration = readFileSync(contract.configSource, 'utf8').match(
        /const HISTORICAL_DEV_JWT_PUBLIC_FINGERPRINTS[\s\S]*?new Set\(\[([\s\S]*?)\]\)/
      )
      expect(declaration).not.toBeNull()
      const localFingerprints = [...declaration![1].matchAll(/'([a-f0-9]{64})'/g)].map(
        match => match[1]
      )
      expect(localFingerprints.sort()).toEqual([...BANNED_DEV_JWT_PUBLIC_KEY_FINGERPRINTS].sort())
    })

    if (contract.service === 'external-rest-api') {
      it('loads this contract with only the external service dependencies installed', () => {
        const helperDir = join(layout, 'rpc-proxy/test/helpers')
        const callerDir = join(layout, 'external-rest-api/src')
        mkdirSync(helperDir, { recursive: true })
        mkdirSync(callerDir, { recursive: true })
        const helperPath = join(helperDir, 'devJwtVerifierContract.ts')
        copyFileSync(fileURLToPath(import.meta.url), helperPath)
        const callerPath = join(callerDir, 'config.ts')
        writeFileSync(callerPath, '')
        symlinkSync(
          join(dirname(fileURLToPath(contract.configSource)), '../node_modules'),
          join(layout, 'external-rest-api/node_modules'),
          'dir'
        )
        for (const relativePath of [
          'control-api/src/bannedDevSigningKeys.ts',
          'control-api/src/devSigningKeys.ts',
          'control-api/test/fixtures/bannedDevJwtPublicKeys.ts',
        ]) {
          const fixturePath = join(layout, relativePath)
          mkdirSync(dirname(fixturePath), { recursive: true })
          symlinkSync(join(repoRoot, relativePath), fixturePath)
        }
        expect(existsSync(join(layout, 'rpc-proxy/node_modules'))).toBe(false)
        const runner = `
          const { defineDevJwtVerifierContract } = require(${JSON.stringify(helperPath)});
          const it = () => {}; it.each = () => () => {};
          defineDevJwtVerifierContract({
            service: 'external-rest-api', slot: 'session', envName: 'EXTERNAL_REST_API_JWT_PUBLIC_KEY',
            configSource: new URL(${JSON.stringify(pathToFileURL(callerPath).href)}),
            loadConfig: async () => { throw new Error('Registration must not load configuration'); },
            testApi: { beforeEach() {}, afterEach() {}, describe(_name, run) { run(); }, it, vi: {} }
          });
          process.stdout.write('caller-dependencies-ok');
        `
        expect(
          execFileSync(
            process.execPath,
            ['--import', serviceRequire.resolve('tsx'), '-e', runner],
            {
              cwd: join(layout, 'external-rest-api'),
              env: process.env,
              encoding: 'utf8',
              timeout: 15_000,
              maxBuffer: 64 * 1024,
              stdio: ['ignore', 'pipe', 'pipe'],
            }
          )
        ).toBe('caller-dependencies-ok')
      })
    }

    for (const [encoding, encode] of Object.entries(encodings)) {
      it(`accepts a fresh operator ${encoding} verifier in production outside dev mode`, async () => {
        useProductionEnvironment()
        process.env[contract.envName] = encode(freshPublic)
        expect((await contract.loadConfig()).config.jwtPublicKey).toBe(freshPublic)
      })
      for (const [slot, bannedPublic] of Object.entries(BANNED_DEV_JWT_PUBLIC_KEYS)) {
        it(`rejects the historical ${slot} verifier as ${encoding} in production`, async () => {
          useProductionEnvironment()
          process.env[contract.envName] = encode(bannedPublic)
          await expect(contract.loadConfig).rejects.toThrow(/historically committed dev JWT key/)
        })
      }
    }
    it.each([undefined, ''])(
      'fails closed in production with a missing or blank verifier (%j)',
      async value => {
        useProductionEnvironment()
        if (value === undefined) delete process.env[contract.envName]
        else process.env[contract.envName] = value
        await expect(contract.loadConfig).rejects.toThrow(
          new RegExp(`Missing required environment variable: ${contract.envName}`)
        )
      }
    )
    it('rejects production dev mode even when an operator verifier is supplied', async () => {
      useProductionEnvironment()
      process.env.CLERUM_DEV_MODE = 'true'
      process.env[contract.envName] = freshPublic
      await expect(contract.loadConfig).rejects.toThrow(
        /CLERUM_DEV_MODE=true is not allowed with NODE_ENV=production/
      )
    })
    for (const [encoding, encode] of Object.entries(encodings)) {
      for (const source of ['env', 'store']) {
        it(`accepts fresh RSA ${encoding} from ${source} and uses canonical SPKI`, async () => {
          if (source === 'env') {
            delete process.env.CLERUM_DEV_MODE
            process.env[contract.envName] = encode(freshPublic)
          } else publishPublic(encode(freshPublic))
          expect((await contract.loadConfig()).config.jwtPublicKey).toBe(freshPublic)
        })
        for (const [slot, bannedPublic] of Object.entries(BANNED_DEV_JWT_PUBLIC_KEYS)) {
          it(`rejects the historical ${slot} identity as ${encoding} from ${source}`, async () => {
            if (source === 'env') {
              delete process.env.CLERUM_DEV_MODE
              process.env[contract.envName] = encode(bannedPublic)
            } else publishPublic(encode(bannedPublic))
            await expect(contract.loadConfig).rejects.toThrow(/historically committed dev JWT key/)
          })
        }
      }
    }
    for (const source of ['env', 'store']) {
      it(`rejects malformed public material from ${source}`, async () => {
        if (source === 'env') process.env[contract.envName] = 'not a PEM key'
        else publishPublic('not a PEM key')
        await expect(contract.loadConfig).rejects.toThrow(/PEM-encoded RSA public key/)
      })
      it(`rejects a non-RSA public key from ${source}`, async () => {
        const ecPublic = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
          .publicKey.export({ type: 'spki', format: 'pem' })
          .toString()
        if (source === 'env') process.env[contract.envName] = ecPublic
        else publishPublic(ecPublic)
        await expect(contract.loadConfig).rejects.toThrow(/PEM-encoded RSA public key/)
      })
      for (const escaped of [false, true]) {
        it(`rejects a ${escaped ? 'escaped' : 'literal'} multi-PEM bundle from ${source}`, async () => {
          const bundle = `${freshPublic}\n${BANNED_DEV_JWT_PUBLIC_KEYS.admin}`
          const value = escaped ? encodings.escaped(bundle) : bundle
          if (source === 'env') process.env[contract.envName] = value
          else publishPublic(value)
          await expect(contract.loadConfig).rejects.toThrow(/single PEM-encoded RSA public key/)
        })
      }
    }
    it('prefers an explicit verifier over an unused relative store override', async () => {
      process.env[contract.envName] = freshPublic
      process.env.EVENFIRE_DEV_KEY_STORE = 'unused-relative-store'
      expect((await contract.loadConfig()).config.jwtPublicKey).toBe(freshPublic)
    })
    it('rejects a relative store override before reading any key', async () => {
      process.env.EVENFIRE_DEV_KEY_STORE = 'relative-store'
      await expect(contract.loadConfig).rejects.toThrow(
        /EVENFIRE_DEV_KEY_STORE must be an absolute path/
      )
    })
    it('fails loud when the producer public file is missing', async () => {
      await expect(contract.loadConfig).rejects.toThrow(/requires the control-api dev key store/)
    })
    it('rejects a symlinked store directory', async () => {
      rmdirSync(store)
      const target = join(layout, 'directory-target')
      mkdirSync(target, { mode: 0o700 })
      writeFileSync(join(target, publicFile), freshPublic, { mode: 0o644 })
      symlinkSync(target, store)
      await expect(contract.loadConfig).rejects.toThrow(/not a directory/)
    })
    it('rejects a store path that is a regular file', async () => {
      rmdirSync(store)
      writeFileSync(store, 'not a directory')
      await expect(contract.loadConfig).rejects.toThrow(/not a directory/)
    })
    it('rejects a directory with group or other permissions', async () => {
      publishPublic()
      chmodSync(store, 0o755)
      await expect(contract.loadConfig).rejects.toThrow(/directory has group\/other permissions/)
    })
    it('rejects a directory owned by another user', async () => {
      publishPublic()
      const uid = process.geteuid!()
      vi.spyOn(process, 'geteuid').mockReturnValue(uid + 1)
      await expect(contract.loadConfig).rejects.toThrow(
        /directory is not owned by the current user/
      )
    })
    it('rejects a symlinked public file', async () => {
      const target = join(layout, 'public-target.pem')
      writeFileSync(target, freshPublic, { mode: 0o644 })
      symlinkSync(target, join(store, publicFile))
      await expect(contract.loadConfig).rejects.toThrow(/symbolic link/)
    })
    it('rejects a public path that is not a regular file', async () => {
      mkdirSync(join(store, publicFile))
      await expect(contract.loadConfig).rejects.toThrow(/not a regular file/)
    })
    it('rejects group or other writable public files', async () => {
      publishPublic()
      chmodSync(join(store, publicFile), 0o666)
      await expect(contract.loadConfig).rejects.toThrow(
        /public file must not be group\/other writable/
      )
    })
    it('rejects a public file owned by another user', async () => {
      publishPublic()
      const uid = process.geteuid!()
      vi.spyOn(process, 'geteuid')
        .mockReturnValueOnce(uid)
        .mockReturnValue(uid + 1)
      await expect(contract.loadConfig).rejects.toThrow(/file is not owned by the current user/)
    })
    it('fails closed outside dev mode when the verifier is missing', async () => {
      delete process.env.CLERUM_DEV_MODE
      await expect(contract.loadConfig).rejects.toThrow(
        new RegExp(`Missing required environment variable: ${contract.envName}`)
      )
    })
  })
}
