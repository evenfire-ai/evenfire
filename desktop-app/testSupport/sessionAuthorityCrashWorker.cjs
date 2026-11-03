const crypto = require('node:crypto')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { registerHooks } = Module

const [role, profileRoot, phase = 'none', scenario = 'same-environment'] = process.argv.slice(2)
const userData = path.join(profileRoot, 'user-data')
const reportPath = path.join(profileRoot, `${role}-${phase}.json`)
const keytarPath = path.join(__dirname, 'sessionAuthorityCrashKeytar.cjs')
const keytarFile = path.join(profileRoot, 'keytar.json')
const configPath = path.join(profileRoot, 'runtime-config.json')
const environmentSwitch = scenario === 'environment-switch'
const crashPhases = new Set([
  'after-intent',
  'after-marker',
  'after-profile-selection',
  'after-acceptance',
])
const journalRecoveryRoles = new Set(['journal-seed', 'journal-recovery-crash', 'journal-recover'])
const memoryOnlyRole = role === 'memory-seed' || role === 'memory-recover'

if (
  ![
    'seed',
    'candidate',
    'recover',
    'memory-seed',
    'memory-recover',
    ...journalRecoveryRoles,
  ].includes(role) ||
  !path.isAbsolute(profileRoot)
)
  process.exit(64)
if ((role === 'candidate' || role === 'recover') && !crashPhases.has(phase)) process.exit(64)
if (role === 'seed' && phase !== 'none') process.exit(64)
if (memoryOnlyRole && phase !== 'none') process.exit(64)
if (role === 'journal-recovery-crash' && phase !== 'after-lp') process.exit(64)
if ((role === 'journal-seed' || role === 'journal-recover') && phase !== 'none') process.exit(64)

if (memoryOnlyRole)
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })

process.env.EVENFIRE_TEST_USER_DATA = userData
process.env.EVENFIRE_TEST_KEYTAR_PATH = keytarFile
if (environmentSwitch) delete process.env.CLERUM_DESKTOP_CONFIG_PATH
else process.env.CLERUM_DESKTOP_CONFIG_PATH = configPath

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'keytar') return { url: pathToFileURL(keytarPath).href, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

const electron = {
  app: {
    getPath(name) {
      if (name === 'userData') return userData
      if (name === 'appData') return profileRoot
      if (name === 'home') return profileRoot
      throw new Error('crash fixture requested an unexpected Electron path')
    },
    setName() {},
    getName: () => 'Evenfire crash fixture',
    getVersion: () => '0.11.0',
    isReady: () => true,
    isPackaged: false,
    on() {},
    once() {},
    removeListener() {},
    whenReady: async () => undefined,
    quit() {},
    exit(code) {
      process.exit(code)
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => (memoryOnlyRole ? 'basic_text' : 'isolated-crash-test'),
    encryptString: value => Buffer.from(`test-safe-storage:${value}`),
    decryptString: value => value.toString().replace(/^test-safe-storage:/, ''),
  },
  ipcMain: { handle() {}, on() {}, removeHandler() {} },
  shell: { openExternal: async () => undefined },
  BrowserWindow: class BrowserWindow {},
}

const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electron
  if (request === 'keytar') return originalLoad.call(this, keytarPath, parent, isMain)
  return originalLoad.call(this, request, parent, isMain)
}

const identityFor = owner => ({
  id: `crash-owner-${owner}`,
  email: `owner-${owner.toLowerCase()}@example.test`,
  name: `Crash Owner ${owner}`,
  picture: null,
  teamId: 'crash-team',
  teamName: 'Crash Team',
  role: 'member',
})

const tokens = Object.freeze({
  A: `header.${Buffer.from(JSON.stringify({ sub: 'crash-owner-A', exp: 1_900_000_000 })).toString('base64url')}.synthetic-A`,
  B: `header.${Buffer.from(JSON.stringify({ sub: 'crash-owner-B', exp: 1_900_000_000 })).toString('base64url')}.synthetic-B`,
  M: `header.${Buffer.from(JSON.stringify({ sub: 'crash-owner-M', exp: 1_900_000_000 })).toString('base64url')}.synthetic-M`,
})

function tokenFor(owner) {
  return tokens[owner]
}

function tokenOwnerMap() {
  return new Map(Object.entries(tokens).map(([owner, token]) => [token, owner]))
}

function ownerForToken(token) {
  return tokenOwnerMap().get(token) ?? 'unknown'
}

function safeReport(report) {
  fs.writeFileSync(reportPath, JSON.stringify(report), { mode: 0o600 })
}

function safeFailure(error) {
  safeReport({
    ok: false,
    errorCategory: 'worker-error',
  })
  process.exit(90)
}

function authoritySummary(tokenStore, envKey) {
  return tokenStore.createSessionAuthorityStorageScope().then(storageScope => {
    const authorityDirectory = tokenStore.resolveSessionAuthorityStorageDirectory(storageScope)
    const authorityFile = path.join(
      authorityDirectory,
      `session-authority-${crypto.createHash('sha256').update(envKey).digest('hex')}`
    )
    const record = JSON.parse(fs.readFileSync(authorityFile, 'utf8'))
    const source = record.frame.source
    const marker = tokenStore.observeSessionAuthorityMarkerRaw(storageScope, userData, envKey)
    const journal =
      require('../dist/sessionPersistenceJournal.js').observeSessionPersistenceLegacySnapshot(
        userData,
        envKey
      )
    const { digestSessionAuthoritySource } = require('../dist/sessionAuthorityRecord.js')
    const keytarStore = JSON.parse(fs.readFileSync(keytarFile, 'utf8'))
    const storedValueFor = source =>
      source ? (keytarStore[`Evenfire::session-v1:${source.sourceRef}`] ?? null) : null
    const sourceMatchesReceipt = (candidateSource, storedValue) => {
      if (!candidateSource || typeof storedValue !== 'string') return false
      return (
        digestSessionAuthoritySource(
          {
            sourceKind: candidateSource.kind,
            sourceRef: candidateSource.sourceRef,
            envKey: candidateSource.envKey,
            accountId: candidateSource.accountId,
          },
          storedValue
        ) === candidateSource.storedValueDigest
      )
    }
    const sourceBytes = source
      ? (keytarStore[`Evenfire::session-v1:${source.sourceRef}`] ?? null)
      : null
    return {
      frameMode: record.frame.mode,
      frameRevision: record.frame.revision,
      source: source
        ? {
            format: source.format,
            kind: source.kind,
            accountId: source.accountId,
            sourceRef: source.sourceRef,
            sourceRevision: source.sourceRevision,
            storedValueDigest: source.storedValueDigest,
            sourceBytesPresent: typeof sourceBytes === 'string',
            sourceBytesMatchReceipt: sourceMatchesReceipt(source, sourceBytes),
            sourceBytesDigest: sourceBytes
              ? crypto.createHash('sha256').update(sourceBytes).digest('hex')
              : null,
          }
        : null,
      cleanupDebts: record.cleanupDebts.map(debt => ({
        id: debt.id,
        accountId: debt.source.accountId,
        sourceRef: debt.source.sourceRef,
        sourceRevision: debt.source.sourceRevision,
        storedValueDigest: debt.source.storedValueDigest,
        sourceBytesPresent: typeof storedValueFor(debt.source) === 'string',
        sourceBytesMatchReceipt: sourceMatchesReceipt(debt.source, storedValueFor(debt.source)),
        supersedingFrameRevision: debt.supersedingFrameRevision,
      })),
      candidates: record.candidates.map(candidate => ({
        accountId: candidate.accountId,
        phase: candidate.phase,
        transactionId: candidate.transactionId,
        sourceRef: candidate.sourceRef,
      })),
      legacyDenialHashes: record.quarantines.flatMap(item =>
        item.kind === 'legacy-journal' ? item.denials.map(denial => denial.candidateHash) : []
      ),
      projectionIntent: record.projectionIntent
        ? { operationId: record.projectionIntent.operationId }
        : null,
      projectionReceipt: record.projectionReceipt
        ? {
            operationId: record.projectionReceipt.operationId,
            markerRevision: record.projectionReceipt.marker.revision,
            markerContents: JSON.stringify(record.projectionReceipt.marker),
            journalDigest: record.projectionReceipt.legacyJournalReceipt.digest,
          }
        : null,
      marker: {
        kind: marker.kind,
        revision: marker.marker?.revision ?? null,
        intent: marker.marker?.intent.intent ?? null,
        digest: marker.rawDigest,
        contents: marker.rawContents,
      },
      journal:
        journal.status === 'observed'
          ? {
              status: 'observed',
              revision: journal.receipt.revision,
              digest: journal.receipt.digest,
              denialCount: journal.receipt.denials.length,
            }
          : { status: journal.status },
    }
  })
}

async function profileSelectionSummary(tokenStore) {
  const {
    PROFILE_SESSION_AUTHORITY_ENV_KEY,
    SessionAuthorityRecordRepository,
  } = require('../dist/sessionAuthorityRecord.js')
  const storageScope = await tokenStore.createSessionAuthorityStorageScope()
  const observation = new SessionAuthorityRecordRepository(
    storageScope,
    PROFILE_SESSION_AUTHORITY_ENV_KEY,
    tokenStore
  ).observeProfileSelection()
  if (observation.status !== 'observed') return { status: observation.status }
  const selection = observation.selection
  return {
    status: 'observed',
    state: selection?.state ?? null,
    mode: selection?.mode ?? null,
    envKey: selection?.envKey ?? null,
    userId: selection?.userId ?? null,
    teamId: selection?.teamId ?? null,
    sessionGeneration: selection?.sessionGeneration ?? null,
    transactionId: selection?.transactionId ?? null,
    sourceRef: selection?.source?.sourceRef ?? null,
  }
}

async function createService() {
  const { AppService } = require('../dist/appService.js')
  const { TokenStore } = require('../dist/tokenStore.js')
  const { saveDesktopRuntimeConfig, getActiveEnvKey } = require('../dist/config.js')
  await fs.promises.mkdir(userData, { recursive: true, mode: 0o700 })
  await fs.promises.chmod(userData, 0o700)
  await saveDesktopRuntimeConfig({
    externalRestApiBaseUrl: 'https://session-crash.invalid',
    rpcProxyBaseUrl: 'https://rpc-session-crash.invalid',
    appName: 'Session Crash Fixture',
  })
  try {
    await fs.promises.access(keytarFile)
  } catch {
    await fs.promises.writeFile(keytarFile, '{}', { mode: 0o600 })
  }
  const tokenStore =
    role === 'memory-seed' ? new TokenStore({ isolatedUserDataPath: userData }) : new TokenStore()
  const service = new AppService({
    tokenStore,
    getUserDataDirectory: () => userData,
    reportDeferredLogoutFailure: () => undefined,
  })
  const getMeOwners = []
  service.authClient.passwordLogin = async (_email, password) => {
    const owner =
      password === 'synthetic-password-A' ? 'A' : password === 'synthetic-password-M' ? 'M' : 'B'
    return { token: tokenFor(owner), me: identityFor(owner) }
  }
  service.authClient.getMe = async token => {
    const owner = ownerForToken(token)
    getMeOwners.push(owner)
    if (owner === 'unknown') throw new Error('unknown synthetic token')
    return identityFor(owner)
  }
  return { service, tokenStore, getActiveEnvKey, getMeOwners }
}

async function selectSecondEnvironmentForCandidate(service) {
  const config = require('../dist/config.js')
  const restored = await service.initialize()
  if (!restored.authenticated || restored.me?.id !== 'crash-owner-A')
    throw new Error('crash fixture could not restore environment A before logout')
  const logout = await service.logout()
  if (logout.kind !== 'committed')
    throw new Error('crash fixture could not durably log out environment A')
  const first = config.getDesktopRuntimeConfigState()
  const firstOption = first.options.find(option => option.id === first.activeOptionId)
  if (!firstOption) throw new Error('crash fixture could not identify environment A')
  const firstEnvKey = config.resolveEnvKey(
    firstOption.externalRestApiBaseUrl,
    firstOption.rpcProxyBaseUrl
  )
  await config.saveDesktopRuntimeConfig({
    externalRestApiBaseUrl: 'https://session-crash-b.invalid',
    rpcProxyBaseUrl: 'https://rpc-session-crash-b.invalid',
    appName: 'Session Crash Environment B',
  })
  const afterSave = config.getDesktopRuntimeConfigState()
  const secondOption = afterSave.options.find(
    option =>
      config.resolveEnvKey(option.externalRestApiBaseUrl, option.rpcProxyBaseUrl) !== firstEnvKey
  )
  if (!secondOption) throw new Error('crash fixture could not create environment B')
  await config.selectDesktopRuntimeConfigOption(firstOption.id)
  await service.selectRuntimeConfigForHandoff(secondOption.id, service.getSessionGeneration())
  return {
    priorEnvKey: firstEnvKey,
    targetEnvKey: config.getActiveEnvKey(),
  }
}

function backingStoreContainsToken(token) {
  const expected = Buffer.from(token)
  const inspect = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory() && inspect(candidate)) return true
      if (entry.isFile() && fs.readFileSync(candidate).includes(expected)) return true
    }
    return false
  }
  return inspect(profileRoot)
}

async function main() {
  const { service, tokenStore, getActiveEnvKey, getMeOwners } = await createService()
  let envKey = getActiveEnvKey()
  let environmentSwitchInfo = null

  if (role === 'journal-seed') {
    const { SessionPersistenceProducer } = require('../dist/sessionPersistenceJournal.js')
    await tokenStore.setSessionToken(tokenFor('A'), envKey)
    const denial = new SessionPersistenceProducer(
      userData,
      envKey,
      null,
      () => {},
      () => {}
    )
    denial.prepare('keytar', tokenFor('A'))
    const journalPath = path.join(
      userData,
      `session-persistence-journal-${crypto.createHash('sha256').update(envKey).digest('hex')}`
    )
    const bytes = fs.readFileSync(journalPath)
    const pendingArrayEnd = bytes.lastIndexOf(Buffer.from(']'))
    if (pendingArrayEnd <= 0) throw new Error('writer did not produce a complete denial array')
    fs.truncateSync(journalPath, pendingArrayEnd + 1)
    const corruptedBytes = fs.readFileSync(journalPath)
    safeReport({
      ok: true,
      denialHash: crypto.createHash('sha256').update(tokenFor('A')).digest('hex'),
      corruptedJournal: true,
      corruptedJournalDigest: crypto.createHash('sha256').update(corruptedBytes).digest('hex'),
      corruptedJournalBytes: corruptedBytes.length,
    })
    process.exit(0)
  }

  if (role === 'journal-recovery-crash') {
    const { TokenStore } = require('../dist/tokenStore.js')
    const original = TokenStore.prototype.applySessionAuthorityMarkerCas
    TokenStore.prototype.applySessionAuthorityMarkerCas = function (...args) {
      const applied = original.apply(this, args)
      const cas = args[3]
      if (applied && cas?.next?.intent?.intent === 'logout-pending') {
        const observation = this.observeSessionAuthorityMarkerRaw(args[0], args[1], args[2])
        const authorityDirectory = this.resolveSessionAuthorityStorageDirectory(args[0])
        const authorityFile = path.join(
          authorityDirectory,
          `session-authority-${crypto.createHash('sha256').update(args[2]).digest('hex')}`
        )
        const authority = JSON.parse(fs.readFileSync(authorityFile, 'utf8'))
        safeReport({
          ok: true,
          crashReached: 'after-lp-sidecar-cas',
          frameMode: authority.frame.mode,
          recoveryId: authority.frame.recoveryId,
          markerIntent: observation.marker?.intent.intent ?? null,
          markerRevisionPresent: Boolean(observation.marker?.revision),
        })
        const blocked = new Int32Array(new SharedArrayBuffer(4))
        while (true) Atomics.wait(blocked, 0, 0, 60_000)
      }
      return applied
    }
    await service.passwordLogin('owner-b@example.test', 'synthetic-password-B')
    throw new Error('logout marker CAS hook did not stop the producer')
  }

  if (role === 'journal-recover') {
    const coldState = await service.initialize()
    const startupGetMeOwners = [...getMeOwners]
    let protectedHttpDispatches = 0
    let protectedRpcDispatches = 0
    const originalGfsList = service.gfsClient.listAccessible.bind(service.gfsClient)
    service.gfsClient.listAccessible = (...args) => {
      protectedHttpDispatches += 1
      return originalGfsList(...args)
    }
    const originalRpcList = service.rpcClient.listServers.bind(service.rpcClient)
    service.rpcClient.listServers = (...args) => {
      protectedRpcDispatches += 1
      return originalRpcList(...args)
    }
    try {
      await service.listAccessibleGfsResources()
    } catch {}
    try {
      await service.listAccessibleMcpServers(['synthetic-host'])
    } catch {}
    const coldAuthority = await authoritySummary(tokenStore, envKey)
    const coldWasSignedOut = !coldState.authenticated && coldState.me === null
    const coldDispatches = protectedHttpDispatches + protectedRpcDispatches

    await service.passwordLogin('owner-b@example.test', 'synthetic-password-B')
    let deniedCandidateRejected = false
    try {
      await service.passwordLogin('owner-a@example.test', 'synthetic-password-A')
    } catch (error) {
      deniedCandidateRejected = error?.name === 'SessionAuthorityRecordConflictError'
    }
    const finalState = await service.getSessionState()
    const authority = await authoritySummary(tokenStore, envKey)
    const quarantineFiles = fs
      .readdirSync(userData)
      .filter(name => name.startsWith('session-persistence-journal-corrupt-'))
      .map(name => {
        const contents = fs.readFileSync(path.join(userData, name))
        return {
          digest: crypto.createHash('sha256').update(contents).digest('hex'),
          byteLength: contents.length,
        }
      })
    safeReport({
      ok:
        coldWasSignedOut &&
        coldDispatches === 0 &&
        startupGetMeOwners.length === 0 &&
        !getMeOwners.includes('A') &&
        deniedCandidateRejected &&
        finalState.me?.id === 'crash-owner-B',
      coldWasSignedOut,
      startupGetMeOwners,
      protectedHttpDispatches,
      protectedRpcDispatches,
      coldJournalStatus: coldAuthority.journal.status,
      deniedCandidateRejected,
      authenticated: finalState.authenticated,
      owner: finalState.me?.id ?? null,
      getMeOwners,
      activeEnvKey: envKey,
      profileSelection: await profileSelectionSummary(tokenStore),
      authority,
      quarantineFiles,
    })
    process.exit(0)
  }

  if (role === 'memory-seed') {
    const state = await service.passwordLogin('crash@example.test', 'synthetic-password-M')
    const authority = await authoritySummary(tokenStore, envKey)
    safeReport({
      ok: true,
      authenticated: state.authenticated,
      sessionMode: state.sessionMode,
      owner: state.me?.id,
      bearerPersisted: backingStoreContainsToken(tokenFor('M')),
      authority,
    })
    process.exit(0)
  }

  if (role === 'memory-recover') {
    const state = await service.initialize()
    const authority = await authoritySummary(tokenStore, envKey)
    safeReport({
      ok: true,
      authenticated: state.authenticated,
      owner: state.me?.id ?? null,
      getMeOwners,
      bearerPersisted: backingStoreContainsToken(tokenFor('M')),
      authority,
    })
    process.exit(0)
  }

  if (role === 'seed' || role === 'candidate') {
    if (role === 'candidate' && environmentSwitch)
      environmentSwitchInfo = await selectSecondEnvironmentForCandidate(service)
    envKey = getActiveEnvKey()
    let stagedCandidateSource = null
    if (role === 'candidate') {
      const { SessionAuthorityRecordRepository } = require('../dist/sessionAuthorityRecord.js')
      const prepareAcceptanceProjection =
        SessionAuthorityRecordRepository.prototype.prepareAcceptanceProjection
      SessionAuthorityRecordRepository.prototype.prepareAcceptanceProjection = function (...args) {
        const result = prepareAcceptanceProjection.apply(this, args)
        const candidate = result.result?.record?.candidates.find(
          item => item.accountId === 'crash-owner-B'
        )
        if (candidate?.publishedSource) {
          stagedCandidateSource = {
            accountId: candidate.accountId,
            sourceRef: candidate.publishedSource.sourceRef,
            sourceRevision: candidate.publishedSource.sourceRevision,
          }
        }
        if (phase === 'after-intent' && result.result?.status === 'committed') {
          safeReport({
            ok: true,
            crashReached: phase,
            candidateSource: stagedCandidateSource,
            ...(environmentSwitchInfo ? { ...environmentSwitchInfo } : {}),
          })
          process.exit(86)
        }
        return result
      }

      if (phase === 'after-intent') {
        // The projection-intent wrapper above terminates after its durable repository commit.
      } else if (phase === 'after-marker') {
        const { TokenStore } = require('../dist/tokenStore.js')
        const original = TokenStore.prototype.stageSessionAuthorityMarker
        TokenStore.prototype.stageSessionAuthorityMarker = function (...args) {
          const result = original.apply(this, args)
          if (result) {
            safeReport({
              ok: true,
              crashReached: phase,
              candidateSource: stagedCandidateSource,
              ...(environmentSwitchInfo ? { ...environmentSwitchInfo } : {}),
            })
            process.exit(87)
          }
          return result
        }
      } else if (phase === 'after-profile-selection') {
        const compareAndSetProfileSelection =
          SessionAuthorityRecordRepository.prototype.compareAndSetProfileSelection
        SessionAuthorityRecordRepository.prototype.compareAndSetProfileSelection = function (
          ...args
        ) {
          const result = compareAndSetProfileSelection.apply(this, args)
          if (
            result.status === 'committed' &&
            result.record.profileSelection?.userId === 'crash-owner-B'
          ) {
            safeReport({
              ok: true,
              crashReached: phase,
              candidateSource: stagedCandidateSource,
              ...(environmentSwitchInfo ? { ...environmentSwitchInfo } : {}),
            })
            process.exit(89)
          }
          return result
        }
      } else if (phase === 'after-acceptance') {
        const original = SessionAuthorityRecordRepository.prototype.acceptCandidate
        SessionAuthorityRecordRepository.prototype.acceptCandidate = function (...args) {
          const result = original.apply(this, args)
          if (result.status === 'committed') {
            safeReport({
              ok: true,
              crashReached: phase,
              candidateSource: stagedCandidateSource,
              ...(environmentSwitchInfo ? { ...environmentSwitchInfo } : {}),
            })
            process.exit(88)
          }
          return result
        }
      }
    }
    const password = role === 'seed' ? 'synthetic-password-A' : 'synthetic-password-B'
    const state = await service.passwordLogin('crash@example.test', password)
    const activeEnvKey = getActiveEnvKey()
    const authority = await authoritySummary(tokenStore, activeEnvKey)
    safeReport({
      ok: true,
      authenticated: state.authenticated,
      owner: state.me?.id,
      activeEnvKey,
      profileSelection: await profileSelectionSummary(tokenStore),
      authority,
      ...(environmentSwitchInfo ? { ...environmentSwitchInfo } : {}),
    })
    process.exit(0)
  }

  const state = await service.initialize()
  const activeEnvKey = getActiveEnvKey()
  envKey = activeEnvKey
  const profileSelection = await profileSelectionSummary(tokenStore)
  let priorEnvironmentRestoreStatus = null
  if (environmentSwitch) {
    const { readSessionAuthoritySourceSelection } = require('../dist/sessionAuthorityAcceptance.js')
    const crashReport = JSON.parse(
      fs.readFileSync(path.join(profileRoot, `candidate-${phase}.json`), 'utf8')
    )
    priorEnvironmentRestoreStatus = await readSessionAuthoritySourceSelection({
      tokenStore,
      envKey: crashReport.priorEnvKey,
    }).then(selection => ({ status: selection.status, frameMode: selection.frameMode ?? null }))
  }
  const authority = await authoritySummary(tokenStore, activeEnvKey)
  const crashReport = JSON.parse(
    fs.readFileSync(path.join(profileRoot, `candidate-${phase}.json`), 'utf8')
  )
  const keytarStore = JSON.parse(fs.readFileSync(keytarFile, 'utf8'))
  const candidateSourceRef = crashReport.candidateSource?.sourceRef
  const candidateSourcePresent = Boolean(
    candidateSourceRef && keytarStore[`Evenfire::session-v1:${candidateSourceRef}`]
  )
  safeReport({
    ok: true,
    authenticated: state.authenticated,
    owner: state.me?.id ?? null,
    getMeOwners,
    activeEnvKey,
    profileSelection,
    priorEnvironmentRestoreStatus,
    candidateSourceRef: candidateSourceRef ?? null,
    candidateSourcePresent,
    authority,
  })
  process.exit(0)
}

main().catch(safeFailure)
