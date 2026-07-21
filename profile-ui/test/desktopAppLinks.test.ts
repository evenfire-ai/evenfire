import assert from 'node:assert/strict'
import test from 'node:test'
import { buildEvenfireDesktopAppLink } from '../lib/desktopAppLinks'

test('buildEvenfireDesktopAppLink preserves a nested app route and team', () => {
  assert.equal(
    buildEvenfireDesktopAppLink({
      recipeNs: 'sandbox-recipes',
      recipeName: 'agentic-task-board',
      path: '/tasks/task-42?view=detail#activity',
      teamId: 'team-123',
    }),
    'evenfire://app/sandbox-recipes/agentic-task-board' +
      '?path=%2Ftasks%2Ftask-42%3Fview%3Ddetail%23activity&team=team-123'
  )
})

test('buildEvenfireDesktopAppLink rejects unsafe routes', () => {
  assert.equal(
    buildEvenfireDesktopAppLink({
      recipeNs: 'sandbox-recipes',
      recipeName: 'agentic-task-board',
      path: '//outside.example',
    }),
    null
  )
})
