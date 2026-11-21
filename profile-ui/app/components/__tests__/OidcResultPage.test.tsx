import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { OIDC_GENERIC_RESULT_MESSAGE, OIDC_REFUSAL_MESSAGES } from '@constants/oidc'
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

  it('shows the generic message for an unknown reason', async () => {
    await renderResult('bogus')

    expect(screen.getByRole('alert')).toHaveTextContent(OIDC_GENERIC_RESULT_MESSAGE)
  })
})
