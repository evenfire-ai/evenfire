import { afterEach, describe, expect, it } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { revokeGfsSessionAccess, watchGfsAccessRevocation } from '@lib/gfsSessionAuthority'
import { purgeGfsSessionCache } from '@lib/gfsWatchReaction'

const SCOPE = ':user-a:team-a'
const GEN = 1
const KEY = desktopQueryKeys.gfsAccessState(SCOPE, GEN)

const clients: QueryClient[] = []
function client(seed?: 'active' | 'revoked') {
  const queryClient = new QueryClient()
  clients.push(queryClient)
  if (seed) queryClient.setQueryData(KEY, seed)
  return queryClient
}

afterEach(() => {
  clients.forEach(queryClient => queryClient.clear())
  clients.length = 0
})

describe('watchGfsAccessRevocation', () => {
  it('stays clear while its session flag stays active and other keys change', () => {
    const queryClient = client('active')
    const watch = watchGfsAccessRevocation(queryClient, SCOPE, GEN)
    queryClient.setQueryData(KEY, 'active')
    revokeGfsSessionAccess(queryClient, SCOPE, GEN + 1)
    revokeGfsSessionAccess(queryClient, ':user-b:team-b', GEN)
    expect(watch.revoked()).toBe(false)
  })

  it('latches a revocation that a retry restores to active', () => {
    const queryClient = client('active')
    const watch = watchGfsAccessRevocation(queryClient, SCOPE, GEN)
    revokeGfsSessionAccess(queryClient, SCOPE, GEN)
    queryClient.setQueryData(KEY, 'active')
    expect(queryClient.getQueryData(KEY)).toBe('active')
    expect(watch.revoked()).toBe(true)
  })

  it('latches a purge of the session cache', () => {
    const queryClient = client('active')
    const watch = watchGfsAccessRevocation(queryClient, SCOPE, GEN)
    purgeGfsSessionCache(queryClient, { scope: SCOPE, generation: GEN })
    queryClient.setQueryData(KEY, 'active')
    expect(watch.revoked()).toBe(true)
  })

  it('latches a removed flag even when it is reseeded as active', () => {
    const queryClient = client('active')
    const watch = watchGfsAccessRevocation(queryClient, SCOPE, GEN)
    queryClient.removeQueries({ exact: true, queryKey: KEY })
    expect(watch.revoked()).toBe(true)
    queryClient.setQueryData(KEY, 'active')
    expect(queryClient.getQueryData(KEY)).toBe('active')
    expect(watch.revoked()).toBe(true)
  })

  it('latches a logout that clears the whole cache', () => {
    const queryClient = client('active')
    const watch = watchGfsAccessRevocation(queryClient, SCOPE, GEN)
    queryClient.clear()
    expect(watch.revoked()).toBe(true)
  })

  it('reads revoked when the flag is already revoked at subscribe time', () => {
    const watch = watchGfsAccessRevocation(client('revoked'), SCOPE, GEN)
    expect(watch.revoked()).toBe(true)
  })

  it('reads revoked when the flag is missing at subscribe time', () => {
    const watch = watchGfsAccessRevocation(client(), SCOPE, GEN)
    expect(watch.revoked()).toBe(true)
  })

  it('reads revoked without a session to watch', () => {
    const queryClient = client('active')
    expect(watchGfsAccessRevocation(queryClient, null, GEN).revoked()).toBe(true)
    expect(watchGfsAccessRevocation(queryClient, SCOPE, null).revoked()).toBe(true)
  })

  it('ignores revocations once stopped', () => {
    const queryClient = client('active')
    const watch = watchGfsAccessRevocation(queryClient, SCOPE, GEN)
    watch.stop()
    revokeGfsSessionAccess(queryClient, SCOPE, GEN)
    expect(watch.revoked()).toBe(false)
  })
})
