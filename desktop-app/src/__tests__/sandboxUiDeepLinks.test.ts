import { describe, expect, it } from 'vitest'
import {
  buildSandboxUiDeepLink,
  extractSandboxUiViewRoute,
  parseSandboxUiDeepLink,
} from '../sandboxUiDeepLinks.js'

describe('sandbox UI deep links', () => {
  it('round-trips an app route, query, fragment, and team', () => {
    const url = buildSandboxUiDeepLink({
      recipeNs: 'sandbox-recipes',
      recipeName: 'agentic-task-board',
      path: '/boards/product/tasks/task-42?view=detail#activity',
      teamId: 'team-123',
    })

    expect(parseSandboxUiDeepLink(url)).toEqual({
      appRef: 'sandbox-recipes/agentic-task-board',
      path: '/boards/product/tasks/task-42?view=detail#activity',
      teamId: 'team-123',
    })
  })

  it('rejects malformed app routes and unrelated evenfire links', () => {
    expect(parseSandboxUiDeepLink('evenfire://desktop-setup?email=user@example.com')).toBeNull()
    expect(
      parseSandboxUiDeepLink(
        'evenfire://app/sandbox-recipes/agentic-task-board?path=https%3A%2F%2Fevil.example'
      )
    ).toBeNull()
    expect(
      parseSandboxUiDeepLink(
        'evenfire://app/sandbox-recipes/agentic-task-board?path=%2F%2Fevil.example'
      )
    ).toBeNull()
    expect(
      parseSandboxUiDeepLink('evenfire://app/sandbox-recipes/agentic-task-board?team=team%2Fother')
    ).toBeNull()
    expect(parseSandboxUiDeepLink('https://example.com/app')).toBeNull()
  })

  it('extracts the current route from the active embedded app URL', () => {
    expect(
      extractSandboxUiViewRoute({
        currentUrl:
          'https://rpc.example/api/v1/sandbox-ui/sandbox-recipes/' +
          'agentic-task-board/view/tasks/task-42?panel=comments#latest',
        rpcProxyOrigin: 'https://rpc.example/',
        recipeNs: 'sandbox-recipes',
        recipeName: 'agentic-task-board',
      })
    ).toBe('/tasks/task-42?panel=comments#latest')
  })

  it('does not extract routes from another origin or recipe', () => {
    expect(
      extractSandboxUiViewRoute({
        currentUrl:
          'https://other.example/api/v1/sandbox-ui/sandbox-recipes/' +
          'agentic-task-board/view/tasks/task-42',
        rpcProxyOrigin: 'https://rpc.example',
        recipeNs: 'sandbox-recipes',
        recipeName: 'agentic-task-board',
      })
    ).toBeNull()
  })
})
