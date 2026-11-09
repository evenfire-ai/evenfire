/**
 * Class ids for transaction advisory locks taken in the two-int4 form,
 * `pg_advisory_xact_lock(<class>, hashtext(<key>))`.
 *
 * PostgreSQL tags a two-int4 advisory lock differently from a single-bigint
 * one (`pg_locks.objsubid` 2 against 1), so a key here never conflicts with a
 * `pg_advisory_xact_lock(hashtext(...))` key, whatever the hash values. A
 * distinct class keeps each capability's 32-bit `hashtext` keys apart from
 * every other class. Neither value equals the class of the only other fixed
 * two-int4 key in this service, `pg_try_advisory_xact_lock(1849220361, 1)`
 * (`entityChangeSchema.ts`).
 */

/** Serializes the creation of one workflow approval per idempotency key. */
export const WORKFLOW_APPROVAL_IDEMPOTENCY_LOCK_CLASS = 0x50523201

/** Serializes the writers of one readiness evidence row identity. */
export const READINESS_EVIDENCE_WRITE_LOCK_CLASS = 0x50523202
