import assert from 'node:assert/strict'
import test from 'node:test'
import { GET } from '../app/open/apps/[recipeNs]/[recipeName]/route'

const routeContext = {
  params: Promise.resolve({
    recipeNs: 'sandbox-recipes',
    recipeName: 'agentic-task-board',
  }),
}

test('desktop app handoff leaves an omitted path to the recipe default', async () => {
  const response = await GET(new Request('https://profile.example/open/apps/ns/app'), routeContext)
  const body = await response.text()

  assert.equal(response.status, 200)
  assert.match(body, /evenfire:\/\/app\/sandbox-recipes\/agentic-task-board/)
  assert.doesNotMatch(body, /[?&]path=/)
  assert.match(body, /Open app in Evenfire/)
})

test('desktop app handoff rejects dot-segment routes with hardened error headers', async () => {
  const request = new Request(
    'https://profile.example/open/apps/ns/app?path=%2Fsafe%2F%252e%252e%2Fadmin'
  )
  const response = await GET(request, routeContext)

  assert.equal(response.status, 400)
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
})
