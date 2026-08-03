'use client'

import type { ReactNode } from 'react'
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { useAuth } from '@components/AuthContext'
import { isSilentApiError } from '@lib/api'
import {
  readProfileAccessCache,
  requestApprovalTargets,
  requestManageableTeams,
} from '@lib/profileAccess'
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
  const cached = readProfileAccessCache(userId)
  const [manageableTeams, setManageableTeams] = useState<ManageableTeam[]>(
    () => cached.manageableTeams ?? []
  )
  const [approvalTargets, setApprovalTargets] = useState<ApprovalChannelTarget[]>(
    () => cached.approvalTargets ?? []
  )
  const [manageableTeamsLoading, setManageableTeamsLoading] = useState(
    () => !cached.manageableTeams
  )
  const [approvalTargetsLoading, setApprovalTargetsLoading] = useState(
    () => !cached.approvalTargets
  )
  const [manageableTeamsError, setManageableTeamsError] = useState(false)
  const [approvalTargetsError, setApprovalTargetsError] = useState(false)

  const refreshManageableTeams = useCallback(
    async (options: RefreshOptions = {}) => {
      if (!userId) return []
      setManageableTeamsLoading(true)
      setManageableTeamsError(false)
      try {
        const teams = await requestManageableTeams(userId, options)
        setManageableTeams(teams)
        return teams
      } catch (error) {
        if (!isSilentApiError(error)) setManageableTeamsError(true)
        throw error
      } finally {
        setManageableTeamsLoading(false)
      }
    },
    [userId]
  )

  const refreshApprovalTargets = useCallback(
    async (options: RefreshOptions = {}) => {
      if (!userId) return []
      setApprovalTargetsLoading(true)
      setApprovalTargetsError(false)
      try {
        const targets = await requestApprovalTargets(userId, options)
        setApprovalTargets(targets)
        return targets
      } catch (error) {
        if (!isSilentApiError(error)) setApprovalTargetsError(true)
        throw error
      } finally {
        setApprovalTargetsLoading(false)
      }
    },
    [userId]
  )

  useEffect(() => {
    if (!userId) return
    void refreshManageableTeams().catch(() => undefined)
    void refreshApprovalTargets().catch(() => undefined)
  }, [refreshApprovalTargets, refreshManageableTeams, userId])

  const activeRoleCanManage = authState.me?.role === 'admin' || authState.me?.role === 'inviter'
  const value = useMemo<ProfileAccessContextValue>(
    () => ({
      approvalTargets,
      approvalTargetsError,
      approvalTargetsLoading,
      canManageMembers: activeRoleCanManage || manageableTeams.length > 0,
      manageableTeams,
      manageableTeamsError,
      manageableTeamsLoading,
      refreshApprovalTargets,
      refreshManageableTeams,
    }),
    [
      activeRoleCanManage,
      approvalTargets,
      approvalTargetsError,
      approvalTargetsLoading,
      manageableTeams,
      manageableTeamsError,
      manageableTeamsLoading,
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
