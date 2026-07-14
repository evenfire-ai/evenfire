export type ProfileAdminTab = 'teams' | 'users' | 'admins'

export type ProfileAdminHomeProps = {
  activeTab: ProfileAdminTab
  highlightedAdminId?: string
}
