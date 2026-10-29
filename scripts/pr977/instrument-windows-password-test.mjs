import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, writeFileSync } from 'node:fs'

const [testPath] = process.argv.slice(2)
if (!testPath || !testPath.endsWith('appService.passwordLoginRollback.regression.test.ts')) {
  throw new Error('Only the allowlisted password rollback test may be instrumented')
}
const sourceTestStat = lstatSync(testPath)
if (!sourceTestStat.isFile() || sourceTestStat.isSymbolicLink()) {
  throw new Error('The password rollback test overlay requires a regular source file')
}

const originalSource = readFileSync(testPath, 'utf8')
const sourceLineEnding = originalSource.includes('\r\n') ? '\r\n' : '\n'
let source = originalSource.replaceAll('\r\n', '\n')
const sourceSha256 = createHash('sha256').update(originalSource).digest('hex')
const markers = [
  'beforeEach-start',
  'module-reset-complete',
  'temp-directory-ready',
  'app-service-import-start',
  'app-service-import-complete',
  'beforeEach-complete',
  'afterEach-start',
  'afterEach-unstub-complete',
  'afterEach-mocks-complete',
  'afterEach-directory-remove-start',
  'afterEach-directory-remove-complete',
  'afterEach-env-restore-complete',
  'afterEach-fixture-clear-complete',
  'afterEach-modules-reset-complete',
  'afterEach-complete',
  'test-1-start',
  'test-2-start',
  'test-3-start',
  'test-4-start',
  'test-5-start',
  'test-2-complete',
  'test-3-complete',
  'test-4-complete',
  'test-5-complete',
  'password-a-start',
  'password-a-complete',
  'authority-before-start',
  'authority-before-complete',
  'password-b-start',
  'password-b-complete',
  'authority-after-start',
  'authority-after-complete',
  'restart-initialize-start',
  'restart-initialize-complete',
  'test-1-complete',
]

function replaceOnce(before, after) {
  const first = source.indexOf(before)
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error('Expected one stable instrumentation anchor')
  }
  source = `${source.slice(0, first)}${after}${source.slice(first + before.length)}`
}
function replaceFirst(before, after) {
  const first = source.indexOf(before)
  if (first < 0) throw new Error('Expected a stable instrumentation anchor')
  source = `${source.slice(0, first)}${after}${source.slice(first + before.length)}`
}

replaceOnce(
  "import path from 'node:path'\n",
  "import path from 'node:path'\n\n" +
    'const pr977Mark = (phase: string) => {\n' +
    '  const markerPath = process.env.PR977_PHASE_FILE\n' +
    '  if (!markerPath) return\n' +
    '  try { fsSync.appendFileSync(markerPath, `${phase}\\n`) } catch { /* diagnostic only */ }\n' +
    '}\n'
)
replaceOnce(
  '  beforeEach(async () => {\n',
  "  beforeEach(async () => {\n    pr977Mark('beforeEach-start')\n"
)
replaceFirst(
  '    vi.resetModules()\n',
  "    vi.resetModules()\n    pr977Mark('module-reset-complete')\n"
)
replaceOnce(
  "    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-password-rollback-'))\n",
  "    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-password-rollback-'))\n" +
    "    pr977Mark('temp-directory-ready')\n"
)
replaceOnce(
  '    const [{ AppService: appServiceClass }, { TokenStore: tokenStoreClass }] = await Promise.all([\n',
  "    pr977Mark('app-service-import-start')\n" +
    '    const [{ AppService: appServiceClass }, { TokenStore: tokenStoreClass }] = await Promise.all([\n'
)
replaceOnce(
  '    TokenStore = tokenStoreClass\n  })\n\n  afterEach',
  "    TokenStore = tokenStoreClass\n    pr977Mark('app-service-import-complete')\n" +
    "    pr977Mark('beforeEach-complete')\n  })\n\n  afterEach"
)
replaceOnce(
  '  afterEach(async () => {\n    vi.unstubAllGlobals()\n    vi.restoreAllMocks()\n' +
    '    if (directory) await fs.rm(directory, { recursive: true, force: true })\n',
  "  afterEach(async () => {\n    pr977Mark('afterEach-start')\n" +
    "    vi.unstubAllGlobals()\n    pr977Mark('afterEach-unstub-complete')\n" +
    "    vi.restoreAllMocks()\n    pr977Mark('afterEach-mocks-complete')\n" +
    "    pr977Mark('afterEach-directory-remove-start')\n" +
    '    if (directory) await fs.rm(directory, { recursive: true, force: true })\n' +
    "    pr977Mark('afterEach-directory-remove-complete')\n"
)
replaceOnce(
  "    fixture.directory = ''\n    fixture.keychain.clear()\n    vi.resetModules()\n  })\n\n  function createService",
  "    fixture.directory = ''\n    fixture.keychain.clear()\n" +
    "    pr977Mark('afterEach-env-restore-complete')\n" +
    "    pr977Mark('afterEach-fixture-clear-complete')\n" +
    '    vi.resetModules()\n' +
    "    pr977Mark('afterEach-modules-reset-complete')\n" +
    "  })\n\n  function createService"
)
replaceOnce(
  "  it('restores the accepted prior source when candidate preparation fails after publication', async () => {\n",
  "  it('restores the accepted prior source when candidate preparation fails after publication', async () => {\n" +
    "    pr977Mark('test-1-start')\n"
)
for (const [testNumber, title] of [
  [2, 'never persists a rejected password replacement over a prior memory-only bearer'],
  [3, 'does not restore prior A while another producer still denies A in the journal'],
  [4, 'does not restore GFS or Home after logout-pending wins a delayed login authority read'],
  [5, 'revalidates LP synchronously after prior-owner rollback preflight'],
]) {
  replaceOnce(
    `  it('${title}', async () => {\n`,
    `  it('${title}', async () => {\n    pr977Mark('test-${testNumber}-start')\n`
  )
}
replaceOnce(
  "    expect(restarted.getCachedUserId()).toBeNull()\n  })\n\n  it('does not restore prior A",
  '    expect(restarted.getCachedUserId()).toBeNull()\n' +
    "    pr977Mark('test-2-complete')\n  })\n\n  it('does not restore prior A"
)
replaceOnce(
  "    expect(fixture.getMeTokens.slice(beforeRestart)).not.toContain(tokenB)\n  })\n\n  it('does not restore GFS",
  '    expect(fixture.getMeTokens.slice(beforeRestart)).not.toContain(tokenB)\n' +
    "    pr977Mark('test-3-complete')\n  })\n\n  it('does not restore GFS"
)
replaceOnce(
  "      if (quitPreparation) await quitPreparation\n    }\n  })\n\n  it('revalidates LP",
  '      if (quitPreparation) await quitPreparation\n    }\n' +
    "    pr977Mark('test-4-complete')\n  })\n\n  it('revalidates LP"
)
replaceOnce(
  '    expect(fixture.getMeTokens.slice(requestsBeforeRestart)).not.toContain(tokenB)\n  })\n})',
  '    expect(fixture.getMeTokens.slice(requestsBeforeRestart)).not.toContain(tokenB)\n' +
    "    pr977Mark('test-5-complete')\n  })\n})"
)
replaceFirst(
  "    await expect(service.passwordLogin(userA.email, 'synthetic-password-a')).resolves.toMatchObject(\n",
  "    pr977Mark('password-a-start')\n" +
    "    await expect(service.passwordLogin(userA.email, 'synthetic-password-a')).resolves.toMatchObject(\n"
)
replaceOnce(
  '    const [{ getActiveEnvKey }, { readSessionAuthoritySourceSelection }] = await Promise.all([\n',
  "    pr977Mark('password-a-complete')\n" +
    '    const [{ getActiveEnvKey }, { readSessionAuthoritySourceSelection }] = await Promise.all([\n'
)
replaceOnce(
  '    const acceptedBeforeReplacement = await readSessionAuthoritySourceSelection({\n',
  "    pr977Mark('authority-before-start')\n" +
    '    const acceptedBeforeReplacement = await readSessionAuthoritySourceSelection({\n'
)
replaceOnce(
  "    expect(acceptedBeforeReplacement.status).toBe('accepted')\n",
  "    pr977Mark('authority-before-complete')\n" +
    "    expect(acceptedBeforeReplacement.status).toBe('accepted')\n"
)
replaceFirst(
  "    await expect(service.passwordLogin(userB.email, 'synthetic-password-b')).rejects.toThrow(\n",
  "    pr977Mark('password-b-start')\n" +
    "    await expect(service.passwordLogin(userB.email, 'synthetic-password-b')).rejects.toThrow(\n"
)
replaceOnce(
  "      'synthetic candidate chat preparation failure'\n    )\n\n    expect(service.getCachedUserId()).toBe(userA.id)",
  "      'synthetic candidate chat preparation failure'\n    )\n" +
    "    pr977Mark('password-b-complete')\n\n    expect(service.getCachedUserId()).toBe(userA.id)"
)
replaceOnce(
  '    const acceptedAfterRejection = await readSessionAuthoritySourceSelection({\n',
  "    pr977Mark('authority-after-start')\n" +
    '    const acceptedAfterRejection = await readSessionAuthoritySourceSelection({\n'
)
replaceOnce(
  "    expect(acceptedAfterRejection.status).toBe('accepted')\n",
  "    pr977Mark('authority-after-complete')\n" +
    "    expect(acceptedAfterRejection.status).toBe('accepted')\n"
)
replaceFirst(
  '    await expect(restarted.initialize()).resolves.toMatchObject({\n',
  "    pr977Mark('restart-initialize-start')\n" +
    '    await expect(restarted.initialize()).resolves.toMatchObject({\n'
)
replaceFirst(
  '    expect(fixture.getMeTokens.slice(requestsBeforeRestart)).toEqual([tokenA])\n',
  "    pr977Mark('restart-initialize-complete')\n" +
    '    expect(fixture.getMeTokens.slice(requestsBeforeRestart)).toEqual([tokenA])\n'
)
replaceFirst(
  "    expect(restarted.getCachedUserId()).toBe(userA.id)\n  })\n\n  it('never persists",
  '    expect(restarted.getCachedUserId()).toBe(userA.id)\n' +
    "    pr977Mark('test-1-complete')\n  })\n\n  it('never persists"
)

const overlaySource = sourceLineEnding === '\r\n' ? source.replaceAll('\n', '\r\n') : source
writeFileSync(testPath, overlaySource)
process.stdout.write(
  `${JSON.stringify({
    mode: 'diagnostic-markers-only',
    sourceSha256,
    overlayTestSha256: createHash('sha256').update(overlaySource).digest('hex'),
    markerCount: markers.length,
  })}\n`
)
