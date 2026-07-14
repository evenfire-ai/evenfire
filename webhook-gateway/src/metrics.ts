/**
 * Tiny Prometheus exposition-format emitter. We don't pull in
 * prom-client because the metric set is small (5 counters + 1 gauge +
 * 1 histogram bucket-set) and the dependency footprint matters for a
 * service that runs once per recipe.
 */
export class Metrics {
  private requestsTotal = new Map<string, number>() // key: webhookId|status
  private verifyTotal = new Map<string, number>() // key: webhookId|scheme|outcome
  private bodyBytes = new Map<string, number[]>() // webhookId → samples
  private inFlight = new Map<string, number>() // webhookId → current

  recordRequest(webhookId: string, status: number): void {
    const key = `${webhookId}|${status}`
    this.requestsTotal.set(key, (this.requestsTotal.get(key) ?? 0) + 1)
  }

  recordVerify(webhookId: string, scheme: string, outcome: string): void {
    const key = `${webhookId}|${scheme}|${outcome}`
    this.verifyTotal.set(key, (this.verifyTotal.get(key) ?? 0) + 1)
  }

  recordBodyBytes(webhookId: string, bytes: number): void {
    const arr = this.bodyBytes.get(webhookId) ?? []
    arr.push(bytes)
    this.bodyBytes.set(webhookId, arr)
  }

  incInFlight(webhookId: string): number {
    const n = (this.inFlight.get(webhookId) ?? 0) + 1
    this.inFlight.set(webhookId, n)
    return n
  }

  decInFlight(webhookId: string): void {
    const n = (this.inFlight.get(webhookId) ?? 0) - 1
    if (n <= 0) this.inFlight.delete(webhookId)
    else this.inFlight.set(webhookId, n)
  }

  totalInFlight(): number {
    let n = 0
    for (const v of this.inFlight.values()) n += v
    return n
  }

  toPrometheus(): string {
    const lines: string[] = []
    lines.push('# HELP webhook_gateway_requests_total Total inbound webhook requests by status')
    lines.push('# TYPE webhook_gateway_requests_total counter')
    for (const [key, value] of this.requestsTotal) {
      const [webhookId, status] = key.split('|')
      lines.push(
        `webhook_gateway_requests_total{webhook_id="${escapeLabel(webhookId)}",status="${status}"} ${value}`
      )
    }
    lines.push('# HELP webhook_gateway_verify_total Verifier outcomes by scheme')
    lines.push('# TYPE webhook_gateway_verify_total counter')
    for (const [key, value] of this.verifyTotal) {
      const [webhookId, scheme, outcome] = key.split('|')
      lines.push(
        `webhook_gateway_verify_total{webhook_id="${escapeLabel(webhookId)}",scheme="${escapeLabel(scheme)}",outcome="${escapeLabel(outcome)}"} ${value}`
      )
    }
    lines.push('# HELP webhook_gateway_in_flight Current in-flight requests')
    lines.push('# TYPE webhook_gateway_in_flight gauge')
    for (const [webhookId, value] of this.inFlight) {
      lines.push(`webhook_gateway_in_flight{webhook_id="${escapeLabel(webhookId)}"} ${value}`)
    }
    lines.push('# HELP webhook_gateway_body_bytes_summary Inbound body sizes (last sample only in v1)')
    lines.push('# TYPE webhook_gateway_body_bytes_summary gauge')
    for (const [webhookId, samples] of this.bodyBytes) {
      const last = samples[samples.length - 1]
      if (last !== undefined) {
        lines.push(
          `webhook_gateway_body_bytes_summary{webhook_id="${escapeLabel(webhookId)}"} ${last}`
        )
      }
    }
    return lines.join('\n') + '\n'
  }
}

function escapeLabel(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}
