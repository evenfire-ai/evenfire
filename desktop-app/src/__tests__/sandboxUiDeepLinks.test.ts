import { describe, expect, it } from 'vitest'
import {
  buildSandboxUiDeepLink,
  buildSandboxUiWebLink,
  extractSandboxUiViewRoute,
  parseSandboxUiDeepLink,
  sandboxUiDeepLinkTargetsEqual,
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

  it('builds a browser-safe HTTPS handoff link for messaging apps', () => {
    expect(
      buildSandboxUiWebLink('https://profile.example.com', {
        recipeNs: 'sandbox-recipes',
        recipeName: 'agentic-task-board',
        path: '/tasks/task-42?view=detail#activity',
        teamId: 'team-123',
      })
    ).toBe(
      'https://profile.example.com/open/apps/sandbox-recipes/agentic-task-board' +
        '?path=%2Ftasks%2Ftask-42%3Fview%3Ddetail%23activity&team=team-123'
    )
  })

  it('rejects a non-web handoff origin', () => {
    expect(() =>
      buildSandboxUiWebLink('javascript:alert(1)', {
        recipeNs: 'sandbox-recipes',
        recipeName: 'agentic-task-board',
        path: '/',
      })
    ).toThrow('Cannot create a shareable link')
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

  it('compares parsed targets instead of raw query parameter order', () => {
    const first = parseSandboxUiDeepLink(
      'evenfire://app/sandbox-recipes/agentic-task-board?path=%2Ftasks&team=team-123'
    )
    const reordered = parseSandboxUiDeepLink(
      'evenfire://app/sandbox-recipes/agentic-task-board?team=team-123&path=%2Ftasks'
    )

    expect(first).not.toBeNull()
    expect(reordered).not.toBeNull()
    expect(sandboxUiDeepLinkTargetsEqual(first!, reordered!)).toBe(true)
    expect(
      sandboxUiDeepLinkTargetsEqual(first!, {
        ...reordered!,
        path: '/different',
      })
    ).toBe(false)
  })
})
