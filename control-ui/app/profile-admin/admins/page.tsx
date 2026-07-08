import { ProfileAdminPageContent } from '../ProfileAdminPageContent'

export default async function ProfileAdminAdminsPage({
  searchParams,
}: {
  searchParams?: Promise<{ highlightAdminId?: string }>
}) {
  const resolvedSearchParams = searchParams ? await searchParams : {}
  return (
    <ProfileAdminPageContent
      activeTab="admins"
      highlightedAdminId={String(resolvedSearchParams.highlightAdminId || '')}
    />
  )
}
