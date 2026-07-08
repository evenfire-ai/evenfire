import { AuthGate } from '@components/AuthGate'
import { DashboardLayout } from '@components/DashboardLayout'
import RegistryCatalog from '@components/RegistryCatalog'

export default function RegistryPage() {
  return (
    <AuthGate>
      <DashboardLayout>
        <RegistryCatalog />
      </DashboardLayout>
    </AuthGate>
  )
}
