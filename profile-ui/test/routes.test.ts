import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { SANDBOX_UI_WEB_LINK_PATH } from '@clerum/desktop-app-links'
import { PROFILE_ROUTES } from '../app/constants/routes'

function collectRoutePaths(value: unknown): string[] {
  if (typeof value === 'string') return [new URL(value, 'http://app.local').pathname]

  if (typeof value === 'function') {
    const result = value('sample', 'sample', 'sample')
    return typeof result === 'string' ? [new URL(result, 'http://app.local').pathname] : []
  }

  if (!value || typeof value !== 'object') return []
  return Object.values(value).flatMap(collectRoutePaths)
}

function appRoutePatterns(): RegExp[] {
  const appDirectory = path.join(process.cwd(), 'app')
  const routeFiles: string[] = []

  function visit(directory: string) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(entryPath)
      else if (/^(?:page|route)\.(?:js|jsx|ts|tsx)$/.test(entry.name)) routeFiles.push(entryPath)
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

test('PROFILE_ROUTES resolve to App Router pages or route handlers', () => {
  const appRoutes = appRoutePatterns()
  const routePaths = [...new Set(collectRoutePaths(PROFILE_ROUTES))]
  const unresolved = routePaths.filter(route => !appRoutes.some(pattern => pattern.test(route)))

  assert.deepEqual(unresolved, [])
})

test('desktop app route stays aligned with the shared handoff contract', () => {
  assert.equal(
    PROFILE_ROUTES.openDesktopApp('sandbox-recipes', 'task-board'),
    `${SANDBOX_UI_WEB_LINK_PATH}/sandbox-recipes/task-board`
  )
})
