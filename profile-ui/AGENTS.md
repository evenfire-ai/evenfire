# AGENTS.md — profile-ui

This is one of three frontend projects in the monorepo (Next.js). It follows the **shared frontend UI rules** in [`../docs/agents/frontend-style-rules.md`](../docs/agents/frontend-style-rules.md).

Read those rules before generating, refactoring, or styling any code in this directory.

## Project-specific notes

- **Token file:** `app/globals.css` — all colors, spacing, radii, shadows, motion, and z-index live here. Consume them as `var(--token-name)`. Never hardcode hex colors or raw px values for these properties.
- **Class prefix:** `cu-` (shared with control-ui) for all shared utility classes.
- **Components folder:** `app/components/` (folder-based, with `index.tsx` + `types.ts`).
- **Primitives:** `app/components/` — use the existing primitives (`Button`, `TextInput`, `SelectControl`, `FormField`, `EditableList`) instead of recreating equivalents.
- **Routing:** Sidebar destinations and shareable tab-like sections must use canonical Next App Router paths and child route segments. Do not use `?tab=...`, `profileTab`, `localStorage`, or component-only state as section routing.
- **Stack alignment:** profile-ui shares the `cu-` prefix and Next.js conventions with control-ui, but components are colocated under `app/components/` (not `components/ui/`). Keep this layout — do not migrate to control-ui's structure.

## Outside this directory

These rules are scoped to `profile-ui/**`. They do not apply to backend services, deploy manifests, or shared docs.
