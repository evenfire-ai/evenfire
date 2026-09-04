import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MarketplaceTabs } from '../MarketplaceTabs'

describe('MarketplaceTabs', () => {
  it('flattens org-owned surfaces into top-level marketplace tabs', () => {
    render(<MarketplaceTabs active="credentials" />)

    const tabs = screen.getByRole('tablist', { name: 'Marketplace sections' })
    expect(within(tabs).getByRole('tab', { name: 'Connectors' })).toHaveAttribute(
      'href',
      '/marketplace/connectors'
    )
    expect(within(tabs).getByRole('tab', { name: 'API Keys' })).toHaveAttribute(
      'href',
      '/marketplace/org/credentials'
    )
    expect(within(tabs).getByRole('tab', { name: 'Entries' })).toHaveAttribute(
      'href',
      '/marketplace/org/entries'
    )
    expect(within(tabs).getByRole('tab', { name: 'Images' })).toHaveAttribute(
      'href',
      '/marketplace/org/images'
    )
    expect(within(tabs).queryByRole('tab', { name: /^@/ })).toBeNull()
  })
})
