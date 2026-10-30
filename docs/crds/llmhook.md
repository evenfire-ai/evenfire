# LlmHook CRD Reference

**API Group:** `clerum.io`
**Version:** `v1alpha1`
**Scope:** Namespaced (installed hooks live in the `llm-hooks` namespace)
**Reconciled by:** host-context-controller · **Read by:** mcp-host

## Purpose

An LlmHook is an installed **guardrail hook**: an HTTP service that mcp-host
calls at defined points of an agent turn, either around the LLM call (LLM lane)
or around a tool call (tool lane). A hook can deny, rewrite, substitute a
result, or add context, but only within the capabilities an admin granted it.

A Host opts in by listing hooks under `Host.spec.guardrails.hooks.<phase>[]`
(see [Host CRD](host.md)). A Host without a `guardrails` block runs no hooks.

- **Image targets:** host-context-controller deploys a Deployment, Service,
  and NetworkPolicy in `llm-hooks`. Hooks with the same image ref, port,
  `envSecret`, `egressBindings` and `addCapabilities` are co-located on one
  pod and routed by `spec.path`; a difference in any of these gets its own pod.
- **Service and remote targets:** nothing is deployed.
- **Who writes what:** mcp-host only reads LlmHook CRs. Only the controller
  writes `status`.

Control UI installs hooks from the registry (**Installed Guardrails**). The
install stamps a platform-assigned `clerum.io/trust-level` annotation (`low`,
`mid` or `high`) that hook authors cannot set. The Host's
`guardrails.minInstalledHookTrustLevel` is checked against that annotation
(and granted capabilities against `guardrails.capabilityCeiling`) by
control-api when a hook is installed or upgraded; mcp-host does not re-check
either at runtime.

## Spec Fields

| Field                                        | Type                    | Required                  | Description                                                                                                                                                                                                                                                                    |
| -------------------------------------------- | ----------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `spec.target`                                | object                  | yes                       | Exactly one of `image`, `service`, `remote`.                                                                                                                                                                                                                                   |
| `spec.target.image.ref`                      | string                  | yes (image)               | Container image. Must be digest-pinned at install; the image allowlist is checked only when `CONTROL_API_ENFORCE_IMAGE_ALLOWLIST` is on (default off).                                                                                                                         |
| `spec.target.image.port`                     | int                     | yes (image)               | Port the hook HTTP server listens on (1–65535).                                                                                                                                                                                                                                |
| `spec.target.image.imagePullSecrets`         | string[]                | no                        | Pull secret names in `llm-hooks`.                                                                                                                                                                                                                                              |
| `spec.target.image.envSecret`                | string                  | no                        | The hook's own credential Secret in `llm-hooks`. It can never reference a Host or LLM-key Secret.                                                                                                                                                                              |
| `spec.target.image.egressBindings[]`         | object[]                | no                        | Allowed external egress: `toFQDN` or `cidr`, plus `ports`. host-context-controller rejects private, metadata, link-local and reserved destinations at reconcile (reason `InvalidEgress`) and fails the hook pod closed; unlike McpServer, this is not checked at admission.    |
| `spec.target.image.security.addCapabilities` | string[]                | no                        | Subset of `CHOWN`, `FOWNER`, `DAC_OVERRIDE`, `NET_BIND_SERVICE`.                                                                                                                                                                                                               |
| `spec.target.service`                        | object                  | yes (service)             | Existing in-cluster Service: `name`, `namespace`, `port`.                                                                                                                                                                                                                      |
| `spec.target.remote.baseUrl`                 | string                  | yes (remote)              | External endpoint mcp-host dials directly. Must be `https://`; SSRF-validated at dial time.                                                                                                                                                                                    |
| `spec.target.remote.authHeadersSecret`       | string                  | no                        | Secret supplying auth headers for the remote endpoint.                                                                                                                                                                                                                         |
| `spec.path`                                  | string                  | no (default `/`)          | Calls go to `{endpoint}{path}/v1/{point}`. Co-located image hooks must use distinct paths.                                                                                                                                                                                     |
| `spec.lifecyclePoints`                       | string[]                | yes (1–6)                 | LLM lane: `preCall`, `moderate`, `postCallSuccess`, `onError`. Tool lane: `preToolUse`, `postToolUse`.                                                                                                                                                                         |
| `spec.contentAccess`                         | `metadata` \| `content` | no                        | What the hook receives. **Omitting it means `content`.** Only a `preCall`-only hook may declare `metadata` (model, params and usage, no message bodies).                                                                                                                       |
| `spec.order`                                 | int                     | no (default 100)          | Order within a phase; lower runs first.                                                                                                                                                                                                                                        |
| `spec.failMode`                              | `open` \| `closed`      | no (CRD default `closed`) | Behaviour when the hook is unavailable. A hook with `may_deny` must fail closed. The Control UI install form preselects the hook author's suggested fail mode, or `open`; granting `may_deny` forces `closed`.                                                                 |
| `spec.timeoutMs`                             | int                     | no (default 5000)         | Accepted but not used today; the transport timeout is the Host's `guardrails.limits.maxHookTimeoutMs` (default 5000). Every call also stops at a fixed 15000 ms hard deadline.                                                                                                 |
| `spec.onUnavailable`                         | object                  | no                        | Circuit breaker: `mode` (`strict` \| `breaker`, default `strict`), `failureThreshold` (default 5), `cooldownMs` (default 30000).                                                                                                                                               |
| `spec.capabilities`                          | string[]                | no                        | Admin-granted: `may_deny`, `may_rewrite`, `may_substitute_result`, `may_add_context`. Checked against the Host's `guardrails.capabilityCeiling` at install time; mcp-host ignores response actions the hook was not granted.                                                   |
| `spec.config`                                | object                  | no                        | Opaque hook settings. Never used as a trust input.                                                                                                                                                                                                                             |

### Admission and install rules

- `remote.baseUrl` must start with `https://`.
- A hook granted `may_deny` must use `failMode: closed`.
- `contentAccess: metadata` is rejected for `moderate`, `postCallSuccess`,
  `onError`, `preToolUse` and `postToolUse`, which are inherently
  content-bearing.
- At install time (not CRD admission), a content-bearing hook that has
  `egressBindings` or a `remote` target is accepted only at trust level
  `high`.

## Status Fields

| Field                   | Description                                                                                                                                                                                                                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `status.observedDigest` | Image digest actually running. For `image` targets whose Host reference pins `Host.spec.guardrails.hooks[].digest`, mcp-host compares the two. On a mismatch the hook is quarantined on both lanes: calls are treated as unavailable without dialing, so a `may_deny` hook with `failMode: closed` denies and an advisory hook contributes nothing.    |
| `status.readyReplicas`  | Ready replicas (image targets only).                                                                                                                                                                                                                                                                                                                   |
| `status.lastReconciled` | Timestamp of the last successful reconcile.                                                                                                                                                                                                                                                                                                            |
| `status.conditions[]`   | A single `Ready` condition with `observedGeneration`; its `reason` is one of `NoWorkload`, `Deploying`, `Ready`, `DuplicatePath`, `SecretNotFound`, `InvalidEgress`, `ReconcileError`.                                                                                                                                                                 |

`kubectl get llmhooks -n llm-hooks` shows Path, Order, FailMode, Digest, and Ready.

## Example

```yaml
apiVersion: clerum.io/v1alpha1
kind: LlmHook
metadata:
  name: pii-redactor
  namespace: llm-hooks
spec:
  target:
    image:
      ref: ghcr.io/example/pii-redactor@sha256:<digest>
      port: 8080
  path: /pii
  lifecyclePoints: [postCallSuccess]
  capabilities: [may_substitute_result]
  failMode: closed
  timeoutMs: 3000
```

Referenced from a Host:

```yaml
spec:
  guardrails:
    capabilityCeiling: [may_deny, may_substitute_result]
    hooks:
      postCallSuccess:
        - id: pii-redactor
          digest: sha256:<digest>
```

A zero-dependency reference implementation of the `/v1` protocol lives in
[`hooks/reference-guardrail-hook/`](../../hooks/reference-guardrail-hook/).

## Related

- [Configure guardrails](../how-to/configure-guardrails.md): the how-to guide
- [Host CRD](host.md): `spec.guardrails`
- [CRD Index](README.md)
