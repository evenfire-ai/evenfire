/**
 * issue #299 Phase 2 — background cron for the provider-netblocks fetch pipeline.
 *
 * Startup-independent (§5): the first run is deferred ~60s and the seed CM covers
 * cold start. Self-rescheduling with ±10% jitter (§7). Timers are unref()'d so a
 * pending tick never keeps the process alive. Uses its OWN k8s client
 * (loadFromDefault) and its OWN bounded HTTP client — never a request-serving
 * instance (§1). The cron is only started when the kill switch is on (§8, main.ts).
 */
import * as k8s from '@kubernetes/client-node'
import { pool } from '../../db.js'
import {
  providerNetblocksCidrs,
  providerNetblocksFetchFailuresTotal,
  providerNetblocksLastSuccessTimestampSeconds,
  providerNetblocksTicksTotal,
} from '../../observability/metrics.js'
import type { FetchHttp } from './fetcherTypes.js'
import { githubFetcher } from './githubFetcher.js'
import { K8sProviderNetblocksCmStore } from './providerNetblocksConfigMap.js'
import { type TickMetrics, runProviderNetblocksTick } from './providerNetblocksService.js'

export interface ProviderNetblocksCronOptions {
  intervalMs: number
  timeoutMs: number
  maxResponseBytes: number
  namespace: string
}

let timer: NodeJS.Timeout | null = null
let inFlight = false
// Guards the re-arm inside schedule()'s .finally: if stop() runs while a tick is
// in flight, clearing the timer is not enough — the in-flight runOnce would
// re-schedule afterward. Checked in schedule(), set by stop(), reset by start().
let stopped = false

function metricsAdapter(): TickMetrics {
  return {
    tick: result => providerNetblocksTicksTotal.inc({ result }),
    // A 304 (not_modified) is a normal, successful conditional GET — not a
    // failure. It records an `ok` tick and bumps the per-source lastSuccess gauge
    // (the `unchanged` branch), never the failure counter; it is intentionally not
    // logged per-tick to avoid steady-state noise. fetchOutcome is an observation
    // hook the production adapter does not need (kept for alternate adapters).
    fetchOutcome: () => {},
    fetchFailure: (source, reason) => providerNetblocksFetchFailuresTotal.inc({ source, reason }),
    lastSuccess: (source, epochMs) =>
      providerNetblocksLastSuccessTimestampSeconds.set({ source }, Math.floor(epochMs / 1000)),
    cidrs: (source, category, count) => providerNetblocksCidrs.set({ source, category }, count),
  }
}

function makeBoundedHttp(timeoutMs: number, maxBytes: number): FetchHttp {
  return {
    async get(url, headers) {
      const controller = new AbortController()
      const timerId = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const res = await fetch(url, { headers, signal: controller.signal, redirect: 'error' })
        const contentLength = res.headers.get('content-length')
        if (contentLength && Number(contentLength) > maxBytes) {
          throw new Error(`response content-length ${contentLength} exceeds ${maxBytes} bytes`)
        }
        let bodyText = ''
        if (res.status !== 304) {
          // Stream with an INCREMENTAL byte cap and abort the moment it is crossed.
          // res.arrayBuffer() would buffer the entire body first — unbounded on a
          // chunked response with no content-length — so a hostile or misbehaving
          // source could OOM the control plane before the timeout fires. The cap
          // must interrupt the stream, not just reject after the fact, to honor the
          // "bounded request" contract in fetcherTypes (issue #299 review).
          if (res.body) {
            const reader = res.body.getReader()
            const chunks: Uint8Array[] = []
            let total = 0
            try {
              for (;;) {
                const { done, value } = await reader.read()
                if (done) break
                if (!value) continue
                total += value.byteLength
                if (total > maxBytes) {
                  controller.abort()
                  throw new Error(`response exceeds ${maxBytes} bytes (streamed ${total})`)
                }
                chunks.push(value)
              }
            } finally {
              reader.releaseLock()
            }
            const buf = new Uint8Array(total)
            let offset = 0
            for (const chunk of chunks) {
              buf.set(chunk, offset)
              offset += chunk.byteLength
            }
            bodyText = new TextDecoder().decode(buf)
          }
        }
        const outHeaders: Record<string, string> = {}
        res.headers.forEach((value, key) => {
          outHeaders[key] = value
        })
        return { status: res.status, headers: outHeaders, bodyText }
      } finally {
        clearTimeout(timerId)
      }
    },
  }
}

export function startProviderNetblocksCron(options: ProviderNetblocksCronOptions): void {
  if (timer) return
  stopped = false
  const kc = new k8s.KubeConfig()
  kc.loadFromDefault()
  const coreApi = kc.makeApiClient(k8s.CoreV1Api)
  const cmStore = new K8sProviderNetblocksCmStore(coreApi, options.namespace)
  const http = makeBoundedHttp(options.timeoutMs, options.maxResponseBytes)
  const metrics = metricsAdapter()

  const runOnce = async (): Promise<void> => {
    if (inFlight) return
    inFlight = true
    try {
      await runProviderNetblocksTick({
        fetchers: [githubFetcher],
        cmStore,
        pool,
        http,
        now: Date.now(),
        metrics,
      })
    } catch (err) {
      // Defensive: the tick is designed never to throw, but a bug must not kill
      // the process — log and let the next tick run.
      console.error(
        `[provider-netblocks] cron tick threw (contained): ${err instanceof Error ? err.message : String(err)}`
      )
    } finally {
      inFlight = false
    }
  }

  const schedule = (delayMs: number): void => {
    if (stopped) return
    timer = setTimeout(() => {
      void runOnce().finally(() => {
        schedule(options.intervalMs * (0.9 + Math.random() * 0.2))
      })
    }, delayMs)
    timer.unref?.()
  }

  // Startup-independent: control-api serves fully before the first fetch.
  schedule(60_000 + Math.floor(Math.random() * 60_000))
}

export function stopProviderNetblocksCron(): void {
  stopped = true
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}
