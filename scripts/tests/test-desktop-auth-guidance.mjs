import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = relativePath => readFile(path.join(repositoryRoot, relativePath), 'utf8')

function frontmatterValue(document, key) {
  const frontmatter = document.match(/^---\n([\s\S]*?)\n---/)
  assert.ok(frontmatter, 'adapter must have YAML frontmatter')
  const line = frontmatter[1].split('\n').find(item => item.startsWith(`${key}:`))
  assert.ok(line, `adapter frontmatter must define ${key}`)
  return line.slice(key.length + 1).trim().replace(/^['"]|['"]$/g, '')
}

function cursorGlobs(document) {
  const frontmatter = document.match(/^---\n([\s\S]*?)\n---/)
  assert.ok(frontmatter, 'Cursor adapter must have YAML frontmatter')
  const match = frontmatter[1].match(/^globs:\n((?:\s+- .*\n?)+)/m)
  assert.ok(match, 'Cursor adapter must define globs')
  return [...match[1].matchAll(/^\s+- (.+)$/gm)].map(([, glob]) => glob.trim())
}

function matchesDesktopScope(scope, file) {
  return scope.endsWith('/**') ? file.startsWith(scope.slice(0, -2)) : file === scope
}

test('README owns the authenticated-service contract and the centralized coordinator', async () => {
  const readme = await read('desktop-app/README.md')
  assert.match(readme, /^## Authenticated Service Integration$/m)
  assert.match(readme, /SessionAuthorityCoordinator/)
  assert.match(readme, /producer-attested expiration or invalidation/)
  assert.match(readme, /401\/403 status, error text, proxy response/)
  assert.match(readme, /before publishing any success, error, callback/)
  assert.match(readme, /must not own global logout policy/)
})

test('Codex and Claude root adapters route to the canonical README anchor', async () => {
  for (const providerFile of ['AGENTS.md', 'CLAUDE.md']) {
    const provider = await read(providerFile)
    assert.match(provider, /desktop-app\/README\.md#authenticated-service-integration/)
  }
})

test('Copilot applyTo covers main and renderer Desktop paths', async () => {
  const copilot = await read('.github/instructions/desktop-authentication.instructions.md')
  const copilotRoot = await read('.github/copilot-instructions.md')
  const applyTo = frontmatterValue(copilot, 'applyTo').replaceAll("'", '')
  for (const fixture of ['desktop-app/src/example.ts', 'desktop-app/ui/src/example.tsx']) {
    assert.equal(matchesDesktopScope(applyTo, fixture), true, `${fixture} must match ${applyTo}`)
  }
  assert.match(copilot, /desktop-app\/README\.md#authenticated-service-integration/)
  assert.match(
    copilotRoot,
    /path-scoped through the applicable files under\s+`\.github\/instructions\/`/
  )
})

test('Cursor globs cover main and renderer Desktop paths', async () => {
  const cursor = await read('.cursor/rules/desktop-authentication.mdc')
  assert.equal(frontmatterValue(cursor, 'alwaysApply'), 'false')
  const globs = cursorGlobs(cursor)
  for (const fixture of ['desktop-app/src/example.ts', 'desktop-app/ui/src/example.tsx']) {
    assert.equal(
      globs.some(glob => matchesDesktopScope(glob, fixture)),
      true,
      `${fixture} must match`
    )
  }
  assert.match(cursor, /@desktop-app\/README\.md#authenticated-service-integration/)
})

test('adapters cover both Desktop fixtures without broadening outside Desktop', async () => {
  const main = 'desktop-app/src/example.ts'
  const renderer = 'desktop-app/ui/src/example.tsx'
  const unrelated = 'control-ui/src/example.tsx'
  const copilotAdapter = await read('.github/instructions/desktop-authentication.instructions.md')
  const copilot = frontmatterValue(copilotAdapter, 'applyTo').replaceAll("'", '')
  const cursor = cursorGlobs(await read('.cursor/rules/desktop-authentication.mdc'))
  for (const fixture of [main, renderer]) {
    assert.equal(matchesDesktopScope(copilot, fixture), true)
    assert.equal(cursor.some(glob => matchesDesktopScope(glob, fixture)), true)
  }
  assert.equal(matchesDesktopScope(copilot, unrelated), false)
  assert.equal(cursor.some(glob => matchesDesktopScope(glob, unrelated)), false)
  assert.match(await read('AGENTS.md'), /desktop-app\/README\.md#authenticated-service-integration/)
  assert.match(await read('CLAUDE.md'), /desktop-app\/README\.md#authenticated-service-integration/)
})
