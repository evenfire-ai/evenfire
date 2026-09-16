# Grok subscription transport contract

Starting freeze: `grok-subscription-transport.v1`.

This is the Phase 0 architecture freeze for provider `grok-subscription`.
Catalog origin and CLI identity headers remain probe-gated (see
`docs/superpowers/specs/2026-09-15-llm-coding-plan-subscriptions-design.md`
§9 and R2-M3). Live SuperGrok confirm may tighten, never widen, this allowlist.

## Ownership

- Control API is the only OAuth custodian.
- `mcp-host` authorizes each physical attempt and streams to `grok-llm-proxy`.
- `grok-llm-proxy` redeems a single-use ticket, holds the access token in
  operation memory only, and talks to the frozen HTTPS origins below.
- The LLM stream never transits Control API or its gateways.
- Traffic never enters `codex-llm-proxy` or `https://api.x.ai`.

## Origins

Exact HTTPS origins (no caller-supplied URL):

- Device authorization: `https://auth.x.ai/oauth2/device/code`
- Token: `https://auth.x.ai/oauth2/token`
- Completions: `https://cli-chat-proxy.grok.com/v1/responses`
- Catalog (starting candidate): `https://cli-chat-proxy.grok.com/v1/models`

Forbidden: `https://api.x.ai`, HTTP, loopback, link-local, metadata.

Redirects: at most one, HTTPS, same origin and same path and same query.
OAuth `device/code` and `token` use `redirect: 'manual'`; any 3xx is an error.

## Ticket

- `typ`: `grok-execution-ticket`
- `aud`: `grok-llm-proxy`
- Admin permit `typ`/`aud`: `grok-admin-permit` / `grok-llm-proxy-admin`

## Limits

Owned by `@clerum/grok-provider-attempt-contract`. Independent of Codex
`LIMITS` (`maxToolCalls` is 64, not 32).

## Identity headers

Stamped in `grok-llm-proxy`, never taken from mcp-host or the hashed request:

- `user-agent: evenfire-grok-subscription`
- `accept: text/event-stream` on stream

CLI impersonation headers (`x-xai-token-auth`, `x-grok-client-identifier`) stay
off until a recorded SuperGrok probe requires them. Do not send `OpenAI-Beta`
or `service_tier`. `max_output_tokens` is bindable on this wire.
