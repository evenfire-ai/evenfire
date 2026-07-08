import { useAuthContext } from '@contexts/AuthContext'
import { Button, DetailRow } from '@components/Common'

export function UnavailablePage() {
  const { busy, dependencyHealth, setBooting, setStatus, loadSession } = useAuthContext()

  const handleRetry = () => {
    setBooting(true)
    loadSession().catch(error => {
      setStatus(
        `Health recheck failed: ${error instanceof Error ? error.message : String(error)}`,
        'error'
      )
      setBooting(false)
    })
  }

  return (
    <main className="auth-page">
      <section className="auth-card glass-card">
        <h1>Services Unavailable</h1>
        <p className="muted">
          Cannot render authentication because one or more backend services are unavailable.
        </p>
        <DetailRow
          label="external-rest-api"
          value={dependencyHealth?.externalRestApi.ok ? 'healthy' : 'unavailable'}
        />
        <DetailRow
          label="rpc-proxy"
          value={dependencyHealth?.rpcProxy.ok ? 'healthy' : 'unavailable'}
        />
        <Button block disabled={busy} onClick={handleRetry}>
          Retry Health Check
        </Button>
      </section>
    </main>
  )
}
