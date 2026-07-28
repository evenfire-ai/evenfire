'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const links = require('./index.cjs')

test('runtime exports stay aligned with the declaration file', () => {
  const declarations = fs.readFileSync(path.join(__dirname, 'index.d.ts'), 'utf8')
  const declaredRuntimeExports = Array.from(
    declarations.matchAll(/export (?:declare )?(?:const|function)\s+([A-Za-z0-9_]+)/g),
    match => match[1]
  ).sort()

  assert.deepEqual(Object.keys(links).sort(), declaredRuntimeExports)
})

test('web and desktop links use the same canonical route contract', () => {
  const target = {
    recipeNs: 'sandbox-recipes',
    recipeName: 'task-board',
    path: '/tasks/42',
    teamId: 'team-1',
  }

  assert.equal(
    links.buildSandboxUiWebLink('https://profile.example.com', target),
    'https://profile.example.com/open/apps/sandbox-recipes/task-board' +
      '?path=%2Ftasks%2F42&team=team-1'
  )
  assert.deepEqual(links.parseSandboxUiDeepLink(links.buildSandboxUiDeepLink(target)), {
    appRef: 'sandbox-recipes/task-board',
    path: '/tasks/42',
    teamId: 'team-1',
  })
})
