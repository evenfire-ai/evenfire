# Attachment reconciliation provenance

## Identity evidence

An authoritative server message owns its turn number and role. A local message
belongs to that turn only when it has the same server turn number and role (or
the corresponding deterministic `turn-N-role` ID), or when one active task ID
binds exactly one eligible local message to exactly one server message. These
are **identified replacements**. The server owns visible text and parsed chips;
the identified local message may supply metadata that the server omitted.

An idle, turnless message between numbered turns is a **content-only echo**.
Equal role, text, or filename is not turn identity. It can be collapsed only
under the adjacent authoritative text rule, and attachment transfer additionally
follows the table below. A unique text match means exactly one server slot of
that role and text across the available existing and incoming messages, and
exactly one eligible turnless claimant. If either count exceeds one, the match
is ambiguous. A partial server page does not erase competing existing slots.

## Ownership decision table

| Attachment class                                   | Identified replacement                                                                                                                                                                                                                              | Unique content-only echo                                                                                                          | Ambiguous or unproved echo                     |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Uploaded images with bytes                         | Keep server chips and fill matching image bytes from the same-turn local message; append local-only byte-bearing uploads. Pair repeated names by occurrence only _inside_ this proven turn.                                                         | Keep the local message and its image. Server display chips have no turn-scoped byte identity.                                     | Keep the local message and its image.          |
| Legacy label-only uploads                          | Keep server chips; retain unmatched local labels for Resend's unrestorable warning.                                                                                                                                                                 | Keep the local message if its label has no independently proven server owner.                                                     | Keep local.                                    |
| Global-file references                             | The server's complete URI/version/size wins. Otherwise enrich its matching display chip from the identified local reference; keep a local-only complete reference when the server omitted it. Never synthesize version or size from a label or URI. | Keep the local reference on its message; server labels are display-only.                                                          | Keep local.                                    |
| Agent-file references                              | The server's complete filesystem/path wins; otherwise enrich a matching display chip from the identified local reference, or keep a local-only structured reference.                                                                                | Keep the local reference on its message; an independent server identity stays on the server turn.                                 | Keep local.                                    |
| `response_file` output artifacts                   | Keep server artifacts; fill or retain local artifacts belonging to the identified assistant turn. They are never Resend inputs.                                                                                                                     | Collapse and transfer only when role and text identify one server slot and one local claimant, with no competing historical slot. | Keep the local assistant message and artifact. |
| Plugin and connector references                    | Server-parsed chips are authoritative; local metadata cannot overwrite a server reference.                                                                                                                                                          | Keep local references on their message; text coincidence cannot make them actionable on a server turn.                            | Keep local.                                    |
| Other non-reference metadata, including tool steps | Server data wins; missing fields may come from the identified local message.                                                                                                                                                                        | Transfer only with a unique content match and no retained attachment class; otherwise keep local.                                 | Keep local.                                    |

When a class says **keep local**, do not collapse its message: dropping the row
would lose the attachment's ownership and any unrestorable warning. A plain
text echo with no owned metadata may still collapse under the adjacent text
rule. A filename, parsed list-position ID, or equal chip count never proves
that two image byte streams or two global-file references are the same object.

## Repeated reconciliation

Server chips keep their order and identity. Enrichment fills absent fields
without replacing complete server identity. Pair each local attachment at most
once, including duplicate names; do not append a second copy of a matched
attachment. A second reconciliation with the same server page must leave the
same attachments on the same logical turns. A retained local row may be merged
later only if stronger turn identity arrives. Resend reads only the surviving
message's own byte-bearing images and complete references.
