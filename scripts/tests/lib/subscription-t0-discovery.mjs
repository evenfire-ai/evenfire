import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const namedRoots = [
  'control-api', 'mcp-host', 'workflow-recipes', 'host-context-controller',
  'control-ui', 'desktop-app', 'tests/e2e', 'scripts/e2e', 'scripts/tests',
]
const excludedDirectories = new Set([
  'node_modules', 'dist', '.next', 'coverage', '.git', 'test-results',
  'playwright-report', 'results', 'artifacts',
])
const testFile = /(?:\.test\.(?:ts|tsx|mjs|cjs)|\.spec\.(?:ts|tsx))$/i

function realPgLane(file) {
  return file.startsWith('control-api/test/') && file.endsWith('.realPostgres.integration.test.ts')
    ? 'real-pg:control-api'
    : undefined
}

export function isSubscriptionCandidate(file, provider) {
  if (calibrationSuites.has(file)) return true
  const name = path.posix.basename(file).toLowerCase()
  const other = provider === 'codex' ? 'grok' : 'codex'
  return name.includes(provider) ||
    (!name.includes(other) && (name.includes('subscription') || name.includes('attachment')))
}

// These pre-existing shared suites have their own physical CI/PG consumers.
// New generic names do not inherit a lane: they must be registered explicitly.
const otherLaneSuites = new Map([
  ['control-api/test/subscriptionGrantIdentity.test.ts', 'general-ci:control-api'],
  ['control-api/test/config.subscriptionCatalogSyncCron.test.ts', 'general-ci:control-api'],
  ['control-api/src/services/__tests__/subscriptionCatalogSyncCron.test.ts', 'general-ci:control-api'],
  ['control-api/test/services.subscriptionCatalogSyncCron.realPostgres.integration.test.ts', 'real-pg:control-api'],
  ['control-api/test/db.codexSubscriptionConnection.realPostgres.integration.test.ts', 'real-pg:control-api'],
  ['control-api/test/pluginWorkloadSdkCodexDualLedger.realPostgres.integration.test.ts', 'real-pg:control-api'],
  ['control-api/test/services.codexSubscriptionCatalog.realPostgres.integration.test.ts', 'real-pg:control-api'],
  ['control-api/test/services.codexSubscriptionLifecycle.realPostgres.integration.test.ts', 'real-pg:control-api'],
  ['control-api/test/services.codexSubscriptionOAuth.realPostgres.integration.test.ts', 'real-pg:control-api'],
  ['control-api/test/services.codexSubscriptionRefreshRejected.realPostgres.integration.test.ts', 'real-pg:control-api'],
  ['control-api/test/services.grokSubscriptionConnection.realPostgres.integration.test.ts', 'real-pg:control-api'],
  ['control-api/test/services.grokProviderAttemptRedemption.realPostgres.integration.test.ts', 'real-pg:control-api'],
  ['control-api/test/services.grokProviderAttemptRedemption.refresh.realPostgres.integration.test.ts', 'real-pg:control-api'],
  ['control-api/test/pluginWorkloadSdkGrokDualLedger.realPostgres.integration.test.ts', 'real-pg:control-api'],
  ['control-api/test/db.llmProviderAttemptConnectionIntegrity.realPostgres.integration.test.ts', 'real-pg:control-api'],
  ['control-api/test/services.llmProviderAttemptAuthorization.realPostgres.integration.test.ts', 'real-pg:control-api'],
  ['mcp-host/src/__tests__/server.attachments.test.ts', 'general-ci:mcp-host'],
  ['mcp-host/src/agent/__tests__/attachmentRead.sqlite.integration.test.ts', 'general-ci:mcp-host'],
  ['mcp-host/src/agent/__tests__/attachmentRead.integration.test.ts', 'general-ci:mcp-host'],
  ['mcp-host/src/agent/__tests__/incomingAttachments.test.ts', 'general-ci:mcp-host'],
  ['mcp-host/src/runtime/__tests__/fileAttachmentDelivery.test.ts', 'general-ci:mcp-host'],
  ['mcp-host/src/core/orchestration/__tests__/toolUseLoopSingleTool.attachmentRead.test.ts', 'general-ci:mcp-host'],
  ['mcp-host/src/core/tools/__tests__/nativeToolRegistry.attachmentRead.test.ts', 'general-ci:mcp-host'],
  ['mcp-host/src/core/tools/__tests__/generatedArtifactAttachments.test.ts', 'general-ci:mcp-host'],
  ['mcp-host/src/core/tools/__tests__/attachmentRead.test.ts', 'general-ci:mcp-host'],
  ['desktop-app/ui/src/lib/__tests__/chatMessageAttachments.test.ts', 'general-ci:desktop-app'],
])
const calibrationSuites = new Map([
  ['scripts/tests/measure-control-api-authorize-memory.test.mjs', 'calibration:control-api-memory'],
])
const runtimeSuites = new Map([
  ['desktop-app/test/e2e-playwright/subscription-image-input.spec.ts', 'desktop-app/test/e2e-playwright/playwright.subscription-image.config.ts'],
  ['desktop-app/test/e2e-playwright/codex-image-input.spec.ts', 'desktop-app/test/e2e-playwright/playwright.codex-image.config.ts'],
  ['desktop-app/test/e2e-playwright/plugin-workload-sdk-codex-fallback.spec.ts', 'desktop-app/test/e2e-playwright/playwright.config.ts'],
  ['desktop-app/test/e2e-playwright/subscription-tool-screenshot.spec.ts', 'desktop-app/test/e2e-playwright/playwright.subscription-tool-screenshot.config.ts'],
  ['desktop-app/test/e2e-playwright/subscription-gfs-image.spec.ts', 'desktop-app/test/e2e-playwright/playwright.subscription-gfs-image.config.ts'],
  ['desktop-app/test/e2e-playwright/subscription-admission-recovery.spec.ts', 'desktop-app/test/e2e-playwright/playwright.subscription-admission-recovery.config.ts'],
  ['tests/e2e/playwright/control-ui/codex-subscription-admission.spec.ts', 'tests/e2e/playwright/playwright.subscription-admission.config.ts'],
  ['tests/e2e/playwright/control-ui/codex-subscription-host-workflow.spec.ts', 'tests/e2e/playwright/playwright.codex-subscription.config.ts'],
  ['tests/e2e/playwright/control-ui/codex-subscription-workflow-recipe.spec.ts', 'tests/e2e/playwright/playwright.codex-subscription.config.ts'],
  ['tests/e2e/playwright/control-ui/codex-subscription-catalog-resync.spec.ts', 'tests/e2e/playwright/playwright.codex-subscription.config.ts'],
  ['tests/e2e/playwright/control-ui/codex-subscription-connection.spec.ts', 'tests/e2e/playwright/playwright.codex-subscription.config.ts'],
  ['tests/e2e/playwright/desktop/codex-subscription-prompt-bridge.spec.ts', 'tests/e2e/playwright/playwright.codex-subscription.config.ts'],
  ['tests/e2e/playwright/desktop/codex-subscription-approved-tools.spec.ts', 'tests/e2e/playwright/playwright.codex-approved-tools.config.ts'],
  ['tests/e2e/playwright/desktop/codex-subscription-channel-cron.spec.ts', 'tests/e2e/playwright/playwright.codex-subscription.config.ts'],
  ['tests/e2e/playwright/desktop/codex-subscription-direct.spec.ts', 'tests/e2e/playwright/playwright.codex-subscription.config.ts'],
  ['scripts/e2e/e2e-codex-subscription-runtime.sh', 'scripts/e2e/e2e-codex-subscription-runtime.sh'],
  ['scripts/e2e/e2e-codex-subscription-playwright.sh', 'scripts/e2e/e2e-codex-subscription-playwright.sh'],
  ['scripts/e2e/e2e-codex-subscription-network-boundary.sh', 'scripts/e2e/e2e-codex-subscription-network-boundary.sh'],
])

function regularFile(root, file) {
  try { return lstatSync(path.join(root, file)).isFile() } catch { return false }
}
function walk(root, directory) {
  const files = []
  for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`
    if (entry.isDirectory() && !excludedDirectories.has(entry.name)) files.push(...walk(root, relative))
    else if (entry.isFile()) files.push(relative)
  }
  return files
}
function isTest(file) {
  return testFile.test(file) || /^e2e-.*\.sh$/i.test(path.posix.basename(file))
}
function configPatterns(source, key) {
  const block = new RegExp(`${key}:\\s*\\[([\\s\\S]*?)\\]`).exec(source)?.[1] ?? ''
  return [...block.matchAll(/['"]([^'"]+)['"]/g)].map(match => match[1])
}

function configSelectors(source, key) {
  const values = []
  const assignments = new RegExp(
    `${key}:\\s*(\\[[^\\]]*\\]|/(?:\\\\.|[^/\\\\])+/[a-z]*|'[^']*'|"[^"]*")`,
    'g',
  )
  for (const match of source.matchAll(assignments)) {
    const value = match[1]
    if (value.startsWith('[')) values.push(...configPatterns(`${key}: [${value.slice(1, -1)}]`, key))
    else if (value.startsWith('/')) values.push(new RegExp(value.slice(1, value.lastIndexOf('/'))))
    else values.push(value.slice(1, -1))
  }
  return values
}

function matchesPlaywrightSelector(relative, selector) {
  if (selector instanceof RegExp) return selector.test(relative)
  return path.matchesGlob(relative, selector) ||
    (!selector.includes('/') && path.matchesGlob(path.posix.basename(relative), selector))
}

function projectBlocks(source) {
  const projectsAssignment = /(?:^|\n)\s*projects:\s*\[/.exec(source)
  if (!projectsAssignment) return []
  const arrayStart = source.indexOf('[', projectsAssignment.index)
  const blocks = []
  let depth = 0
  let blockDepth = 0
  let blockStart = -1
  let quote
  for (let index = arrayStart; index < source.length; index += 1) {
    const character = source[index]
    if (quote) {
      if (character === '\\') index += 1
      else if (character === quote) quote = undefined
      continue
    }
    if (character === '\'' || character === '"' || character === '`') {
      quote = character
      continue
    }
    if (character === '[' || character === '{') {
      depth += 1
      if (character === '{' && depth === 2) {
        blockDepth = depth
        blockStart = index
      }
      continue
    }
    if (character === ']' || character === '}') {
      depth -= 1
      if (character === ']' && depth === 0) return blocks
    }
    if (character === '}') {
      if (blockStart >= 0 && depth === 1) {
        blocks.push(source.slice(blockStart, index + 1))
        blockStart = -1
      }
    }
  }
  return blocks
}

function playwrightCollectsFile(source, configDirectory, file) {
  if (source.includes('subscriptionRemainingJourneyConfig')) {
    const delegatedRemainingConfig = /remainingJourneyConfig\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/.exec(source)
    if (!delegatedRemainingConfig) return false
    const helper = readFileSync(path.join(configDirectory, 'subscriptionRemainingJourneyConfig.ts'), 'utf8')
    return path.posix.basename(file) === delegatedRemainingConfig[2] &&
      /return\s+defineConfig\s*\(/.test(helper) &&
      helper.includes('testMatch: `**/${specFile}`') &&
      /=\s*requireSubscriptionImageRun\s*\(/.test(helper) &&
      /(?:^|\n)\s*requireRemainingJourney\s*\(/.test(helper)
  }
  if (!source.includes('defineConfig')) return false
  const relative = path.posix.relative(configDirectory, file)
  const testDirectory = /(?:^|[{,\n]\s*)testDir:\s*['"](.+)['"]/.exec(source)?.[1]
  if (testDirectory) {
    const normalized = path.posix.normalize(testDirectory)
    if (normalized !== '.' && !relative.startsWith(`${normalized}/`)) return false
  }

  const projectsAssignment = /(?:^|\n)\s*projects:\s*\[/.exec(source)
  const topLevelSource = projectsAssignment
    ? source.slice(0, projectsAssignment.index)
    : source
  const ignored = configSelectors(topLevelSource, 'testIgnore')
    .some(selector => matchesPlaywrightSelector(relative, selector))
  if (ignored) return false

  const topLevelSelectors = configSelectors(topLevelSource, 'testMatch')
  if (topLevelSelectors.length > 0) {
    return topLevelSelectors.some(selector => matchesPlaywrightSelector(relative, selector))
  }

  const blocks = projectBlocks(source)
  if (blocks.length === 0) return true
  return blocks.some(block => {
    const blockIgnored = configSelectors(block, 'testIgnore')
      .some(selector => matchesPlaywrightSelector(relative, selector))
    const selectors = configSelectors(block, 'testMatch')
    if (selectors.length === 0) return !blockIgnored
    return !blockIgnored &&
      selectors.some(selector => matchesPlaywrightSelector(relative, selector))
  })
}

export function verifyRuntimeConsumer(root, file, consumer) {
  if (!regularFile(root, file) || !regularFile(root, consumer)) return undefined

  if (/\.sh$/i.test(consumer)) {
    const source = readFileSync(path.join(root, consumer), 'utf8')
    const executable = (lstatSync(path.join(root, consumer)).mode & 0o111) !== 0
    if (consumer !== file || !source.startsWith('#!') || !executable) return undefined
    return `${consumer} (explicit self entrypoint; separate physical receipt required)`
  }

  const source = readFileSync(path.join(root, consumer), 'utf8')
  const configDirectory = path.join(root, path.posix.dirname(consumer))
  if (!playwrightCollectsFile(source, configDirectory, path.join(root, file))) return undefined
  return `${consumer} (collection-verified registry entry)`
}

function verifyOtherConsumer(root, file, lane) {
  const service = lane.split(':')[1]
  const ciPath = '.github/workflows/ci-public.yml'
  const configPath = `${service}/vitest.config.ts`
  if (!regularFile(root, ciPath) || !regularFile(root, configPath)) return undefined
  const ci = readFileSync(path.join(root, ciPath), 'utf8')
  const config = readFileSync(path.join(root, configPath), 'utf8')
  const relative = file.slice(service.length + 1)
  const included = configPatterns(config, 'include').some(pattern => path.matchesGlob(relative, pattern))
  const excluded = configPatterns(config, 'exclude').some(pattern => path.matchesGlob(relative, pattern))
  if (!included || excluded) return undefined
  if (lane.startsWith('real-pg:')) {
    const pgJob = ci.split('  control-api-migration:')[1]?.split(/\n  [a-z][a-z0-9-]*:/)[0]
    if (
      !pgJob ||
      !/CONTROL_API_REAL_PG_REQUIRED:\s*'1'/.test(pgJob) ||
      !/npm test.*(?:--run )?realPostgres/.test(pgJob)
    ) return undefined
    return `${ciPath}#control-api-migration (realPostgres filter); ${configPath}`
  }
  if (!new RegExp(`^\\s*- ${service}\\s*$`, 'm').test(ci) || !ci.includes('npm test')) return undefined
  return `${ciPath}#test (${service}); ${configPath}`
}

function verifyCalibrationConsumer(root, file, lane) {
  if (lane !== 'calibration:control-api-memory') return undefined
  const driver = 'scripts/tests/measure-control-api-authorize-memory.mjs'
  if (!regularFile(root, file) || !regularFile(root, driver)) return undefined
  const makefile = regularFile(root, 'Makefile')
    ? readFileSync(path.join(root, 'Makefile'), 'utf8')
    : ''
  if (!makefile.includes('minikube-control-api-authorize-memory:')) return undefined
  return `Makefile#minikube-control-api-authorize-memory (physical calibration only); ${driver}`
}

export function auditSubscriptionDiscovery(provider, root, registered) {
  if (!['grok', 'codex'].includes(provider)) throw new Error('provider must be grok or codex')
  const suiteRoots = provider === 'grok'
    ? ['grok-llm-proxy/test', 'packages/grok-provider-attempt-contract']
    : ['codex-llm-proxy/test', 'packages/llm-provider-attempt-contract']
  const violations = [], candidates = [], roots = [...suiteRoots, ...namedRoots]
  const filesByRoot = new Map()
  const registeredSet = new Set(registered)
  if (registeredSet.size !== registered.length) violations.push('duplicate registered physical suite')
  for (const file of registered) {
    if (path.posix.isAbsolute(file) || path.posix.normalize(file) !== file || file.startsWith('../') || !regularFile(root, file)) {
      violations.push(`missing or invalid registered suite ${file}`)
    }
  }
  for (const directory of roots) {
    let valid = false
    try { valid = lstatSync(path.join(root, directory)).isDirectory() } catch { /* Missing is a violation. */ }
    if (!valid) { violations.push(`missing discovery root ${directory}`); continue }
    const files = walk(root, directory).filter(isTest)
    if (files.length === 0) violations.push(`empty discovery root ${directory}`)
    filesByRoot.set(directory, files)
  }
  for (const [directory, files] of filesByRoot) {
    for (const file of files) {
      if (!suiteRoots.includes(directory) && !isSubscriptionCandidate(file, provider)) continue
      let lane, consumer
      const pgLane = realPgLane(file)
      const pgRegistered = Boolean(pgLane) &&
        registeredSet.has(file) && otherLaneSuites.get(file) === pgLane
      const calibrationLane = calibrationSuites.get(file)
      const calibrationRegistered = registeredSet.has(file) && calibrationLane !== undefined
      if (runtimeSuites.has(file)) {
        lane = 'runtime-opt-in'
        if (registeredSet.has(file)) {
          violations.push(`runtime suite cannot be registered as a T0 unit ${file}`)
          continue
        }
        consumer = verifyRuntimeConsumer(root, file, runtimeSuites.get(file))
        if (!consumer) violations.push(`runtime consumer does not collect ${file}`)
      } else if (pgRegistered) {
        lane = pgLane
        consumer = verifyOtherConsumer(root, file, pgLane)
        if (!consumer) violations.push(`unverified ${pgLane} consumer for ${file}`)
        else violations.push(`real-PG suite cannot be registered as a T0 unit ${file}`)
      } else if (calibrationRegistered) {
        lane = calibrationLane
        consumer = verifyCalibrationConsumer(root, file, calibrationLane)
        if (!consumer) violations.push(`unverified ${calibrationLane} consumer for ${file}`)
        else violations.push(`calibration suite cannot be registered as a T0 unit ${file}`)
      } else if (registeredSet.has(file)) {
        lane = 'T0'
        consumer = 'physical T0 group; separate producer/reporter required'
      } else if (pgLane && otherLaneSuites.get(file) === pgLane) {
        lane = pgLane
        consumer = verifyOtherConsumer(root, file, lane)
        if (!consumer) violations.push(`unverified ${lane} consumer for ${file}`)
      } else if (calibrationLane !== undefined) {
        lane = calibrationLane
        consumer = verifyCalibrationConsumer(root, file, lane)
        if (!consumer) violations.push(`unverified ${lane} consumer for ${file}`)
      } else if (otherLaneSuites.has(file)) {
        lane = otherLaneSuites.get(file)
        consumer = verifyOtherConsumer(root, file, lane)
        if (!consumer) violations.push(`unverified ${lane} consumer for ${file}`)
      } else {
        violations.push(`unlisted ${provider} subscription suite ${file}`)
        lane = 'UNLISTED'
      }
      candidates.push({ file, lane, consumer, evidence: 'NOT_RUN_HERE', requiredPhysicalEvidence: true })
    }
  }
  if (candidates.length === 0) violations.push(`empty ${provider} subscription candidate scan`)
  return { provider, roots, candidates: candidates.sort((a, b) => a.file.localeCompare(b.file)), violations }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [provider, root, registryFile, outputMode] = process.argv.slice(2)
  if (!provider || !root || !registryFile || (outputMode && outputMode !== '--json')) {
    console.error('usage: subscription-t0-discovery.mjs <grok|codex> <root> <registered-file> [--json]')
    process.exit(2)
  }
  const registered = readFileSync(registryFile, 'utf8').split(/\r?\n/).filter(Boolean)
  const result = auditSubscriptionDiscovery(provider, root, registered)
  if (outputMode === '--json') console.log(JSON.stringify(result))
  else {
    for (const entry of result.candidates.filter(entry => entry.lane !== 'T0')) {
      console.log(`INVENTORY ${entry.lane} NOT_RUN_HERE: ${entry.file}; physical evidence required via ${entry.consumer ?? 'explicit registration'}`)
    }
    for (const violation of result.violations) console.error(`FAIL: ${violation}`)
    console.log(`Discovery inventory: ${provider}, ${result.candidates.length} candidates, ${result.violations.length} violations; execution evidence is separate`)
  }
  process.exit(result.violations.length ? 1 : 0)
}
