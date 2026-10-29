import { readFileSync, writeFileSync } from 'node:fs'

const [kind, testPath] = process.argv.slice(2)
if (!['auth', 'acl'].includes(kind) || !testPath) {
  throw new Error('Expected diagnostic kind and test path')
}

const source = readFileSync(testPath, 'utf8').replace(/\r\n/g, '\n')
function replaceOnce(value, before, after, label) {
  const count = value.split(before).length - 1
  if (count < 1) throw new Error(`Missing instrumentation anchor: ${label}`)
  return value.replace(before, () => after)
}

let result = source
if (kind === 'auth') {
  const helper = `\nconst diagnosticPhases = new Set([\n  'hook-before-start', 'hook-before-ready', 'hook-before-end',\n  'hook-after-start', 'hook-after-end', 'test-start',\n  'first-login-start', 'first-login-end', 'accepted-source-read-start',\n  'accepted-source-read-end', 'replacement-login-start', 'replacement-login-end',\n  'restart-start', 'restart-end', 'http-password-start', 'http-password-end', 'http-me-start',\n  'complete-password-start', 'complete-password-end',\n  'credential-producer-start', 'credential-producer-end', 'credential-producer-error',\n  'session-persistence-start', 'session-persistence-end', 'session-persistence-error',\n  'login-install-start', 'login-install-end', 'login-install-error',\n  'login-install-once-start', 'login-install-once-end', 'login-install-once-error',\n  'acceptance-install-start', 'acceptance-install-end', 'acceptance-install-error',\n  'within-persistence-start', 'within-persistence-end', 'within-persistence-error',\n  'legacy-recovery-start', 'legacy-recovery-end', 'legacy-recovery-error',\n  'journal-capture-start', 'journal-capture-end', 'journal-capture-error',\n  'http-me-end', 'keytar-get-start', 'keytar-get-end', 'keytar-set-start',\n  'keytar-set-end', 'keytar-delete-start', 'keytar-delete-end',\n  'chat-prepare-start', 'chat-prepare-rejected', 'chat-bind-start', 'chat-bind-end',\n  'acl-provision-start', 'acl-provision-end', 'acl-provision-error',\n  'acl-verify-start', 'acl-verify-end', 'acl-verify-error',\n  'transaction-begin-start', 'transaction-begin-end', 'transaction-begin-error',\n  'transaction-publish-start', 'transaction-publish-end', 'transaction-publish-error'\n])\nfunction diagnosticPhase(name: string): void {\n  const phaseFile = process.env.PR977_DIAGNOSTIC_PHASE_FILE\n  if (!phaseFile) return\n  if (!diagnosticPhases.has(name)) throw new Error('Diagnostic phase is not allowlisted')\n  fsSync.appendFileSync(phaseFile, name + '\\n', 'utf8')\n}\n`
  result = replaceOnce(
    result,
    "import path from 'node:path'\n",
    "import path from 'node:path'\n" + helper,
    'phase helper'
  )
  result = replaceOnce(
    result,
    "vi.mock('../chatStoreBinding.js', () => ({",
    `vi.mock('../sessionPersistenceJournal.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../sessionPersistenceJournal.js')>()
  return {
    ...actual,
    captureSessionPersistenceJournalRecovery: (...args: Parameters<typeof actual.captureSessionPersistenceJournalRecovery>) => {
      diagnosticPhase('journal-capture-start')
      try { const value = actual.captureSessionPersistenceJournalRecovery(...args); diagnosticPhase('journal-capture-end'); return value }
      catch (error) { diagnosticPhase('journal-capture-error'); throw error }
    },
  }
})

vi.mock('../chatStoreBinding.js', () => ({`,
    'legacy journal capture instrumentation'
  )
  result = replaceOnce(
    result,
    "vi.mock('keytar', () => fixture)",
    `vi.mock('keytar', () => ({\n  ...fixture,\n  getPassword: async (...args: Parameters<typeof fixture.getPassword>) => { diagnosticPhase('keytar-get-start'); try { const value = await fixture.getPassword(...args); diagnosticPhase('keytar-get-end'); return value } catch (error) { throw error } },\n  setPassword: async (...args: Parameters<typeof fixture.setPassword>) => { diagnosticPhase('keytar-set-start'); const value = await fixture.setPassword(...args); diagnosticPhase('keytar-set-end'); return value },\n  deletePassword: async (...args: Parameters<typeof fixture.deletePassword>) => { diagnosticPhase('keytar-delete-start'); const value = await fixture.deletePassword(...args); diagnosticPhase('keytar-delete-end'); return value },\n}))\n\nvi.mock('../windowsSessionAuthorityAcl.js', async importOriginal => {\n  const actual = await importOriginal<typeof import('../windowsSessionAuthorityAcl.js')>()\n  return {\n    ...actual,\n    provisionWindowsSessionAuthorityDirectory: (...args: Parameters<typeof actual.provisionWindowsSessionAuthorityDirectory>) => {\n      diagnosticPhase('acl-provision-start')\n      try { const value = actual.provisionWindowsSessionAuthorityDirectory(...args); diagnosticPhase('acl-provision-end'); return value }\n      catch (error) { diagnosticPhase('acl-provision-error'); throw error }\n    },\n    verifyWindowsSessionAuthorityDirectory: (...args: Parameters<typeof actual.verifyWindowsSessionAuthorityDirectory>) => {\n      diagnosticPhase('acl-verify-start')\n      try { const value = actual.verifyWindowsSessionAuthorityDirectory(...args); diagnosticPhase('acl-verify-end'); return value }\n      catch (error) { diagnosticPhase('acl-verify-error'); throw error }\n    },\n  }\n})`,
    'keytar and ACL instrumentation'
  )
  result = replaceOnce(
    result,
    "vi.mock('../chatStoreBinding.js', () => ({\n  bindChatStoreForUser: vi.fn(async (userId: string) => {\n    fixture.activeChatUserId = userId\n  }),\n  prepareChatStoreBindingForUser: vi.fn(async (userId: string) => {\n    fixture.chatBindCount += 1\n    if (userId === userB.id && fixture.candidateBindingError) throw fixture.candidateBindingError",
    "vi.mock('../chatStoreBinding.js', () => ({\n  bindChatStoreForUser: vi.fn(async (userId: string) => {\n    diagnosticPhase('chat-bind-start')\n    fixture.activeChatUserId = userId\n    diagnosticPhase('chat-bind-end')\n  }),\n  prepareChatStoreBindingForUser: vi.fn(async (userId: string) => {\n    diagnosticPhase('chat-prepare-start')\n    fixture.chatBindCount += 1\n    if (userId === userB.id && fixture.candidateBindingError) { diagnosticPhase('chat-prepare-rejected'); throw fixture.candidateBindingError }\n    diagnosticPhase('chat-prepare-ready')",
    'chat producer instrumentation'
  )
  result = replaceOnce(
    result,
    'beforeEach(async () => {\n    vi.resetModules()',
    "beforeEach(async () => {\n    diagnosticPhase('hook-before-start')\n    vi.resetModules()",
    'beforeEach start'
  )
  result = replaceOnce(
    result,
    'const [{ AppService: appServiceClass }, { TokenStore: tokenStoreClass }]',
    'const [{ AppService: appServiceClass }, { TokenStore: tokenStoreClass }, acceptance]',
    'acceptance import binding'
  )
  result = replaceOnce(
    result,
    "      import('../tokenStore.js'),",
    "      import('../tokenStore.js'),\n      import('../sessionAuthorityAcceptance.js'),",
    'acceptance import'
  )
  result = replaceOnce(
    result,
    '    TokenStore = tokenStoreClass\n  })',
    "    TokenStore = tokenStoreClass\n    const transactionType = acceptance.SessionAuthorityAcceptanceTransaction as any\n    const originalRecovery = transactionType.recoverCorruptLegacyJournalAfterFreshAuthentication.bind(transactionType)\n    transactionType.recoverCorruptLegacyJournalAfterFreshAuthentication = async (...args: unknown[]) => {\n      diagnosticPhase('legacy-recovery-start')\n      try { const value = await originalRecovery(...args); diagnosticPhase('legacy-recovery-end'); return value }\n      catch (error) { diagnosticPhase('legacy-recovery-error'); throw error }\n    }\n    const originalBegin = transactionType.begin.bind(transactionType)\n    transactionType.begin = async (...args: unknown[]) => {\n      diagnosticPhase('transaction-begin-start')\n      try { const transaction = await originalBegin(...args); diagnosticPhase('transaction-begin-end'); return transaction }\n      catch (error) { diagnosticPhase('transaction-begin-error'); throw error }\n    }\n    const prototype = transactionType.prototype as any\n    const originalPublish = prototype.publishAndVerify\n    prototype.publishAndVerify = async function (...args: unknown[]) {\n      diagnosticPhase('transaction-publish-start')\n      try { const value = await originalPublish.apply(this, args); diagnosticPhase('transaction-publish-end'); return value }\n      catch (error) { diagnosticPhase('transaction-publish-error'); throw error }\n    }\n    diagnosticPhase('hook-before-end')\n  })",
    'transaction phase instrumentation'
  )
  result = replaceOnce(
    result,
    '  afterEach(async () => {\n    vi.unstubAllGlobals()',
    "  afterEach(async () => {\n    diagnosticPhase('hook-after-start')\n    vi.unstubAllGlobals()",
    'afterEach start'
  )
  result = replaceOnce(
    result,
    '    vi.resetModules()\n  })\n\n  function createService',
    "    vi.resetModules()\n    diagnosticPhase('hook-after-end')\n  })\n\n  function createService",
    'afterEach end'
  )
  result = replaceOnce(
    result,
    "  it('restores the accepted prior source when candidate preparation fails after publication', async () => {\n    const fetchMock",
    "  it('restores the accepted prior source when candidate preparation fails after publication', async () => {\n    diagnosticPhase('test-start')\n    const fetchMock",
    'selected test start'
  )
  result = replaceOnce(
    result,
    "      if (url.endsWith('/api/v1/auth/v2/password-login')) {\n        fixture.loginCount += 1",
    "      if (url.endsWith('/api/v1/auth/v2/password-login')) {\n        diagnosticPhase('http-password-start')\n        fixture.loginCount += 1",
    'password request marker'
  )
  result = replaceOnce(
    result,
    "        return new Response(JSON.stringify(result), {\n          status: 200,\n          headers: { 'content-type': 'application/json' },\n        })",
    "        diagnosticPhase('http-password-end')\n        return new Response(JSON.stringify(result), {\n          status: 200,\n          headers: { 'content-type': 'application/json' },\n        })",
    'password response marker'
  )
  result = replaceOnce(
    result,
    "      if (url.endsWith('/api/v1/me')) {\n        const token",
    "      if (url.endsWith('/api/v1/me')) {\n        diagnosticPhase('http-me-start')\n        const token",
    'me request marker'
  )
  result = replaceOnce(
    result,
    "        return new Response(JSON.stringify(me), {\n          status: me ? 200 : 401,\n          headers: { 'content-type': 'application/json' },\n        })",
    "        const response = new Response(JSON.stringify(me), {\n          status: me ? 200 : 401,\n          headers: { 'content-type': 'application/json' },\n        })\n        diagnosticPhase('http-me-end')\n        return response",
    'me request end marker'
  )
  result = replaceOnce(
    result,
    "    const service = createService()\n    await expect(service.passwordLogin(userA.email, 'synthetic-password-a'))",
    "    const service = createService()\n    const methodPhases = [\n      ['completePasswordLogin', 'complete-password'],\n      ['runCredentialProducer', 'credential-producer'],\n      ['runSessionPersistence', 'session-persistence'],\n      ['installAuthenticatedLogin', 'login-install'],\n      ['installAuthenticatedLoginOnce', 'login-install-once'],\n      ['installAuthenticatedLoginWithAcceptanceTransaction', 'acceptance-install'],\n      ['installAuthenticatedLoginWithinPersistence', 'within-persistence'],\n    ] as const\n    for (const [method, phase] of methodPhases) {\n      const target = service as any\n      const original = target[method]\n      if (typeof original !== 'function') throw new Error('Required diagnostic method is unavailable')\n      target[method] = async function (...args: unknown[]) {\n        diagnosticPhase(`${phase}-start`)\n        try { const value = await original.apply(this, args); diagnosticPhase(`${phase}-end`); return value }\n        catch (error) { diagnosticPhase(`${phase}-error`); throw error }\n      }\n    }\n    diagnosticPhase('first-login-start')\n    await expect(service.passwordLogin(userA.email, 'synthetic-password-a'))",
    'first login start'
  )
  result = replaceOnce(
    result,
    '        me: userA,\n      }\n    )\n    const [{ getActiveEnvKey }',
    "        me: userA,\n      }\n    )\n    diagnosticPhase('first-login-end')\n    diagnosticPhase('accepted-source-read-start')\n    const [{ getActiveEnvKey }",
    'first login end'
  )
  result = replaceOnce(
    result,
    "    expect(acceptedBeforeReplacement.session.accepted.record.frame.source).toMatchObject({\n      format: 'v1',\n      kind: 'keytar',\n      accountId: userA.id,\n    })\n\n    await expect(service.passwordLogin(userB.email",
    "    expect(acceptedBeforeReplacement.session.accepted.record.frame.source).toMatchObject({\n      format: 'v1',\n      kind: 'keytar',\n      accountId: userA.id,\n    })\n    diagnosticPhase('accepted-source-read-end')\n\n    diagnosticPhase('replacement-login-start')\n    await expect(service.passwordLogin(userB.email",
    'accepted read and replacement start'
  )
  result = replaceOnce(
    result,
    "      'synthetic candidate chat preparation failure'\n    )\n\n    expect(service.getCachedUserId())",
    "      'synthetic candidate chat preparation failure'\n    )\n    diagnosticPhase('replacement-login-end')\n\n    expect(service.getCachedUserId())",
    'replacement end'
  )
  result = replaceOnce(
    result,
    '    const restarted = createService()\n    const requestsBeforeRestart',
    "    diagnosticPhase('restart-start')\n    const restarted = createService()\n    const requestsBeforeRestart",
    'restart start'
  )
  result = replaceOnce(
    result,
    '    expect(restarted.getCachedUserId()).toBe(userA.id)\n  })',
    "    expect(restarted.getCachedUserId()).toBe(userA.id)\n    diagnosticPhase('restart-end')\n  })",
    'restart end'
  )
}

if (kind === 'acl') {
  result = replaceOnce(
    result,
    "      innerHresult?: string\n    } = {}\n    for (const field of ['errorType', 'innerErrorType'] as const) {",
    "      innerHresult?: string\n      fixturePhase?: string\n      fixturePrivileges?: { restore: string; takeOwnership: string }\n    } = {}\n    for (const field of ['errorType', 'innerErrorType'] as const) {",
    'ACL diagnostic type'
  )
  result = replaceOnce(
    result,
    "    for (const field of ['hresult', 'innerHresult'] as const) {\n      const value = fields[field]\n      if (typeof value === 'string' && /^0x[0-9A-F]{8}$/i.test(value)) output[field] = value\n    }\n    return output",
    "    for (const field of ['hresult', 'innerHresult'] as const) {\n      const value = fields[field]\n      if (typeof value === 'string' && /^0x[0-9A-F]{8}$/i.test(value)) output[field] = value\n    }\n    const phaseMatch = stderr.match(/EVENFIRE_OWNER_FIXTURE_PHASE=(read-existing-acl|set-owner|enable-restore-privilege|write-acl|read-back-owner|owner-readback-mismatch)/)\n    if (phaseMatch) output.fixturePhase = phaseMatch[1]\n    const privilegeMatch = stderr.match(/EVENFIRE_OWNER_FIXTURE_PRIVILEGES=restore:(enabled|disabled|not-listed);takeOwnership:(enabled|disabled|not-listed)/)\n    if (privilegeMatch) output.fixturePrivileges = { restore: privilegeMatch[1]!, takeOwnership: privilegeMatch[2]! }\n    return output",
    'ACL phase extraction'
  )
  const aclFixtureMarkers = [
    [
      '$acl = [IO.Directory]::GetAccessControl($target)',
      "$phase = 'read-existing-acl'; [Console]::Error.WriteLine('EVENFIRE_OWNER_FIXTURE_PHASE=' + $phase)\n$acl = [IO.Directory]::GetAccessControl($target)",
      'existing ACL read',
    ],
    [
      '$acl.SetOwner([System.Security.Principal.SecurityIdentifier]::new($ownerSid))',
      "$phase = 'set-owner'; [Console]::Error.WriteLine('EVENFIRE_OWNER_FIXTURE_PHASE=' + $phase)\n$acl.SetOwner([System.Security.Principal.SecurityIdentifier]::new($ownerSid))",
      'owner assignment',
    ],
    [
      'Add-Type -TypeDefinition $privilegeHelper -ErrorAction Stop',
      "$phase = 'enable-restore-privilege'; [Console]::Error.WriteLine('EVENFIRE_OWNER_FIXTURE_PHASE=' + $phase)\nAdd-Type -TypeDefinition $privilegeHelper -ErrorAction Stop",
      'restore privilege helper compilation',
    ],
    [
      '  [IO.Directory]::SetAccessControl($target, $acl)\n})',
      "  $phase = 'write-acl'; [Console]::Error.WriteLine('EVENFIRE_OWNER_FIXTURE_PHASE=' + $phase)\n  [IO.Directory]::SetAccessControl($target, $acl)\n})",
      'owner ACL write',
    ],
    [
      '$readBack = [IO.Directory]::GetAccessControl($target)',
      "$phase = 'read-back-owner'; [Console]::Error.WriteLine('EVENFIRE_OWNER_FIXTURE_PHASE=' + $phase)\n$readBack = [IO.Directory]::GetAccessControl($target)",
      'owner readback',
    ],
    [
      "if ($actual -ne $ownerSid) { throw 'fixture-owner-readback-mismatch' }",
      "$phase = 'owner-readback-mismatch'; [Console]::Error.WriteLine('EVENFIRE_OWNER_FIXTURE_PHASE=' + $phase)\nif ($actual -ne $ownerSid) { throw 'fixture-owner-readback-mismatch' }",
      'owner equality assertion',
    ],
  ]
  for (const [before, after, label] of aclFixtureMarkers) {
    result = replaceOnce(result, before, after, `SYSTEM owner fixture ${label}`)
  }
}

writeFileSync(testPath, result)
process.stdout.write(
  `Instrumented exact test fixture (${kind}); no application production code changed.\n`
)
