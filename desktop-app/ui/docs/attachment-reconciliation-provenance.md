# Attachment reconciliation provenance mini-spec

## Identity and authority

- A matching server turn number and role, or the same deterministic server message ID, identifies the same turn. A uniquely bound live task can also replace its own optimistic turn. In these cases the server owns the visible chips and local upload bytes may enrich matching image chips or remain as local byte-bearing uploads.
- A content-only idle echo has no turn identity. Equal role and text alone is only a candidate match. It is unambiguous only when exactly one authoritative turn of that role has that text in the reconciliation input and exactly one local idle echo claims it.
- Server-parsed image chips currently carry a filename but no turn-scoped image identity or byte digest. Their parsed IDs also derive from list position and filename. Neither a matching filename, parsed ID, nor matching multiplicity proves that two images have the same bytes or belong to the same prompt. Server chips remain authoritative. A plugin or file reference on the local echo never becomes a server reference through text coincidence.

## Transfer and ambiguity

- A content-only collapse must not transfer byte-bearing uploaded images with the current server payload. Keep their local bubble even if role, text, filenames, and chip counts match. Byte recovery remains allowed when turn number plus role, deterministic server message ID, or a unique live-task binding identifies the same turn. A future content-only transfer would require an independently verified turn-scoped image identity or content digest on both sides.
- This restriction applies to uploaded input images. A `response_file` is an assistant output artifact, not a Resend input; a settled assistant echo carrying its bytes may still collapse under the adjacent-turn rule and retain that artifact on the surviving assistant row. Label-only legacy uploads may also collapse and retain their unrestorable warning. Text-only echoes and other non-reference artifacts keep their existing collapse behavior.
- Reconciliation is idempotent: repeating it with the same server turns must neither duplicate attachments nor move bytes to another turn. A later server response with stronger identity may safely reconcile a previously retained local bubble.
