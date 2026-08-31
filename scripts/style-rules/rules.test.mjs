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

test('allows shared table-system composition and test fixtures', () => {
  const shared = '<DataTable><TableBody /></DataTable>'
  const fixture = '<table><tbody /></table>'

  assert.deepEqual(violationsFor('control-ui/app/agents/page.tsx', shared), [])
  assert.deepEqual(violationsFor('profile-ui/__tests__/members.test.tsx', fixture), [])
  assert.deepEqual(violationsFor('packages/frontend-table-system/src/DataTable.tsx', fixture), [])
})

test('rejects retired production table and expansion families', () => {
  const examples = [
    ['control-ui/components/McpServerTable.tsx', 'className="cu-expandable-table"'],
    ['control-ui/components/ContextTable.tsx', 'className="cu-expandable-row__name"'],
    ['profile-ui/app/members/page.tsx', 'className="members-table__row"'],
    ['profile-ui/app/settings/page.tsx', "import EditableList from './EditableList'"],
    ['control-ui/app/secrets/page.tsx', '<LlmSecretsSubTabs />'],
    ['control-ui/components/Hosts.tsx', "import RowActions from './RowActions'"],
  ]

  for (const [file, content] of examples) {
    assert.equal(violationsFor(file, content).length, 1, `${file} should be rejected`)
  }
})

test('does not confuse RowActionsMenu with the retired RowActions component', () => {
  assert.deepEqual(
    violationsFor(
      'control-ui/components/Hosts.tsx',
      "import { RowActionsMenu } from '@evenfire/frontend-table-system'\n<RowActionsMenu />"
    ),
    []
  )
})

test('shared table colors resolve through tokens declared by both web apps', () => {
  const sharedCss = readFileSync('packages/frontend-table-system/styles.css', 'utf8')
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
