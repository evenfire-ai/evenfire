'use client'

import type { ReactNode } from 'react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '@components/AuthContext'
import { isSilentApiError } from '@lib/api'
import { requestApprovalTargets, requestManageableTeams } from '@lib/profileAccess'
import {
  type ProfileAccessDataState,
  canManageMembersForAccess,
  profileAccessStateAfterApprovalTargetsError,
  profileAccessStateAfterManageableTeamsError,
  profileAccessStateForUser,
} from '@lib/profileAccessState'
import type { ApprovalChannelTarget } from '@/app/types/approvalChannels'
import type { ManageableTeam } from '@/app/types/profile'

type RefreshOptions = { force?: boolean }

type ProfileAccessContextValue = {
  approvalTargets: ApprovalChannelTarget[]
  approvalTargetsError: boolean
  approvalTargetsLoading: boolean
  canManageMembers: boolean
  manageableTeams: ManageableTeam[]
  manageableTeamsError: boolean
  manageableTeamsLoading: boolean
  refreshApprovalTargets: (options?: RefreshOptions) => Promise<ApprovalChannelTarget[]>
  refreshManageableTeams: (options?: RefreshOptions) => Promise<ManageableTeam[]>
}

const ProfileAccessContext = createContext<ProfileAccessContextValue | null>(null)

export function ProfileAccessProvider({ children }: { children: ReactNode }) {
  const { authState } = useAuth()
  const userId = authState.me?.id || ''
  const [accessState, setAccessState] = useState<ProfileAccessDataState & { userId: string }>(
    () => ({
      userId,
      ...profileAccessStateForUser(userId),
    })
  )
  const activeUserIdRef = useRef(userId)

  const currentAccessState =
    accessState.userId === userId ? accessState : { userId, ...profileAccessStateForUser(userId) }

  const refreshManageableTeams = useCallback(
    async (options: RefreshOptions = {}) => {
      if (!userId) return []
      setAccessState(prev => ({
        ...(prev.userId === userId ? prev : { userId, ...profileAccessStateForUser(userId) }),
        manageableTeamsLoading: true,
        manageableTeamsError: false,
      }))
      try {
        const teams = await requestManageableTeams(userId, options)
        if (activeUserIdRef.current === userId) {
          setAccessState(prev => ({
            ...(prev.userId === userId ? prev : { userId, ...profileAccessStateForUser(userId) }),
            manageableTeams: teams,
            manageableTeamsError: false,
            manageableTeamsLoading: false,
          }))
        }
        return teams
      } catch (error) {
        if (activeUserIdRef.current === userId) {
          setAccessState(prev => ({
            userId,
            ...profileAccessStateAfterManageableTeamsError(
              prev.userId === userId ? prev : profileAccessStateForUser(userId)
            ),
            manageableTeamsError: !isSilentApiError(error),
          }))
        }
        throw error
      }
    },
    [userId]
  )

  const refreshApprovalTargets = useCallback(
    async (options: RefreshOptions = {}) => {
      if (!userId) return []
      setAccessState(prev => ({
        ...(prev.userId === userId ? prev : { userId, ...profileAccessStateForUser(userId) }),
        approvalTargetsLoading: true,
        approvalTargetsError: false,
      }))
      try {
        const targets = await requestApprovalTargets(userId, options)
        if (activeUserIdRef.current === userId) {
          setAccessState(prev => ({
            ...(prev.userId === userId ? prev : { userId, ...profileAccessStateForUser(userId) }),
            approvalTargets: targets,
            approvalTargetsError: false,
            approvalTargetsLoading: false,
          }))
        }
        return targets
      } catch (error) {
        if (activeUserIdRef.current === userId) {
          setAccessState(prev => ({
            userId,
            ...profileAccessStateAfterApprovalTargetsError(
              prev.userId === userId ? prev : profileAccessStateForUser(userId)
            ),
            approvalTargetsError: !isSilentApiError(error),
          }))
        }
        throw error
      }
    },
    [userId]
  )

  useEffect(() => {
    activeUserIdRef.current = userId
    const next = profileAccessStateForUser(userId)
    setAccessState({ userId, ...next })
    if (!userId) return
    if (next.manageableTeamsLoading) void refreshManageableTeams().catch(() => undefined)
    if (next.approvalTargetsLoading) void refreshApprovalTargets().catch(() => undefined)
  }, [refreshApprovalTargets, refreshManageableTeams, userId])

  const value = useMemo<ProfileAccessContextValue>(
    () => ({
      approvalTargets: currentAccessState.approvalTargets,
      approvalTargetsError: currentAccessState.approvalTargetsError,
      approvalTargetsLoading: currentAccessState.approvalTargetsLoading,
      canManageMembers: canManageMembersForAccess(
        authState.me?.role,
        currentAccessState.manageableTeams
      ),
      manageableTeams: currentAccessState.manageableTeams,
      manageableTeamsError: currentAccessState.manageableTeamsError,
      manageableTeamsLoading: currentAccessState.manageableTeamsLoading,
      refreshApprovalTargets,
      refreshManageableTeams,
    }),
    [
      authState.me?.role,
      currentAccessState.approvalTargets,
      currentAccessState.approvalTargetsError,
      currentAccessState.approvalTargetsLoading,
      currentAccessState.manageableTeams,
      currentAccessState.manageableTeamsError,
      currentAccessState.manageableTeamsLoading,
      refreshApprovalTargets,
      refreshManageableTeams,
    ]
  )

  return <ProfileAccessContext.Provider value={value}>{children}</ProfileAccessContext.Provider>
}

export function useProfileAccess(): ProfileAccessContextValue {
  const value = useContext(ProfileAccessContext)
  if (!value) throw new Error('useProfileAccess must be used within a ProfileAccessProvider')
  return value
}
