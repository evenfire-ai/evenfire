import assert from 'node:assert/strict'
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
