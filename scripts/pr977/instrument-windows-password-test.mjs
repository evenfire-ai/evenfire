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
  'fetch-request-start',
  'password-login-http-start',
  'password-login-http-response',
  'me-http-start',
  'me-http-response',
  'credential-write-start',
  'credential-write-complete',
  'pending-logout-start',
  'pending-logout-settled',
  'accepted-login-start',
  'accepted-login-settled',
  'acceptance-transaction-start',
  'acceptance-transaction-settled',
  'login-persistence-start',
  'login-persistence-settled',
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
  'transaction-reconcile-start',
  'transaction-reconcile-end',
  'transaction-plan-start',
  'transaction-plan-end',
  'transaction-begin-start',
  'transaction-begin-end',
  'transaction-prior-source-start',
  'transaction-prior-source-end',
  'transaction-publish-verify-start',
  'transaction-publish-verify-end',
  'transaction-execute-start',
  'transaction-execute-end',
  'acl-powershell-start',
  'acl-powershell-fast',
  'acl-powershell-slow',
  'acl-powershell-timeout',
  'fileops-powershell-start',
  'fileops-powershell-fast',
  'fileops-powershell-slow',
  'fileops-powershell-timeout',
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
    "import childProcess from 'node:child_process'\n" +
    "import { syncBuiltinESMExports } from 'node:module'\n" +
    'const pr977Mark = (phase: string) => {\n' +
    '  const markerPath = process.env.PR977_PHASE_FILE\n' +
    '  if (!markerPath) return\n' +
    '  try { fsSync.appendFileSync(markerPath, `${phase}\\n`) } catch { /* diagnostic only */ }\n' +
    '}\n'
)
replaceOnce(
  '  try { fsSync.appendFileSync(markerPath, `${phase}\\n`) } catch { /* diagnostic only */ }\n' +
    '}\n',
  '  try { fsSync.appendFileSync(markerPath, `${phase}\\n`) } catch { /* diagnostic only */ }\n' +
    '}\n' +
    'const pr977Marked = new Set<string>()\n' +
    'const pr977MarkOnce = (phase: string) => {\n' +
    '  if (pr977Marked.has(phase)) return\n' +
    '  pr977Marked.add(phase)\n' +
    '  pr977Mark(phase)\n' +
    '}\n' +
    'const pr977OriginalSpawnSync = childProcess.spawnSync\n' +
    'childProcess.spawnSync = ((command: string, ...args: unknown[]) => {\n' +
    '  if (!/powershell\\.exe$/i.test(String(command))) return pr977OriginalSpawnSync(command, ...args as never[])\n' +
    '  const spawnOptions = args[1] as { env?: Record<string, string> } | undefined\n' +
    '  const env = spawnOptions?.env ?? {}\n' +
    "  const operation = Object.hasOwn(env, 'EVENFIRE_SESSION_AUTHORITY_ACL_REQUEST') ? 'acl' : Object.hasOwn(env, 'EVENFIRE_SESSION_AUTHORITY_FILE_OPS') ? 'fileops' : null\n" +
    '  if (!operation) return pr977OriginalSpawnSync(command, ...args as never[])\n' +
    '  pr977Mark(`${operation}-powershell-start`)\n' +
    '  const started = Date.now()\n' +
    '  const result = pr977OriginalSpawnSync(command, ...args as never[])\n' +
    "  const outcome = (result as { error?: { code?: string } }).error?.code === 'ETIMEDOUT' ? 'timeout' : Date.now() - started >= 10000 ? 'slow' : 'fast'\n" +
    '  pr977Mark(`${operation}-powershell-${outcome}`)\n' +
    '  return result\n' +
    '}) as typeof childProcess.spawnSync\n' +
    'syncBuiltinESMExports()\n'
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
  '    fixture.setPassword.mockImplementation(\n' +
    '      async (service: string, account: string, token: string) => {\n' +
    '        fixture.keychain.set(keyOf(service, account), token)\n',
  '    fixture.setPassword.mockImplementation(\n' +
    '      async (service: string, account: string, token: string) => {\n' +
    "        pr977Mark('credential-write-start')\n" +
    '        fixture.keychain.set(keyOf(service, account), token)\n' +
    "        pr977Mark('credential-write-complete')\n"
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
    '  })\n\n  function createService'
)
replaceOnce(
  "  it('restores the accepted prior source when candidate preparation fails after publication', async () => {\n",
  "  it('restores the accepted prior source when candidate preparation fails after publication', async () => {\n" +
    "    pr977Mark('test-1-start')\n"
)
replaceFirst(
  '    const service = createService()\n',
  '    const service = createService()\n' +
    "    const transactionModule = await import('../sessionAuthorityAcceptance.js')\n" +
    '    const transactionClass = transactionModule.SessionAuthorityAcceptanceTransaction as unknown as Record<string, unknown>\n' +
    '    const instancePrototype = transactionModule.SessionAuthorityAcceptanceTransaction.prototype as unknown as Record<string, unknown>\n' +
    '    const wrapDiagnostic = (target: Record<string, unknown>, method: string, start: string, end: string) => {\n' +
    '      const original = target[method] as (...args: unknown[]) => unknown\n' +
    '      target[method] = async function (...args: unknown[]) {\n' +
    '        pr977MarkOnce(start)\n' +
    '        try { return await original.apply(this, args) } finally { pr977MarkOnce(end) }\n' +
    '      }\n' +
    '    }\n' +
    "    wrapDiagnostic(transactionClass, 'reconcilePendingAcceptanceProjection', 'transaction-reconcile-start', 'transaction-reconcile-end')\n" +
    "    wrapDiagnostic(transactionClass, 'begin', 'transaction-begin-start', 'transaction-begin-end')\n" +
    "    wrapDiagnostic(instancePrototype, 'preparePriorSource', 'transaction-prior-source-start', 'transaction-prior-source-end')\n" +
    "    wrapDiagnostic(instancePrototype, 'publishAndVerify', 'transaction-publish-verify-start', 'transaction-publish-verify-end')\n" +
    "    wrapDiagnostic(instancePrototype, 'execute', 'transaction-execute-start', 'transaction-execute-end')\n" +
    '    const coordinator = (service as unknown as { sessionAuthority: Record<string, unknown> }).sessionAuthority\n' +
    "    wrapDiagnostic(coordinator, 'planFreshSessionAcceptance', 'transaction-plan-start', 'transaction-plan-end')\n" +
    '    const diagnosticReceiver = service as unknown as Record<\n' +
    '      string,\n' +
    '      (...args: unknown[]) => Promise<unknown>\n' +
    '    >\n' +
    '    for (const [method, start, settled] of [\n' +
    "      ['applyPendingExternalLogoutBeforeLogin', 'pending-logout-start', 'pending-logout-settled'],\n" +
    "      ['installAuthenticatedLogin', 'accepted-login-start', 'accepted-login-settled'],\n" +
    "      ['installAuthenticatedLoginWithAcceptanceTransaction', 'acceptance-transaction-start', 'acceptance-transaction-settled'],\n" +
    "      ['installAuthenticatedLoginWithinPersistence', 'login-persistence-start', 'login-persistence-settled'],\n" +
    '    ] as const) {\n' +
    '      const original = diagnosticReceiver[method].bind(service)\n' +
    '      diagnosticReceiver[method] = async (...args: unknown[]) => {\n' +
    '        pr977Mark(start)\n' +
    '        try { return await original(...args) } finally { pr977Mark(settled) }\n' +
    '      }\n' +
    '    }\n'
)
replaceFirst(
  '    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {\n' +
    '      const url = String(input)\n',
  '    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {\n' +
    "      pr977Mark('fetch-request-start')\n" +
    '      const url = String(input)\n'
)
replaceFirst(
  "      if (url.endsWith('/api/v1/auth/v2/password-login')) {\n",
  "      if (url.endsWith('/api/v1/auth/v2/password-login')) {\n" +
    "        pr977Mark('password-login-http-start')\n"
)
replaceFirst(
  "        return new Response(JSON.stringify(result), {\n          status: 200,\n          headers: { 'content-type': 'application/json' },\n        })\n",
  '        const response = new Response(JSON.stringify(result), {\n' +
    "          status: 200,\n          headers: { 'content-type': 'application/json' },\n" +
    "        })\n        pr977Mark('password-login-http-response')\n        return response\n"
)
replaceFirst(
  "      if (url.endsWith('/api/v1/me')) {\n",
  "      if (url.endsWith('/api/v1/me')) {\n        pr977Mark('me-http-start')\n"
)
replaceFirst(
  "        return new Response(JSON.stringify(me), {\n          status: me ? 200 : 401,\n          headers: { 'content-type': 'application/json' },\n        })\n",
  '        const response = new Response(JSON.stringify(me), {\n' +
    "          status: me ? 200 : 401,\n          headers: { 'content-type': 'application/json' },\n" +
    "        })\n        pr977Mark('me-http-response')\n        return response\n"
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
