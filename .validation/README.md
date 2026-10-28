# PR 977 exact-source Windows validation harness

This temporary branch triggers hosted Windows validation for application source
`128465a7eab8d9b6dacb24eb5472ffc0948cd9f6`. The workflow trigger commit is a
separate harness commit. The job checks out and verifies the application source
SHA, then overlays only the native Windows test files listed below.

The tests are validation-only and are not part of the application source SHA or
the existing PR branch. They were taken from the prior validation ref
`test/pr977-windows-validation` at `63d4f89e4010eb91320e9a4b51c66fb4983a6d5c`;
the ACL suite adds explicit current-user, SYSTEM, and Administrators owner
witnesses using .NET `DirectorySecurity` APIs. No production files or legacy
client policy are taken from that ref.

- `windowsSessionAuthorityAcl.native.test.ts`
- `windowsSessionAuthorityAcl.launch.test.ts`
- `windowsSessionAuthorityDurableFileOps.native.test.ts`
- `windowsSessionAuthorityFileOps.launch.test.ts`
