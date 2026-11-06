'use client'

import React from 'react'
import { MarkdownContent } from '@components/MarkdownContent'
import { safeHttpsHref } from '@lib/vanillaMarkdown'
import type { RemoteOAuthSetupGuideProps } from './types'

function consoleLabel(href: string): string {
  return `Open ${new URL(href).hostname}`
}

/**
 * Setup steps for a Marketplace connector that needs the operator's own OAuth app.
 * The guide and the console link come from a registry entry, so both go through the
 * https-only policy; the redirect URI itself is computed by control-api and passed in
 * by the wizard, which is why the guide never carries one.
 */
export function RemoteOAuthSetupGuide({
  guide,
  providerConsoleUrl,
  children,
}: RemoteOAuthSetupGuideProps) {
  const consoleHref = providerConsoleUrl ? safeHttpsHref(providerConsoleUrl) : null
  return (
    <section className="cu-remote-oauth-setup-guide" aria-label="OAuth app setup">
      {guide ? (
        <MarkdownContent
          ariaLabel="Setup guide from the Marketplace curator"
          className="cu-remote-oauth-setup-guide__body"
          emptyMessage=""
          linkPolicy="https-only"
          source={guide}
        />
      ) : null}
      {consoleHref ? (
        <div className="cu-remote-oauth-setup-guide__actions">
          <a
            className="cu-btn cu-btn--ghost cu-btn--sm"
            href={consoleHref}
            rel="noopener noreferrer"
            target="_blank"
          >
            {consoleLabel(consoleHref)}
          </a>
        </div>
      ) : null}
      {children}
    </section>
  )
}
