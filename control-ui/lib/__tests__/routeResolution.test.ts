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

  return pathname === rule.source ? rule.destination : null
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
})
