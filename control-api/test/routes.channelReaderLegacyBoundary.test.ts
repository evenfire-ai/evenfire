import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const srcRoot = fileURLToPath(new URL('../src/', import.meta.url))

function sourcePath(relativePath: string): string {
  return join(srcRoot, relativePath)
}

function readSource(relativePath: string): string {
  return readFileSync(sourcePath(relativePath), 'utf8')
}

function sourceExists(relativePath: string): boolean {
  return existsSync(sourcePath(relativePath))
}

function collectTypeScriptFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) return collectTypeScriptFiles(path)
    return entry.endsWith('.ts') ? [path] : []
  })
}

function allControlApiSource(): string {
  return collectTypeScriptFiles(srcRoot)
    .map(path => readFileSync(path, 'utf8'))
    .join('\n')
}

describe('channel-reader legacy control-api approval boundary', () => {
  it('removes the legacy internal route modules instead of keeping compatibility shims', () => {
    expect(sourceExists('routes/internal/notifications.ts')).toBe(false)
    expect(sourceExists('routes/internal/workflowApprovalMediums.ts')).toBe(false)
  })

  it('does not mount legacy channel-reader approval routers in the control-api app', () => {
    const app = readSource('app.ts')

    expect(app).not.toContain('createInternalNotificationsRouter')
    expect(app).not.toContain('createInternalWorkflowApprovalMediumsRouter')
    expect(app).not.toContain("requireInternalService('channel-reader')")
  })

  it('keeps the approval delivery, resolve, and Telegram confirmation surface on mcp-host JWT routes', () => {
    const routes = readSource('routes/mcp-host/user-approval-requests.routes.ts')

    expect(routes).toContain('requireMcpHostControlWorkflowCaller')
    expect(routes).toContain('/workflow-approval-notifications/deliveries')
    expect(routes).toContain('/workflow-approval-notifications/deliveries/:id/ack')
    expect(routes).toContain('/workflow-approval-notifications/deliveries/:id/fail')
    expect(routes).toContain(
      '/workflow-approval-mediums/telegram/challenges/confirm-provider-event'
    )
    expect(routes).toContain('/workflow-approvals/pending/resolve')
  })

  it('has no production source route that accepts channel-reader service auth for approval handling', () => {
    const source = allControlApiSource()

    expect(source).not.toContain("requireInternalService('channel-reader')")
    expect(source).not.toContain('/internal/notifications')
    expect(source).not.toContain('/internal/workflow-approval-mediums')
  })
})
