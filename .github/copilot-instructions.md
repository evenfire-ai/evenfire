# Copilot Instructions

When you edit files under `control-ui/**`, `desktop-app/ui/**`, or `profile-ui/**`, apply the shared UI rules in [`docs/agents/frontend-style-rules.md`](../docs/agents/frontend-style-rules.md).

For `control-ui/**` and `profile-ui/**`, sidebar destinations and shareable tab-like sections must use canonical Next App Router paths and child routes, not `?tab=...`, `profileTab`, `localStorage`, or component-only state as routing.

Those instructions are scoped to those three frontend projects only. Do not assume they apply to the rest of the repository.
