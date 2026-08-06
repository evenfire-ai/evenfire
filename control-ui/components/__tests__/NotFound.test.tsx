import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import GlobalNotFound from '../../app/global-not-found'
import NotFound from '../../app/not-found'
import nextConfig from '../../next.config.js'

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

describe('Control UI not-found rendering', () => {
  it('keeps the route-level not-found content frame-safe', () => {
    const view = render(<NotFound />)

    expect(screen.getByRole('heading', { name: /Page not found/i })).toBeInTheDocument()
    expect(view.container.querySelector('main')).not.toBeInTheDocument()
    expect(view.container.querySelector('.cu-app--auth')).not.toBeInTheDocument()
  })

  it('uses a global not-found page for unmatched routes outside the auth frame', () => {
    expect(nextConfig.experimental?.globalNotFound).toBe(true)

    const view = render(<GlobalNotFound />)

    expect(screen.getByRole('heading', { name: /Page not found/i })).toBeInTheDocument()
    expect(view.container.querySelector('.cu-app--auth')).toBeInTheDocument()
    expect(view.container.querySelector('.cu-app-layout')).not.toBeInTheDocument()
  })
})
