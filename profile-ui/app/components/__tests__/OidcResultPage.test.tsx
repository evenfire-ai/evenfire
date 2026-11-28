import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { OIDC_GENERIC_RESULT_MESSAGE, OIDC_REFUSAL_MESSAGES } from '@constants/oidc'
import { OIDC_REFUSAL_REASONS, type OidcRefusalReason } from '../../api/oidc/types'
import OidcResultPage from '../../oidc/result/page'

vi.mock('next/image', () => ({
  default: ({ alt = '', ...props }: React.ImgHTMLAttributes<HTMLImageElement>) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img alt={alt} {...props} />
  ),
}))

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

async function renderResult(reason: string | undefined) {
  render(await OidcResultPage({ searchParams: Promise.resolve({ reason }) }))
}

afterEach(cleanup)

describe('OIDC result page', () => {
  it('has one level-1 heading, the brand title, as LoginPanel does', async () => {
    await renderResult('no_account')

    const topHeadings = screen.getAllByRole('heading', { level: 1 })
    expect(topHeadings).toHaveLength(1)
    expect(topHeadings[0]).toHaveTextContent('Evenfire')
    expect(screen.getByRole('heading', { level: 2, name: 'Sign-in unsuccessful' })).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent(OIDC_REFUSAL_MESSAGES.no_account)
  })

  // The scope's message for each refusal code, written out so that a swapped
  // or shared entry in OIDC_REFUSAL_MESSAGES is caught.
  const EXPECTED_MESSAGES: Record<OidcRefusalReason, string> = {
    account_disabled: 'Your account has been disabled. Contact your administrator.',
    identity_conflict:
      'This Evenfire account is linked to another sign-in identity. Contact your administrator.',
    account_needs_attention: 'Your account needs attention. Contact your administrator.',
    email_claim_missing: 'Ask your administrator to enable the email claim for Evenfire.',
    email_unverified:
      "Your sign-in provider hasn't verified your email address. Verify it there, then sign in again.",
    not_eligible: "Your account isn't allowed to sign in to Evenfire. Contact your administrator.",
    no_account: "There's no Evenfire account for this sign-in. Ask your administrator to add you.",
    provider_configuration: "Sign-in isn't configured correctly. Contact your administrator.",
    invitation_email_mismatch: 'This invitation was sent to another address.',
  }

  it('covers every refusal reason', () => {
    expect(Object.keys(EXPECTED_MESSAGES).sort()).toEqual([...OIDC_REFUSAL_REASONS].sort())
  })

  it.each(OIDC_REFUSAL_REASONS)('shows the message for %s', async reason => {
    await renderResult(reason)

    expect(screen.getByRole('alert').textContent).toBe(EXPECTED_MESSAGES[reason])
  })

  it('shows the generic message for an unknown reason', async () => {
    await renderResult('bogus')

    expect(screen.getByRole('alert')).toHaveTextContent(OIDC_GENERIC_RESULT_MESSAGE)
  })
})
