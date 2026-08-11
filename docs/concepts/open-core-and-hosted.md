# Open core: self-host vs evenfire hosted

evenfire is **open core**. This repository is the complete, single-tenant
platform under **MPL-2.0** — hardened and not feature-gated. A separate
commercial offering, **evenfire hosted**, runs that platform for you as a
managed, multi-tenant service. This page draws the line between the two
honestly, so self-hosting holds no surprises.

## What's in this repo (the open-source platform)

Everything needed to run the full platform yourself — single-tenant, hardened,
and not held back:

- **Every service**, including the `mcp-host` agent runtime.
- The **eight `clerum.io` CRDs** and the CRD Helm chart.
- The **full security model** — default-deny NetworkPolicies, per-workload
  security contexts, the service-to-service JWT chain, and human-in-the-loop
  approvals.
- **One-command local bring-up** (`make minikube-setup`) on minikube, and
  production on any Kubernetes cluster.
- **All three UIs** — Control UI, Desktop App, Profile UI — plus `electron-forge`
  packaging to ship the desktop app to your users.
- **Self-hosted initial-admin GFS parity** — the Desktop identity created for
  the first Control Admin during setup is linked directly for GFS operator
  access. Control UI can revoke that authority without changing the admin
  account or its credentials and can explicitly reactivate it as a new audited
  link generation when the retained identities remain active.
- The **registry client**: connect to a registry to install and publish
  connectors and recipes.
- The **cluster E2E suites**.

Nothing here is crippled or withheld to force an upgrade. Self-hosting is a
first-class path, not a trial.

## What's not in this repo

**evenfire hosted** is the commercial, operated, multi-tenant service. A few
pieces live outside this repo — the multi-tenant machinery, plus one shared
backend:

- **Multi-tenant provisioning and isolation** — the orchestration that
  provisions and isolates one tenant from another. Self-hosting is
  **single-tenant**: one organization per deployment.
- **The hosted registry control plane** — the operator side of the shared
  registry at `registry.evenfire.ai`. The registry *client* is in this repo; the
  control plane that runs the shared service is not.
- **Member registration** — the invitation-signup backend
  (`member-registration-service`) is an extracted sibling service, not in this
  repo. Self-hosted deployments don't need to run it: set
  `CONTROL_API_MEMBER_REGISTRATION_MODE=hosted` and the platform enrolls itself
  with evenfire's shared registration hub, which sends invitation emails on
  your behalf — see
  [member invitations on self-hosted](../how-to/member-invitations-self-hosted.md).
  Operators who want full control can still run their own instance and point
  `CONTROL_API_MEMBER_REGISTRATION_SERVICE_BASE_URL` at it.

These gaps are named, not hidden.

## Connecting to a registry as a self-hoster

The connector/recipe registry is a separate service that `control-api` reaches
over HTTP, configured with `CLERUM_REGISTRY_URL`. You can point it at a registry
you operate, or connect to the shared **`registry.evenfire.ai`** after an
approval step. Either way, browsing, installing, and publishing happen from your
own Control UI — evenfire's operators never touch your fleet.

## Support

- **Self-host** — community best-effort through GitHub
  [Issues and Discussions](https://github.com/evenfire-ai/evenfire). There is no
  SLA; self-host support is never promised.
- **evenfire hosted** — fully operated, with support and an SLA.

## License

evenfire is licensed under the **Mozilla Public License 2.0 (MPL-2.0)** — an
OSI-approved, file-level copyleft license. You can use, modify, self-host, and
build commercial products on it; changes to MPL-licensed files must remain under
MPL when distributed, while larger works that combine with this code may carry
their own license. See [LICENSE](../../LICENSE) and the root README's
[community and license](../../README.md#community-and-license) section.

## Related

- [Why evenfire](why-evenfire.md) — problem, audience, design intent
- [When to use evenfire](when-to-use-evenfire.md) — category-level fit
- [Production deploy notes](../deploy/production.md)
