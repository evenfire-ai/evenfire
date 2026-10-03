import type { Page } from '@playwright/test'
import path from 'node:path'

/** Observer only: negative guards own waitForResponse on the real auth probe. */
export function isProtectedSubscriptionBusinessPath(pathname: string): boolean {
  return /^\/api\/v1\/admin\/(?:llm\/providers\/(?:codex-subscription|grok-subscription)(?:\/|$)|(?:hosts|agents)(?:\/|$)|llm-models(?:\/|$))/.test(
    pathname
  )
}
export function observeProtectedSubscriptionBusinessAccess(page: Page): string[] {
  const attempted: string[] = []
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname
    if (isProtectedSubscriptionBusinessPath(pathname))
      attempted.push(`${request.method()} ${pathname}`)
  })
  return attempted
}
export function requireSubscriptionAdmissionGuardEnv(env: NodeJS.ProcessEnv = process.env): {
  url: string
  context: string
  outputDir: string
} {
  if (env.E2E_SUBSCRIPTION_ADMISSION_GUARDS !== '1')
    throw new Error('Subscription admission guards require E2E_SUBSCRIPTION_ADMISSION_GUARDS=1')
  const context = env.CONTROL_API_REAL_PG_CONTEXT?.trim()
  if (
    !context ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(context) ||
    context !== env.MINIKUBE_PROFILE ||
    context === 'clerum-test' ||
    /(^|[-_])(prod|production)([-_]|$)/i.test(context)
  ) {
    throw new Error(
      'Subscription admission guards require an explicit owned development profile/context'
    )
  }
  const raw = env.CONTROL_UI_URL?.trim() || env.CONTROL_UI_BASE_URL?.trim()
  if (!raw)
    throw new Error('Subscription admission guards require an explicit owned Control UI URL')
  const url = new URL(raw)
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
    !url.port ||
    url.port === '3000' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['', '/'].includes(url.pathname)
  ) {
    throw new Error('Subscription admission guards require an owned loopback port')
  }
  const outputDir = env.E2E_SUBSCRIPTION_ADMISSION_OUTPUT_DIR?.trim()
  if (!outputDir || !path.isAbsolute(outputDir))
    throw new Error(
      'Subscription admission guards require an explicit absolute E2E_SUBSCRIPTION_ADMISSION_OUTPUT_DIR'
    )
  return { url: url.origin, context, outputDir: path.resolve(outputDir) }
}
