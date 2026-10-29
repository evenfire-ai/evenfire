import { readFileSync, writeFileSync } from 'node:fs'

const [sourcePath] = process.argv.slice(2)
if (!sourcePath) throw new Error('Expected the exact-source session authority acceptance path')
const source = readFileSync(sourcePath, 'utf8').replace(/\r\n/g, '\n')
function replaceOnce(value, before, after, label) {
  const count = value.split(before).length - 1
  if (count !== 1) throw new Error(`Expected one ${label} anchor; found ${count}`)
  return value.replace(before, () => after)
}
let result = source
result = replaceOnce(
  result,
  "import { createHash, randomUUID } from 'node:crypto'\n",
  "import { createHash, randomUUID } from 'node:crypto'\nimport { appendFileSync } from 'node:fs'\n\nconst pr977RecoveryPhaseAllowlist = new Set([\n  'legacy-scope-start', 'legacy-scope-end',\n  'legacy-observe-first-start', 'legacy-observe-first-end',\n  'legacy-resume-start', 'legacy-resume-end',\n  'legacy-observe-resume-start', 'legacy-observe-resume-end',\n  'legacy-initialize-start', 'legacy-initialize-end',\n  'legacy-observe-initialized-start', 'legacy-observe-initialized-end',\n  'legacy-observation-accepted', 'legacy-path-resolve-start', 'legacy-path-resolve-end',\n  'legacy-capture-start-source', 'legacy-capture-end-source'\n])\nfunction pr977RecoveryPhase(name: string): void {\n  const file = process.env.PR977_DIAGNOSTIC_PHASE_FILE\n  if (!file) return\n  if (!pr977RecoveryPhaseAllowlist.has(name)) throw new Error('Recovery phase is not allowlisted')\n  appendFileSync(file, name + '\\n', 'utf8')\n}\n",
  'bounded phase helper'
)
const methodStart = result.indexOf(
  '  static async recoverCorruptLegacyJournalAfterFreshAuthentication('
)
const methodEnd = result.indexOf(
  '  /** Reconcile authority and sidecars before startup or login interprets marker policy. */',
  methodStart
)
if (methodStart < 0 || methodEnd < 0)
  throw new Error('Missing bounded legacy recovery method range')
let method = result.slice(methodStart, methodEnd)
method = replaceOnce(
  method,
  '        const storageScope = await input.tokenStore.createSessionAuthorityStorageScope()\n',
  "        pr977RecoveryPhase('legacy-scope-start')\n        const storageScope = await input.tokenStore.createSessionAuthorityStorageScope()\n        pr977RecoveryPhase('legacy-scope-end')\n",
  'storage scope'
)
method = replaceOnce(
  method,
  '        let observation = repository.observe()\n',
  "        pr977RecoveryPhase('legacy-observe-first-start')\n        let observation = repository.observe()\n        pr977RecoveryPhase('legacy-observe-first-end')\n",
  'first record observation'
)
method = replaceOnce(
  method,
  '          repository.resumeRecovery()\n          observation = repository.observe()\n',
  "          pr977RecoveryPhase('legacy-resume-start')\n          repository.resumeRecovery()\n          pr977RecoveryPhase('legacy-resume-end')\n          pr977RecoveryPhase('legacy-observe-resume-start')\n          observation = repository.observe()\n          pr977RecoveryPhase('legacy-observe-resume-end')\n",
  'recovery resume'
)
method = replaceOnce(
  method,
  '          committed(repository.initialize(observation.snapshot))\n          observation = repository.observe()\n',
  "          pr977RecoveryPhase('legacy-initialize-start')\n          committed(repository.initialize(observation.snapshot))\n          pr977RecoveryPhase('legacy-initialize-end')\n          pr977RecoveryPhase('legacy-observe-initialized-start')\n          observation = repository.observe()\n          pr977RecoveryPhase('legacy-observe-initialized-end')\n",
  'record initialization'
)
method = replaceOnce(
  method,
  '        const currentRecord = observation.record\n',
  "        pr977RecoveryPhase('legacy-observation-accepted')\n        const currentRecord = observation.record\n",
  'accepted record'
)
method = replaceOnce(
  method,
  '        const directory = input.tokenStore.resolveSessionAuthorityStorageScope(storageScope)\n        const capture = captureSessionPersistenceJournalRecovery(directory, input.envKey)\n',
  "        pr977RecoveryPhase('legacy-path-resolve-start')\n        const directory = input.tokenStore.resolveSessionAuthorityStorageScope(storageScope)\n        pr977RecoveryPhase('legacy-path-resolve-end')\n        pr977RecoveryPhase('legacy-capture-start-source')\n        const capture = captureSessionPersistenceJournalRecovery(directory, input.envKey)\n        pr977RecoveryPhase('legacy-capture-end-source')\n",
  'journal capture call'
)
result = result.slice(0, methodStart) + method + result.slice(methodEnd)
writeFileSync(sourcePath, result)
process.stdout.write('Instrumented bounded legacy recovery boundaries only.\\n')
