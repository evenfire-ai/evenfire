import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { rulesForFile } from './rules.mjs'

function violationsFor(file, content) {
  const lines = content.split(/\r?\n/)
  return rulesForFile(file).flatMap(rule =>
    rule.check({
      file,
      content,
      lines,
    })
  )
}

test('rejects raw production tables in Control UI and Profile UI', () => {
  assert.equal(
    violationsFor('control-ui/app/agents/page.tsx', '<table><tbody /></table>').length,
    1
  )
  assert.equal(violationsFor('profile-ui/app/members/page.tsx', '<table />').length, 1)
})

test('allows shared table composition and test fixtures', () => {
  const shared = '<DataTable><TableBody /></DataTable>'
  const fixture = '<table><tbody /></table>'

  assert.deepEqual(violationsFor('control-ui/app/agents/page.tsx', shared), [])
  assert.deepEqual(violationsFor('profile-ui/__tests__/members.test.tsx', fixture), [])
  assert.deepEqual(violationsFor('packages/frontend-components/src/DataTable.tsx', fixture), [])
})

test('requires the shared viewport boundary in application production source', () => {
  const direct = '<div className="eft-table-viewport eft-table-viewport--embedded" />'
  const shared = '<TableViewport embedded><DataTable /></TableViewport>'

  assert.equal(violationsFor('control-ui/components/Results.tsx', direct).length, 1)
  assert.equal(violationsFor('profile-ui/app/members/page.tsx', direct).length, 1)
  assert.equal(violationsFor('control-ui/app/globals.css', '.eft-table-viewport {}').length, 1)
  assert.equal(violationsFor('profile-ui/app/globals.css', '.eft-table-viewport {}').length, 1)
  assert.deepEqual(violationsFor('control-ui/components/Results.tsx', shared), [])
  assert.deepEqual(violationsFor('packages/frontend-components/src/index.tsx', direct), [])
  assert.deepEqual(violationsFor('control-ui/components/__tests__/Results.test.tsx', direct), [])
})

test('rejects retired production table and expansion families', () => {
  const examples = [
    ['control-ui/components/McpServerTable.tsx', 'className="cu-expandable-table"'],
    ['control-ui/components/ContextTable.tsx', 'className="cu-expandable-row__name"'],
    ['profile-ui/app/members/page.tsx', 'className="members-table__row"'],
    ['profile-ui/app/settings/page.tsx', "import EditableList from './EditableList'"],
    ['control-ui/app/secrets/page.tsx', '<LlmSecretsSubTabs />'],
    ['control-ui/components/Hosts.tsx', "import RowActions from './RowActions'"],
    ['control-ui/components/RecipeGrants.tsx', "import GrantsPanel from './GrantsPanel'"],
    ['control-ui/app/agents/page.tsx', "import { sortRows } from '../../lib/tableSort'"],
  ]

  for (const [file, content] of examples) {
    assert.equal(violationsFor(file, content).length, 1, `${file} should be rejected`)
  }
})

test('does not confuse RowActionsMenu with the retired RowActions component', () => {
  assert.deepEqual(
    violationsFor(
      'control-ui/components/Hosts.tsx',
      "import { RowActionsMenu } from '@evenfire/frontend-components'\n<RowActionsMenu />"
    ),
    []
  )
})

test('allows shared sorting helpers and similarly named non-retired table symbols', () => {
  assert.deepEqual(
    violationsFor(
      'control-ui/app/agents/page.tsx',
      "import { createStringComparator } from '@clerum/frontend-components'"
    ),
    []
  )
  assert.deepEqual(
    violationsFor('control-ui/components/GrantPanelSummary.tsx', '<GrantPanelSummary />'),
    []
  )
  assert.deepEqual(
    violationsFor('control-ui/components/__tests__/GrantsPanel.test.tsx', '<GrantsPanel />'),
    []
  )
})

test('shared table colors resolve through tokens declared by both web apps', () => {
  const sharedCss = readFileSync('packages/frontend-components/styles.css', 'utf8')
  const controlCss = readFileSync('control-ui/app/globals.css', 'utf8')
  const profileCss = readFileSync('profile-ui/app/globals.css', 'utf8')
  const bindings = [...sharedCss.matchAll(/--eft-[^:]+:\s*var\((--cu-[^)]+)\);/g)]

  assert.ok(bindings.length >= 7)
  for (const [, token] of bindings) {
    assert.match(controlCss, new RegExp(`${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`))
    assert.match(profileCss, new RegExp(`${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`))
  }
  assert.match(controlCss, /--cu-focus-rgb\s*:/)
  assert.match(profileCss, /--cu-focus-rgb\s*:/)
  assert.match(controlCss, /:root\[data-theme='light'\][\s\S]*--cu-surface-hover\s*:/)
  assert.doesNotMatch(sharedCss, /--eft-[^:]+:[^;]*#[0-9a-f]{3,8}/i)
})

test('shared table typography uses each web app contract', () => {
  const sharedCss = readFileSync('packages/frontend-components/styles.css', 'utf8')
  const controlCss = readFileSync('control-ui/app/globals.css', 'utf8')
  const profileCss = readFileSync('profile-ui/app/globals.css', 'utf8')

  assert.match(
    sharedCss,
    /\.eft-table tbody td[\s\S]*font-size:\s*var\(--eft-table-cell-font-size\)/
  )
  assert.match(
    sharedCss,
    /\.eft-table thead th[\s\S]*font-size:\s*var\(--eft-table-header-font-size\)[\s\S]*font-weight:\s*var\(--eft-table-header-font-weight\)[\s\S]*letter-spacing:\s*var\(--eft-table-header-letter-spacing\)/
  )
  assert.match(controlCss, /--eft-table-header-font-size:\s*var\(--cu-font-size-2xs\)/)
  assert.match(controlCss, /--eft-table-header-font-weight:\s*var\(--cu-font-weight-semibold\)/)
  assert.match(controlCss, /--eft-table-cell-font-size:\s*var\(--cu-font-size-md\)/)
  assert.match(profileCss, /--eft-table-header-font-size:\s*0\.75rem/)
  assert.match(profileCss, /--eft-table-header-font-weight:\s*600/)
  assert.match(profileCss, /--eft-table-cell-font-size:\s*0\.9rem/)
})
