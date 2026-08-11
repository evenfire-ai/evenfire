'use client'

import { CONTROL_ROUTES } from '@constants/routes'
import { useRegistryCapability } from '../lib/hooks/useRegistryCapability'
import { TabBar } from './TabBar'

export type MarketplaceSection = 'connectors' | 'org'

/**
 * Top-level Marketplace navigation (design spec §4): browse (Connectors) and
 * own (the org-named tab). The org tab is labelled with the organization name,
 * or "Your org" before the deployment is claimed — a single element that
 * answers "who are we on the registry".
 */
export function MarketplaceTabs({ active }: { active: MarketplaceSection }) {
  const { capability, loading } = useRegistryCapability()
  // Avoid flashing the misleading "Your org" (which reads as unclaimed) before
  // the identity resolves; show a neutral label while loading instead.
  const orgLabel = capability?.orgName
    ? `@${capability.orgName}`
    : loading
      ? 'Organization'
      : 'Your org'

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
          value: 'org',
          href: CONTROL_ROUTES.marketplace.orgCredentials,
          label: orgLabel,
        },
      ]}
    />
  )
}
