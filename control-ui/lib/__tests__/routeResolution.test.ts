import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { CONTROL_ROUTES } from '@constants/routes'
import nextConfig from '../../next.config.js'

type RouteRule = { source: string; destination: string }

function collectRoutePaths(value: unknown): string[] {
  if (typeof value === 'string') return [new URL(value, 'http://app.local').pathname]

  if (typeof value === 'function') {
    const result = value('sample', 'sample', 'sample')
    return typeof result === 'string' ? [new URL(result, 'http://app.local').pathname] : []
  }

  if (!value || typeof value !== 'object') return []
  return Object.values(value).flatMap(collectRoutePaths)
}

function applyRule(pathname: string, rule: RouteRule): string | null {
  const wildcard = '/:path*'
  if (rule.source.endsWith(wildcard)) {
    const sourceBase = rule.source.slice(0, -wildcard.length)
    if (pathname !== sourceBase && !pathname.startsWith(`${sourceBase}/`)) return null

    const rest = pathname.slice(sourceBase.length).replace(/^\//, '')
    return rule.destination.replace(':path*', rest).replace(/\/$/, '') || '/'
  }

  const sourceParts = rule.source.split('/')
  const pathnameParts = pathname.split('/')
  if (sourceParts.length !== pathnameParts.length) return null

  const params: Record<string, string> = {}
  for (let index = 0; index < sourceParts.length; index += 1) {
    const sourcePart = sourceParts[index]
    const pathnamePart = pathnameParts[index]
    if (sourcePart.startsWith(':')) {
      params[sourcePart.slice(1)] = pathnamePart
    } else if (sourcePart !== pathnamePart) {
      return null
    }
  }

  return rule.destination.replace(/:([^/]+)/g, (match, name: string) => params[name] ?? match)
}

function appRoutePatterns(): RegExp[] {
  const appDirectory = path.join(process.cwd(), 'app')
  const routeFiles: string[] = []

  function visit(directory: string) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(entryPath)
      else if (/^(page|route)\.(?:js|jsx|ts|tsx)$/.test(entry.name)) routeFiles.push(entryPath)
    }
  }

  visit(appDirectory)
  return routeFiles.map(file => {
    const relativeDirectory = path.relative(appDirectory, path.dirname(file))
    const routePath = relativeDirectory ? `/${relativeDirectory}` : '/'
    const pattern = routePath
      .split('/')
      .map(part => (/^\[.+\]$/.test(part) ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('/')
    return new RegExp(`^${pattern}$`)
  })
}

function resolvesToAppRoute(
  initialPath: string,
  redirects: RouteRule[],
  rewrites: RouteRule[],
  appRoutes: RegExp[]
): boolean {
  let pathname = initialPath

  for (let step = 0; step < 8; step += 1) {
    if (appRoutes.some(pattern => pattern.test(pathname))) return true

    const redirect = redirects.map(rule => applyRule(pathname, rule)).find(Boolean)
    if (redirect) {
      pathname = redirect
      continue
    }

    const rewrite = rewrites.map(rule => applyRule(pathname, rule)).find(Boolean)
    if (rewrite && rewrite.startsWith('/')) {
      pathname = rewrite
      continue
    }

    return false
  }

  return false
}

describe('CONTROL_ROUTES App Router resolution', () => {
  it('resolves every route constant through redirects and rewrites to an app route', async () => {
    const redirects = ((await nextConfig.redirects?.()) ?? []) as RouteRule[]
    const rewrites = ((await nextConfig.rewrites?.()) ?? []) as RouteRule[]
    const appRoutes = appRoutePatterns()
    const routePaths = [...new Set(collectRoutePaths(CONTROL_ROUTES))]
    const unresolved = routePaths.filter(
      route => !resolvesToAppRoute(route, redirects, rewrites, appRoutes)
    )

    expect(unresolved).toEqual([])
  })

  it('redirects the previous directory section URLs to their canonical names', async () => {
    const redirects = ((await nextConfig.redirects?.()) ?? []) as RouteRule[]

    expect(redirects).toEqual(
      expect.arrayContaining([
        {
          source: '/global-files',
          destination: CONTROL_ROUTES.globalFileSystem,
          permanent: true,
        },
        {
          source: '/outputs',
          destination: CONTROL_ROUTES.agentOutputs.root,
          permanent: true,
        },
        {
          source: '/shared-files',
          destination: CONTROL_ROUTES.agentFiles.root,
          permanent: true,
        },
      ])
    )
  })

  it('preserves the old host-detail tab slugs as compatibility redirects', async () => {
    // R1-H1: the host-detail page consolidated Member access + Team access
    // into a single Access tab, and Per-tool approval + Env vars into a
    // single Advanced tab. The old slugs must still resolve so bookmarks,
    // shared links, and the approval-tools E2E keep working.
    const redirects = ((await nextConfig.redirects?.()) ?? []) as RouteRule[]

    expect(redirects).toEqual(
      expect.arrayContaining([
        {
          source: '/agents/:name/member-access',
          destination: '/agents/:name/access',
          permanent: true,
        },
        {
          source: '/agents/:name/team-access',
          destination: '/agents/:name/access',
          permanent: true,
        },
        {
          source: '/agents/:name/approvals',
          destination: '/agents/:name/advanced',
          permanent: true,
        },
        {
          source: '/agents/:name/env-vars',
          destination: '/agents/:name/advanced',
          permanent: true,
        },
        {
          source: '/agents/:name/contexts',
          destination: '/agents/:name/connectors',
          permanent: true,
        },
      ])
    )
  })

  it('follows the legacy tab slugs all the way to an app route', async () => {
    const redirects = ((await nextConfig.redirects?.()) ?? []) as RouteRule[]
    const rewrites = ((await nextConfig.rewrites?.()) ?? []) as RouteRule[]
    const appRoutes = appRoutePatterns()
    const legacySlugs = ['member-access', 'team-access', 'approvals', 'env-vars', 'contexts']

    for (const slug of legacySlugs) {
      const pathname = `/agents/foo/${slug}`
      expect(resolvesToAppRoute(pathname, redirects, rewrites, appRoutes)).toBe(true)
    }
  })

  it('redirects the legacy agent Contexts deep link to the Connectors experience', async () => {
    const redirects = ((await nextConfig.redirects?.()) ?? []) as RouteRule[]
    const rewrites = ((await nextConfig.rewrites?.()) ?? []) as RouteRule[]
    const appRoutes = appRoutePatterns()

    // Direct-route regression: before this compatibility rule, the /agents
    // rewrite reached hosts/[name]/[tab] with tab="contexts", which called
    // notFound() because the renamed tab only accepted "connectors".
    expect(resolvesToAppRoute('/agents/demo-agent/contexts', redirects, rewrites, appRoutes)).toBe(
      true
    )
    expect(redirects).toEqual(
      expect.arrayContaining([
        {
          source: '/agents/:name/contexts',
          destination: '/agents/:name/connectors',
          permanent: true,
        },
      ])
    )
  })

  it('resolves public detail roots and their default tab slugs', async () => {
    const redirects = ((await nextConfig.redirects?.()) ?? []) as RouteRule[]
    const rewrites = ((await nextConfig.rewrites?.()) ?? []) as RouteRule[]
    const appRoutes = appRoutePatterns()

    for (const pathname of [
      CONTROL_ROUTES.usersAndTeams.user('user-1'),
      CONTROL_ROUTES.usersAndTeams.userTab('user-1', 'contact'),
      CONTROL_ROUTES.usersAndTeams.team('team-1'),
      CONTROL_ROUTES.usersAndTeams.teamTab('team-1', 'members'),
      CONTROL_ROUTES.agents.detail('agent-1'),
      CONTROL_ROUTES.agents.tab('agent-1', 'overview'),
      CONTROL_ROUTES.contexts.detail('context-1'),
      CONTROL_ROUTES.contexts.connectors('context-1'),
    ]) {
      expect(resolvesToAppRoute(pathname, redirects, rewrites, appRoutes)).toBe(true)
    }
  })
})
