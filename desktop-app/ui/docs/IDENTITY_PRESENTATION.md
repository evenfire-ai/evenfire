# Agent and sidebar session presentation decision

Scope: PR #1651, R2-M1 / R2-M2 / R3-M1. Resource identity and navigation do not change.

## Contract

1. Every selectable agent has a unique final label within the complete accessible agent set. Its base is the current catalog display name, falling back to the original reference when absent. Ordinary unique bases remain unchanged.
2. Reserve **all original bases before allocating any generated label**. For duplicate bases, start with `Base (reference)`. If that complete label is reserved, use `Base (reference; 2)`, then `; 3`, etc. Process identities in stable code-point order, independent of table/session ordering. Generated labels are reserved immediately.
3. This is one bounded allocator, shared by agents and sessions. With n distinct identities, at most n original bases and n generated labels can be reserved. Each attempted counter produces a distinct string, so a free result exists within 2n+1 attempts. Original unique bases cannot be stolen; all generated outputs are checked against all originals and earlier outputs. The guarantee does not depend on restrictions on configured display names or identifier characters.
4. Missing catalog entries participate using their original reference as the base. They receive the same collision protection. Recompute the entire projection on catalog refresh; newly introduced collisions are disambiguated and removed collisions return to concise labels. No identity, selection, persisted key, or navigation argument is derived from a label.
5. Sidebar sessions use their original title as the base and the canonical pair `[agentRef, chatId]` as allocation identity. A unique title retains the accessible name `Open title`. Duplicate titles use `title (agentLabel · chatId)` with the same reservation/counter rule, protecting against titles that impersonate generated accessible names. The options control uses the same resolved label with its own constant prefix.
6. Visible session copy retains the original title on its first line. Its second line is the friendly agent label for ordinary unique titles, or the allocator's complete disambiguator for colliding titles. Thus equal original titles have distinct second lines; unequal original titles already differ. Full secondary copy remains available through its title. Open/options accessible names are unique across the full session list, including off-preview sessions.
7. Actual references and chat IDs remain unchanged in data attributes, action arguments, storage, React identity, rename payloads, and selection. Catalog labels affect presentation only.

## Test consumer contract

Fleet rows are selected by exact `data-agent-ref`; sidebar sessions by exact `data-agent-ref` plus `data-chat-id`. Controls within an already identified row may be selected by their fixed action prefix. Assertions about displayed text use the current catalog/presentation projection, never a reference masquerading as a friendly name. Workspace/breadcrumb assertions use the catalog display name, which is a different presentation surface from a disambiguated fleet label.

Regression coverage includes unique and duplicate bases; the review's generated-versus-original collision; chained/adversarial reserved labels; absent catalog entries; arbitrary identity characters; input reordering; refresh introducing/removing collisions; equal session titles and composed-name impersonation; exact navigation; and reference substrings with different display names.

The seeded browser identity journey must exercise the production renderer and the same navigation helpers used by stateless-wake/cross-device consumers, with different names and substring references. A renderer/bridge fixture journey is reported separately from the live suspend/wake gate: the latter requires its documented owned cluster, suspended host, authenticated services, and two lifecycle passes. Neither result substitutes for the other.
