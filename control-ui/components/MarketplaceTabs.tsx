'use client'

import { CONTROL_ROUTES } from '@constants/routes'
import { TabBar } from './TabBar'

export type MarketplaceSection = 'connectors' | 'credentials' | 'entries' | 'images'

/**
 * Top-level Marketplace navigation (design spec §4): browse registry
 * connectors and manage the deployment-owned registry surfaces as peer tabs.
 */
export function MarketplaceTabs({ active }: { active: MarketplaceSection }) {
  return (
    <TabBar<MarketplaceSection>
      ariaLabel="Marketplace sections"
      activeValue={active}
      className="cu-marketplace-tabs"
      options={[
        {
          value: 'connectors',
          href: CONTROL_ROUTES.marketplace.connectors,
          label: 'Connectors',
        },
        {
          value: 'credentials',
          href: CONTROL_ROUTES.marketplace.orgCredentials,
          label: 'API Keys',
        },
        {
          value: 'entries',
          href: CONTROL_ROUTES.marketplace.orgEntries,
          label: 'Entries',
        },
        {
          value: 'images',
          href: CONTROL_ROUTES.marketplace.orgImages,
          label: 'Images',
        },
      ]}
    />
  )
}
