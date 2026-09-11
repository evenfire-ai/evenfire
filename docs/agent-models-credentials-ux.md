# Agent models and LLM Secrets: UX decision record

**Status:** Proposed current-state flow
**Audience:** Product, design, and engineering
**Scope:** Control UI agent creation and the agent **Models & creds** tab

## Executive summary

The product should talk about an **LLM Secret**, not a raw Kubernetes Secret. An LLM
Secret is the user-facing collection of provider credentials linked to an agent. The
current backend can attach exactly one Kubernetes Secret to a Host, but that Secret can hold
keys for several providers. The practical UX is therefore:

1. Link one existing LLM Secret or create one for the agent.
2. Choose the primary provider and model.
3. Add fallback providers when needed.
4. Add credentials for other providers to the same set without exposing secret values.
5. Save the Host configuration and the LLM Secret changes together from the user’s
   point of view.

This keeps the implementation within the current contract while removing Kubernetes
terminology and the misleading impression that every provider needs a separate secret
object.

## The current system contract

### Host-to-credential relationship

- A Host has one `spec.secretRef`.
- The referenced Kubernetes Secret is a key/value bag, so it can contain credentials
  for multiple providers.
- The runtime uses the primary provider and configured fallback providers to decide
  which keys to load.
- The existing admin API supports merge updates to a Secret and can remove named keys.
- The Control UI receives Secret names and data-key names only. Secret values are never
  returned to the browser.

### What the UI can safely know

The UI can show:

- which LLM Secret is linked;
- which recognized provider keys exist;
- whether the required key set for a provider is complete or incomplete;
- whether a value is stored, without displaying the value;
- which provider credentials are being added, replaced, or retired in the current edit.

The UI cannot show:

- the existing credential value;
- whether a stored value is valid with the provider;
- who else uses the set;
- whether an unrecognized Secret key is safe to delete;
- an atomic result for changing the Host and the Secret in one backend transaction.

## Problems found

### 1. “Secret reference” exposes an implementation detail

The old label made users reason about Kubernetes objects, names, and references. It
also suggested that a secret is a single provider credential. Neither is the mental
model users need when configuring an agent.

**UX implication:** Users should select an **LLM Secret** and see provider
availability, while the underlying `secretRef` remains an implementation detail.

### 2. Empty API-key inputs look like missing or destructive state

An empty password field can mean “not configured,” “the value is hidden,” or “this
save will erase the credential.” Because values are write-only, an empty input is not
enough information.

**UX implication:** Stored credentials must render as **Stored** with an explicit
**Replace** action. The replacement field appears only after the user chooses to
replace the value. Leaving it alone preserves the stored value.

### 3. Provider routing and provider storage were mixed together

The previous screen showed primary credentials, fallback credentials, and provider
keys in a single dense form. A provider could be stored in the Secret without being
selected as primary or fallback, but there was no clear place to add it.

**UX implication:** Keep routing in the primary/fallback sections. Put unused provider
credentials in an optional **Additional providers** section that writes to the same
LLM Secret.

### 4. “Credential slot” was backend language

`credentialSlot` is a constrained key-selection mechanism for some fallback cases.
It is not a concept most operators should have to understand.

**UX implication:** Label it **Credential source** and explain the behavior in terms of
using the provider’s primary credential or another key already in the LLM Secret.
Providers whose credential shape cannot support a separate slot should say that they
reuse the primary credential.

### 5. Shared-set edits are potentially surprising

The current contract allows multiple agents to point to the same Secret. Adding,
replacing, or removing a provider key can therefore affect another agent, but the old
flow did not make that relationship visible.

**UX implication:** Show a warning in the LLM Secret panel that changes apply to
the Secret and may affect other agents. Link to the LLM Secret management page for
the broader inventory and future ownership/usage information.

### 6. Host and credential writes are not atomic

The current edit flow updates the Host and then issues a separate merge update for the
LLM Secret. A failure between those requests can leave the Host routing change
and the credential change out of sync.

**UX implication:** Keep one Save action and preserve the edit state on failure, but
show an actionable error. A future transactional endpoint is needed to guarantee
all-or-nothing behavior.

### 7. Key names are only partial status

A key name proves that a value is stored, not that the value is valid, current, or
usable. Provider-specific environment values (for example, region or project ID)
may also live outside the Secret.

**UX implication:** Use “configured” or “incomplete” as structural status, not as a
claim that authentication will succeed. Keep provider environment configuration
separate and explain where it is managed.

## Recommended flow with the current backend

### Agent creation

1. **LLM credentials:** choose **Use an existing LLM Secret** or **Create a new LLM
   Secret**.
2. For an existing set, link it; do not ask the user to understand a Secret name.
3. For a new set, generate the internal name from the agent name plus a short unique
   suffix. If no provider is selected, create an empty set; the agent can be saved
   without inventing a credential value.
4. If providers are selected, collect their values into the same set and attach that
   one set to the Host.
5. After creation, the Models & creds tab is the place to select routing, add another
   provider, replace stored values, or configure fallbacks.

The underlying create payload can continue using `secretMode`, `secretRef`, and the
existing Secret API while the visible copy uses LLM Secret terminology.

### Agent Models & creds tab

#### 1. LLM Secret

Start with the linked set and a provider summary:

- Secret name, presented as an LLM Secret name;
- recognized providers in the set;
- `configured` or `incomplete` status based on required key names;
- a warning that edits may affect other agents;
- a link to manage all LLM Secrets.

Changing the linked set clears write-only replacement drafts and pending removals so a
value from one set can never be submitted to another.

#### 2. Primary provider

The primary provider and model remain the required routing decision. Its credential
block shows the stored state without an empty API-key field. **Replace** reveals a
write-only input; **Keep stored** cancels that replacement.

#### 3. Fallback providers

Fallbacks remain optional. The UI explains that a fallback with no usable key is
skipped at runtime and does not block saving. When a separate key is supported, the
fallback can use the provider’s primary credential or another source already in the
set. The UI does not expose the internal slot terminology.

#### 4. Additional providers

An **Add provider** picker exposes providers that are not currently represented by
the active primary/fallback editor. Adding one reveals its provider-specific fields.
The section makes the consequence explicit: these credentials are stored now and
become usable when that provider is later selected as primary or fallback.

Stored additional credentials use the same Stored/Replace pattern. Removing a stored
key queues a named removal and explains that deletion happens only on Save.

#### 5. Save and failure behavior

Save and Cancel stay at the bottom of the page, matching the rest of the Control UI.
On failure, remain in edit mode with the write-only draft intact. The user should be
able to retry without re-entering values, while the error should identify whether the
Host or LLM Secret operation failed when the API can provide that detail.

## Limitations and their product implications

| Limitation | Immediate UI behavior | Product implication |
| --- | --- | --- |
| One `secretRef` per Host | One linked LLM Secret per agent | Multiple independent LLM Secrets need a new Host/agent contract. |
| Secret values are write-only | Stored/Replace states; no prefilled values | The UI cannot validate or compare old and new values. |
| No LLM Secret usage endpoint | Warn that a Secret may be shared | Users cannot yet see impact before editing or deleting. |
| Host and Secret writes are separate | One user-facing Save; preserve drafts on failure | A future transactional API should remove partial-write ambiguity. |
| Provider completeness comes from key names | Show configured/incomplete, not authenticated | Runtime/provider validation is still the source of truth. |
| Unknown Secret keys lack provider metadata | Do not surface unknown keys as editable providers | A metadata API is needed for safe discovery and cleanup. |
| Some providers require non-secret environment values | Link to Host environment configuration | Credential setup is not self-contained in one panel. |

## Future backend work

1. Add an LLM Secret usage/ownership endpoint and show affected agents before a
   destructive change.
2. Add clone/detach semantics so a shared set can become private to one agent.
3. Add a transactional Host-plus-credential mutation or an explicit server-side
   operation that returns a durable operation result.
4. Return provider metadata and key completeness from the API instead of making the
   UI infer it from key-name conventions.
5. Define lifecycle rules for empty sets, unused provider keys, and deletion.
6. If the product needs multiple independent LLM Secrets per agent, introduce a
   first-class agent-to-LLM-Secret mapping rather than extending the current
   single `secretRef` field invisibly.

## Decisions still needed

- Should editing a shared LLM Secret remain direct, or should the default action
  be **Clone for this agent**?
- Should unused provider credentials be allowed in a set indefinitely, or should the
  UI warn when a key is stored but not reachable through primary/fallback routing?
- Should deleting the last key from a set delete the empty set, keep it, or require an
  explicit cleanup action?
- Which roles can replace or retire a credential key when the set is shared?
- Which provider environment fields should be surfaced inline versus linked to Host
  environment settings?

## Acceptance criteria for this UX direction

- No user-facing Models & creds copy requires knowledge of Kubernetes Secrets.
- A stored credential never appears as an unexplained empty API-key input.
- Users can add a provider to the currently linked set without creating a second
  hidden object or leaving the page.
- Users can tell the difference between provider routing, stored credentials, and
  provider environment configuration.
- Shared-set impact and write-only limitations are visible before Save.
- The UI preserves drafts on failures and never places secret values in logs,
  analytics, documentation, or error messages.

> **Notion handoff:** This Markdown file is the source draft for the requested Notion
> page. No Notion connector is available in this workspace, so no external Notion
> page was created from this session.
