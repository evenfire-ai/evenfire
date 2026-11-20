import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useAuthContext } from '@contexts/AuthContext'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { gfsAuthorityQueryPolicy } from '@lib/gfsAuthorityQueryPolicy'
import { describeGfsReadError, isGfsSessionAuthorityFailure } from '@lib/gfsGrantErrors'
import { gfsSessionScope } from '@lib/gfsSessionAuthority'
import type { GfsAccessState } from '@lib/gfsSessionAuthority.types'
import type {
  GfsGrantListItem,
  GfsInheritedAccessResult,
  GfsShareListItem,
} from '@/gfs/delegation.types'
import { deriveGfsInheritedAccess } from '@/gfs/inheritedAccess'
import { desktopQueryKeys, isGfsSessionAuthorityCurrent, isGfsSessionGeneration } from './queryKeys'
import type {
  GfsAccessMutationAuthority,
  GfsAccessTarget,
  GfsResourceAccessOptions,
} from './useGfsResourceAccess.types'

const DRIVE = 'main'

type GfsAclKey = (
  sessionScope: string,
  resourceId: string,
  drive: string,
  generation?: number | null
) => readonly unknown[]

interface GfsTargetAuthority {
  held: string[]
  canDelegate: boolean
  grantableBits: string[]
  canCreateShare: boolean
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Sharing state of one explicit resource: its direct grants and shares, the
 * access it inherits from ancestor folders, and the writes that change them.
 * The keys stay in the session-scoped ACL families so the watch's access
 * refresh re-reads an open dialog. While `gate` is set the owner has not
 * re-proved the session, so cached rows are withheld.
 */
export function useGfsResourceAccess(
  target: GfsAccessTarget | null,
  gate: boolean,
  { handleAuthorityFailure }: GfsResourceAccessOptions
) {
  const queryClient = useQueryClient()
  const auth = useAuthContext()
  const sessionScope = gfsSessionScope(auth)
  const sessionGeneration = isGfsSessionGeneration(auth.sessionGeneration)
    ? auth.sessionGeneration
    : null
  const liveSessionScopeRef = useRef(sessionScope)
  liveSessionScopeRef.current = sessionScope
  const liveSessionGenerationRef = useRef(sessionGeneration)
  liveSessionGenerationRef.current = sessionGeneration

  // A pure subscription to the shared access flag: a revoked session must not
  // re-read ACLs, and only a fail-closed boundary or a retry ever writes it.
  const accessStateQuery = useQuery({
    queryKey: desktopQueryKeys.gfsAccessState(sessionScope ?? 'anonymous', sessionGeneration),
    queryFn: () => 'active' as GfsAccessState,
    enabled: false,
    initialData: 'active' as GfsAccessState,
    gcTime: Infinity,
    staleTime: Infinity,
  })
  const accessState: GfsAccessState =
    sessionGeneration === null ? 'revoked' : (accessStateQuery.data ?? 'active')

  const resourceId = target?.resourceId ?? null
  const enabled =
    Boolean(sessionScope) &&
    sessionGeneration !== null &&
    Boolean(resourceId) &&
    accessState === 'active'
  const keyFor = (family: GfsAclKey) =>
    family(sessionScope ?? 'anonymous', resourceId ?? '', DRIVE, sessionGeneration)

  // The caller's own authority on the target decides what the dialog offers.
  // It shares its key with every browser observer of the same resource, so a
  // target that is also the open location is not read twice; the open
  // revalidation below is the one read the dialog adds.
  const affordancesQuery = useQuery({
    queryKey: keyFor(desktopQueryKeys.gfsAffordances),
    queryFn: () => window.clerum.gfs.affordances(resourceId!, DRIVE),
    enabled,
    ...gfsAuthorityQueryPolicy,
    refetchOnMount: false,
  })
  // The ACL lists mount each time Share opens. Under the app default
  // (`refetchOnMount: false`) a list the watch or a write invalidated while
  // Share was closed would reopen from cache; `true` re-reads only what is
  // stale, so a list nothing invalidated is not read again on every open.
  // The grants listing is the revoke-id source (the grant PUT returns no ids),
  // so writes must refetch it.
  const grantsQuery = useQuery({
    queryKey: keyFor(desktopQueryKeys.gfsGrants),
    queryFn: () => window.clerum.gfs.listGrants(resourceId!, DRIVE),
    enabled,
    refetchOnMount: true,
  })
  // Direct URI shares are a separate server surface ("this route is never
  // inferred from grants"), so the revoke-id source for shares is this list.
  const sharesQuery = useQuery({
    queryKey: keyFor(desktopQueryKeys.gfsShares),
    queryFn: () => window.clerum.gfs.listShares(resourceId!, DRIVE),
    enabled,
    refetchOnMount: true,
  })
  // Inherited access is derived client-side because the grants/shares GETs
  // list only direct rows. A walk stop is reported as coverage; only a raw
  // session 401 (or a throw the walk cannot classify) reaches the error.
  const inheritedAccessQuery = useQuery({
    queryKey: keyFor(desktopQueryKeys.gfsInheritedAccess),
    queryFn: () => deriveGfsInheritedAccess(resourceId!, DRIVE),
    enabled,
    refetchOnMount: true,
    // An 'unavailable' coverage is a FAILED walk, not an observation: it is
    // stale at once, so reopening Share retries it instead of showing the
    // failure as if it were authoritative.
    staleTime: query =>
      (query.state.data as GfsInheritedAccessResult | undefined)?.coverage === 'unavailable'
        ? 0
        : Infinity,
  })

  // A refetch after revocation is the normal way the loss is discovered under
  // Infinity staleTime; per-resource verdicts (403/404) stay with the dialog.
  const authorityErrorMessage =
    [affordancesQuery.error, grantsQuery.error, sharesQuery.error, inheritedAccessQuery.error]
      .filter(error => error !== null)
      .map(toMessage)
      .find(message => isGfsSessionAuthorityFailure(message, 'operation')) ?? null
  useEffect(() => {
    if (!authorityErrorMessage || accessState === 'revoked') return
    handleAuthorityFailure(authorityErrorMessage, 'operation', sessionScope, sessionGeneration)
  }, [accessState, authorityErrorMessage, handleAuthorityFailure, sessionScope, sessionGeneration])

  const invalidateAcl = useCallback(
    async (
      family: GfsAclKey,
      aclResourceId: string,
      scope: string | null,
      generation: number | null
    ) => {
      if (
        !scope ||
        !isGfsSessionAuthorityCurrent(
          scope,
          generation,
          liveSessionScopeRef.current,
          liveSessionGenerationRef.current
        )
      ) {
        return
      }
      await queryClient.invalidateQueries({
        exact: true,
        queryKey: family(scope, aclResourceId, DRIVE, generation),
      })
    },
    [queryClient]
  )
  const refreshFamily = useCallback(
    async (family: GfsAclKey) => {
      if (!resourceId) return
      await invalidateAcl(family, resourceId, sessionScope, sessionGeneration)
    },
    [invalidateAcl, resourceId, sessionScope, sessionGeneration]
  )
  const refreshGrants = useCallback(
    () => refreshFamily(desktopQueryKeys.gfsGrants),
    [refreshFamily]
  )
  const refreshShares = useCallback(
    () => refreshFamily(desktopQueryKeys.gfsShares),
    [refreshFamily]
  )
  const refreshInheritedAccess = useCallback(
    () => refreshFamily(desktopQueryKeys.gfsInheritedAccess),
    [refreshFamily]
  )
  // A cached result may predate a permission change, so opening the dialog
  // re-reads it; with nothing cached the observer's first load already is
  // that read, and invalidating would restart it.
  const revalidateAffordances = useCallback(async () => {
    if (!resourceId || !sessionScope) return
    const key = desktopQueryKeys.gfsAffordances(sessionScope, resourceId, DRIVE, sessionGeneration)
    if (queryClient.getQueryState(key)?.data === undefined) return
    if (
      !isGfsSessionAuthorityCurrent(
        sessionScope,
        sessionGeneration,
        liveSessionScopeRef.current,
        liveSessionGenerationRef.current
      )
    ) {
      return
    }
    await queryClient.invalidateQueries({ exact: true, queryKey: key, refetchType: 'active' })
  }, [queryClient, resourceId, sessionScope, sessionGeneration])
  const retry = useCallback(
    () => Promise.all([refreshGrants(), refreshShares(), refreshInheritedAccess()]).then(() => {}),
    [refreshGrants, refreshInheritedAccess, refreshShares]
  )

  // Each write is judged against the session it was issued under: a late
  // rejection from a session that was already replaced must not revoke the one
  // that replaced it.
  const captureAuthority = (aclTarget: GfsAccessTarget): GfsAccessMutationAuthority => ({
    resourceId: aclTarget.resourceId,
    authorityScope: liveSessionScopeRef.current,
    authorityGeneration: liveSessionGenerationRef.current,
  })
  const failClosedOnMutationError = (error: unknown, input: GfsAccessMutationAuthority) => {
    handleAuthorityFailure(
      toMessage(error),
      'operation',
      input.authorityScope,
      input.authorityGeneration
    )
  }

  // The ACL writes never wait for the renderer's online flag: main owns the
  // network, and a write paused offline would run later, after its caller's
  // session check, possibly under another session (or never settle once a
  // logout clears the mutation cache).
  // `inherit` omitted defaults to `true` on the wire, so user/team grants
  // cover folder contents; a contents-excluding grant passes `false`.
  const grantMutation = useMutation({
    networkMode: 'always',
    mutationFn: (
      input: GfsAccessMutationAuthority & {
        subjectKeys: string[]
        bits: string[]
        inherit?: boolean
      }
    ) =>
      window.clerum.gfs.grant(
        input.resourceId,
        input.subjectKeys,
        input.bits,
        DRIVE,
        input.inherit
      ),
    onError: failClosedOnMutationError,
  })
  const revokeGrantMutation = useMutation({
    networkMode: 'always',
    mutationFn: (input: GfsAccessMutationAuthority & { grantId: string }) =>
      window.clerum.gfs.revokeGrant(input.grantId),
    onSuccess: (_result, input) =>
      invalidateAcl(
        desktopQueryKeys.gfsGrants,
        input.resourceId,
        input.authorityScope,
        input.authorityGeneration
      ),
    onError: failClosedOnMutationError,
  })
  const revokeShareMutation = useMutation({
    networkMode: 'always',
    mutationFn: (input: GfsAccessMutationAuthority & { shareId: string }) =>
      window.clerum.gfs.revokeShare(input.shareId),
    onSuccess: (_result, input) =>
      invalidateAcl(
        desktopQueryKeys.gfsShares,
        input.resourceId,
        input.authorityScope,
        input.authorityGeneration
      ),
    onError: failClosedOnMutationError,
  })

  const grants = useMemo<GfsGrantListItem[]>(
    () => (gate ? [] : (grantsQuery.data ?? [])),
    [gate, grantsQuery.data]
  )
  const shares = useMemo<GfsShareListItem[]>(
    () => (gate ? [] : (sharesQuery.data ?? [])),
    [gate, sharesQuery.data]
  )
  const inheritedAccess = useMemo(
    () => (gate ? [] : (inheritedAccessQuery.data?.items ?? [])),
    [gate, inheritedAccessQuery.data]
  )

  return {
    affordances: gate ? null : ((affordancesQuery.data as GfsTargetAuthority | undefined) ?? null),
    affordancesError: affordancesQuery.error
      ? describeGfsReadError(affordancesQuery.error).message
      : null,
    loadingAffordances: affordancesQuery.isFetching,
    revalidateAffordances,
    grants,
    // Raw error so the dialog can map server codes: a manage_acl_required 403
    // renders as a quiet banner, not an error.
    grantsError: grantsQuery.error,
    loadingGrants: grantsQuery.isFetching,
    refreshGrants,
    shares,
    sharesError: sharesQuery.error,
    loadingShares: sharesQuery.isFetching,
    refreshShares,
    inheritedAccess,
    // Coverage describes the observation; a gated session empties the rows
    // above instead.
    inheritedCoverage: inheritedAccessQuery.data?.coverage ?? null,
    loadingInheritedAccess: inheritedAccessQuery.isFetching,
    inheritedAccessError: inheritedAccessQuery.error ? toMessage(inheritedAccessQuery.error) : null,
    refreshInheritedAccess,
    /** Re-reads every ACL list of the target after a failed load. */
    retry,
    // Delegation writes throw on server rejection (e.g. 403
    // escalation_rejected); the caller surfaces that, never swallow it.
    grant: (aclTarget: GfsAccessTarget, subjectKeys: string[], bits: string[], inherit?: boolean) =>
      grantMutation.mutateAsync({ ...captureAuthority(aclTarget), subjectKeys, bits, inherit }),
    revokeGrant: (aclTarget: GfsAccessTarget, grantId: string) =>
      revokeGrantMutation.mutateAsync({ ...captureAuthority(aclTarget), grantId }),
    revoking: revokeGrantMutation.isPending,
    revokeShare: (aclTarget: GfsAccessTarget, shareId: string) =>
      revokeShareMutation.mutateAsync({ ...captureAuthority(aclTarget), shareId }),
    revokingShare: revokeShareMutation.isPending,
  }
}
