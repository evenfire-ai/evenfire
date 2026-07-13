# Webhook Gateway

Per-recipe webhook ingress verifier. The WorkflowRecipe controller (WRC) deploys one gateway per recipe that declares `spec.webhooks[]`; the cluster-edge router (`webhook-proxy/`) forwards `/<webhookId>` requests to it, and the gateway verifies the provider signature before forwarding the untouched raw body to the handler workload. Node builtins only (`crypto`, `http`, `fs`, `url`) — zero runtime dependencies (`"dependencies": {}` in `package.json`).

## How it works

1. `webhook-proxy` forwards `ANY /<webhookId>` to the gateway (port 8090).
2. The gateway revalidates the id against `^[a-z0-9-]{1,63}$` **before** any config lookup (400), then resolves the entry from its config file (404 if unknown, 410 if dormant).
3. The raw body is read byte-for-byte (no body-parser middleware — the verifier needs the exact bytes the provider signed), with size and idle-timeout caps enforced as chunks arrive.
4. The configured verification scheme runs; signature failures return 401 without leaking why (timestamp skew is 408 `timestamp_skew`, verifier misconfiguration is 500 — details below).
5. On success, headers are sanitised and the request is forwarded to the per-recipe upstream (`host:port/path` from config); the upstream response streams back to the provider.

Setup handshakes are answered inline when configured: `meta-hub-challenge` (GET `hub.challenge` echo, pre-verify; token compared with a length-guarded `timingSafeEqual` — a length mismatch short-circuits, revealing only token length, unlike the padded static-bearer path) and `slack-url-verification` (post-verify, so the challenge payload is still signature-checked). The `stripe-verify` strategy is accepted by the config schema but not implemented yet.

## Verification schemes (`src/verifier.ts`)

| Scheme                       | Mechanism                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hmac-sha256-body`           | HMAC-SHA256 over the raw body; hex or base64 signature header, optional prefix strip.                                                                                                                                                                                                                                                             |
| `hmac-sha256-timestamp-body` | Stripe/Slack style HMAC over `${timestamp}.${body}` using the wire-exact timestamp string; replay tolerance window (10–3600 s) — out-of-window requests get 408 `timestamp_skew`.                                                                                                                                                                 |
| `static-bearer`              | Constant-time token compare; defaults to `Authorization: Bearer <token>`, custom header/prefix supported (e.g. Telegram's `x-telegram-bot-api-secret-token`).                                                                                                                                                                                     |
| `jwt-bearer-jwks`            | JWT verified against a JWKS file on disk. Asymmetric algorithms only (RS/PS/ES\*); `HS*` and `none` are rejected outright — the classic alg-confusion attack. Claims (`exp`, `nbf`, `iss`, `aud`) are checked only **after** signature verification, with 60 s clock skew. Key selection by `kid`, or the sole key when the JWKS has exactly one. |

HMAC and static-bearer comparisons use `crypto.timingSafeEqual` (with equal-length padding on the static-bearer path to keep timing flat); JWT signatures use `crypto.verify`. Duplicate signature headers are rejected, and malformed signatures map to the same 401 as wrong ones so attackers learn nothing from the error shape.

## Configuration

Per-webhook routing/verification config is a JSON file written by the WRC reconciler (secrets are mounted files, never env vars). Runtime knobs come from the environment:

| Variable                       | Default                            | Purpose                                          |
| ------------------------------ | ---------------------------------- | ------------------------------------------------ |
| `GATEWAY_RECIPE_NAMESPACE`     | — (required)                       | Recipe namespace, set via Downward API by WRC    |
| `GATEWAY_RECIPE_NAME`          | — (required)                       | Recipe name, set via Downward API by WRC         |
| `GATEWAY_CONFIG_PATH`          | `/etc/webhook-gateway/config.json` | Path to the reconciled gateway config            |
| `GATEWAY_HTTP_PORT`            | `8090`                             | Public `/:webhookId` listener                    |
| `GATEWAY_METRICS_PORT`         | `9090`                             | Metrics + health listener                        |
| `GATEWAY_HEADER_TIMEOUT_MS`    | `5000`                             | Slowloris: header-receive timeout                |
| `GATEWAY_BODY_IDLE_TIMEOUT_MS` | `10000`                            | Slowloris: body idle timeout (also keep-alive)   |
| `GATEWAY_TOTAL_TIMEOUT_MS`     | `30000`                            | Total request lifetime / upstream forward budget |
| `GATEWAY_MAX_IN_FLIGHT`        | `256`                              | Per-pod concurrent request cap                   |
| `GATEWAY_DEBUG`                | `false`                            | Extra debug logging                              |

## Ports

- `8090` — webhook ingress (`ANY /:webhookId`, plus `/healthz` and `/readyz` for probes)
- `9090` — `/metrics` (Prometheus text format), `/healthz`, `/readyz`

## Security & DoS posture

- **Fail-closed verification** — unverified requests never reach the handler workload; secret-file problems return 500 `verifier_misconfigured`, not a bypass.
- **Slowloris budgets** at the Node server level (header/total timeouts) plus a body idle timeout inside the streamed reader.
- **Per-pod in-flight cap** — above `GATEWAY_MAX_IN_FLIGHT`, requests get 503 `gateway_busy`.
- **Body caps** — declared `Content-Length` is pre-checked and the streamed read is capped per webhook (`maxBodyBytes`, 1 KiB–10 MiB) → 413.
- **Method allowlist** — only POST (and GET where a handshake requires it) per config → 405 otherwise.
- **Dormant webhooks** — optional webhooks whose Secret was missing at reconcile time answer 410 Gone (terminal for provider retry storms) with an `X-Clerum-Webhook-State: dormant` header.
- **Header sanitisation on forward** — `Authorization`, `Cookie`, `Host`, hop-by-hop headers, the scheme's signature/timestamp headers, and _every_ inbound `x-clerum-*` header are stripped; the gateway injects its own `x-clerum-webhook-id` / `-recipe` / `-verified-at`.
- **Logs never include** request bodies, signatures, or secrets — outcomes only, as single-line JSON.
- Runs as non-root uid 1001 (`USER nodejs` in the Dockerfile).

## Testing

```bash
cd webhook-gateway
npm install
npm test        # vitest — ~100 test cases across 5 suites (verifier, config, headers, handshake, e2e server)
```

## Deployment

There is no static Deployment manifest: WRC stamps one gateway Deployment per recipe (image from `WRC_WEBHOOK_GATEWAY_IMAGE`, see `deploy/base/control-plane/workflow-recipes.yaml`) into the `sandbox-recipes` namespace with the `clerum.io/webhook-gateway: "true"` label, alongside per-recipe NetworkPolicies that restrict gateway ingress to `webhook-proxy` (plus the metrics scraper) — see `workflow-recipes/src/reconciler/webhookGatewayBuilder.ts`. The matching webhook-proxy egress policy lives in `deploy/base/webhook-ingress/networkpolicies.yaml`. Build the image with `make docker-build` (see `Makefile`).
