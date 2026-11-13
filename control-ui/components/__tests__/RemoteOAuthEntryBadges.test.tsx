import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { getRemoteOAuthCatalogBlock } from '../../lib/oauthInstall'
import { CATALOG_SLOTS } from '../../test/fixtures/catalogRemoteOAuthWire'
import { RemoteOAuthEntryBadges } from '../RemoteOAuthSlots'

function view(name: string) {
  const entry = CATALOG_SLOTS.data.find(candidate => candidate.name === name)
  const resolved = getRemoteOAuthCatalogBlock(entry)
  if (!resolved?.valid) throw new Error(`${name} is not a valid remote-OAuth entry`)
  return resolved
}

afterEach(cleanup)

describe('RemoteOAuthEntryBadges', () => {
  it('links the console of a curator pre-registered entry', () => {
    render(<RemoteOAuthEntryBadges view={view('@evenfire/workiq-remote')} />)
    expect(screen.getByRole('link', { name: 'Open entra.microsoft.com' })).toBeInTheDocument()
  })

  it('never links a console on an org entry, even if one slipped through', () => {
    const org = view('@acme/linear-pre')
    // control-api strips the console from org entries; this is the case where a
    // response still carried one.
    const smuggled = {
      ...org,
      block: { ...org.block, providerConsoleUrl: 'https://acme.example.com/console' },
    }
    render(<RemoteOAuthEntryBadges view={smuggled} />)
    expect(screen.getByText('Requires your OAuth app')).toBeInTheDocument()
    expect(screen.queryByRole('link')).toBeNull()
  })
})
