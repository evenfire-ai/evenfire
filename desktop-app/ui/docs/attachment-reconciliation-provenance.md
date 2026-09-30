# Attachment reconciliation provenance mini-spec

## Identity and authority

- A matching server turn number and role, or the same deterministic server message ID, identifies the same turn. A uniquely bound live task can also replace its own optimistic turn. In these cases the server owns the visible chips and local upload bytes may enrich matching image chips or remain as local byte-bearing uploads.
- A content-only idle echo has no turn identity. Equal role and text alone is only a candidate match. It is unambiguous only when exactly one authoritative turn of that role has that text in the reconciliation input and exactly one local idle echo claims it.
- For a content-only collapse, server-parsed attachment context must independently identify every local image whose bytes would move: the server must have a matching uploaded-file chip, paired by stable ID where possible or by type, name, and occurrence with equal multiplicity. Server chips remain authoritative. A plugin or file reference on the local echo never becomes a server reference through text coincidence.

## Transfer and ambiguity

- Transfer image bytes across a content-only collapse only when both the unique-text condition and matching server-parsed image context hold. Keep the server chip identity and order; add only the local bytes and missing byte metadata.
- If either proof is missing, do not move the image or collapse its local bubble. The image stays with its own turn so Resend cannot attach it to a different server turn. Text-only echoes and non-reference artifacts may still collapse under the existing adjacent-turn rule.
- Reconciliation is idempotent: repeating it with the same server turns must neither duplicate attachments nor move bytes to another turn. A later server response with stronger identity may safely reconcile a previously retained local bubble.
