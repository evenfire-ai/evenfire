# PR 977 exact-source Windows validation harness

This temporary branch triggers hosted Windows validation for application source
`b6c720ee5e7e152173ddb6362f1413ed6262b080`. The workflow trigger commit is separate; the job
checks out and verifies the application SHA before testing it.

The source checkout contains both launcher regression tests. The workflow overlays only these
validation-only native test files:

- `windowsSessionAuthorityAcl.native.test.ts`
- `windowsSessionAuthorityDurableFileOps.native.test.ts`

The tests were adapted from the prior validation ref
`test/pr977-windows-validation` at
`63d4f89e4010eb91320e9a4b51c66fb4983a6d5c`. ACL mutation fixtures use .NET
`DirectorySecurity` APIs and include current-user, SYSTEM, and Administrators owner witnesses.
No production files or legacy-client policy are taken from that ref.
