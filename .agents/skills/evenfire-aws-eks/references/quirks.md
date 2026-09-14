# Fail-closed quirks (agents get these wrong)

These are verified production failures, not style nits. Read this before
applying anything.

## Secrets vs `kubectl apply -k`

Base ships empty canary Secrets (`stringData: {}`). Real tokens and keys are
written with `kubectl patch --type=merge` so they sit **outside** the apply
last-applied envelope.

If you put token values in a kustomize patch and then `kubectl apply -k`, the
next apply three-way-merges against the empty canary and **wipes the tokens**.
That is why `deploy/scripts/apply-inter-service-tokens.sh` exists.

Re-running that script must **preserve** existing Secret values unless the
human asked to rotate (`FORCE_REGEN` / explicit env overrides).

Never commit Secret YAML with real values.

## JWT keys

Use `deploy/scripts/gen-jwt-keys.sh` with `CONTEXT=` set. It works on any
cluster. `scripts/minikube/generate-keys.sh` is minikube-shaped (writes into
the minikube overlay).

If `control-api-secrets` already exists, do **not** regenerate. Regeneration
invalidates every session and admin token.

After keys exist, run `scripts/minikube/sync-auth-key.sh --context "$CONTEXT"`.
That copies the RPC **public** key from `rpc-proxy-secrets` into live
`mcp-host-config` and `gfs-config`. The public key is not in the key manifest.

## Admin login placeholder

`gen-jwt-keys.sh` writes a **placeholder bcrypt** unless
`ADMIN_BOOTSTRAP_PASSWORD_HASH` is set. That hash cannot log anyone in.

On a fresh cluster you must either:

1. Pass `ADMIN_BOOTSTRAP_PASSWORD_HASH` (bcrypt of a password the human chose) into gen-keys, or
2. After Postgres is up, UPDATE `control_admin_users.password_hash` for `admin` with a real bcrypt and give the human the password once.

Do not leave the placeholder and tell them to log in with `admin123!`.

## Kubernetes API CIDR (already took a cluster down)

A NetworkPolicy that allows only `kubernetes` Service ClusterIP can still drop
apiserver traffic: kube-proxy DNATs to the control-plane endpoint, and some
CNIs (GKE legacy Calico) evaluate the **post-DNAT IP**.

Operators then crash-loop, looking like a product bug. Detect ClusterIP **and**
endpoint IPs. Patch static policies **and** `CONTEXT_MAPPER_K8S_API_CIDRS`.
HCC fail-closes (process crash) on a CIDR wider than `/24` IPv4 or `/120` IPv6.

`verify-networkpolicies.sh` forbids leftover `10.109.0.1/32` (base DigitalOcean
placeholder).

## Official release images, not `latest`

Customer EKS installs the **last official public release**: git tag `v0.8.0`
and `ghcr.io/evenfire-ai/<image>:v0.8.0`. Mixing `main` manifests with older
images, or using `latest` / `sha-*` / Artifact Registry, is how you get CRD
prune and ImagePullBackOff. `MINIKUBE_IMAGE_TAG=latest` is not an EKS escape
hatch.

## Dynamic images

Kustomize `images:` does not see env vars unless a FieldSpec is installed (the
GHCR component does that for values starting with `clerum/`). Base HCC defaults
are **not** `clerum/*`. Unpatched clusters pull the wrong registry and fail.
Patch those env vars to `ghcr.io/evenfire-ai/…:v0.8.0`, not a private SHA.

## `rpc-proxy-config` / `mcp-host-config`

Not in `deploy/base`. Every overlay must supply them. Missing →
`CreateContainerConfigError`.

## Inter-service tokens vs member-registration HMAC

`apply-inter-service-tokens.sh` generates most tokens if absent. **Member
registration HMAC is stricter:** outside minikube it fail-closes unless
`CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET` is set or the Secret already has
a value.

For self-hosters using **hosted** invitation mode
(`CONTROL_API_MEMBER_REGISTRATION_MODE=hosted`), do **not** also set
`CONTROL_API_MEMBER_REGISTRATION_HMAC_KID` /
`CONTROL_API_MEMBER_REGISTRATION_TENANT_ID` — control-api refuses to start.
See `docs/how-to/member-invitations-self-hosted.md`.

## CRDs

Helm 3 does **not** upgrade CRDs on `helm upgrade`. Always
`kubectl apply -f ./charts/clerum-crds/crds/` after the Helm install.
Apply CRDs **before** control-api, then UIs. An old CRD silently prunes new
fields with HTTP 200.

## DB migration before apply

`run-control-api-db-migration.sh` requires `CONTEXT` and `ALLOWED_CONTEXTS`
(exact comma-separated allowlist — set both to the customer context). It runs
the schema Job **before** the rest of the overlay. Skipping it can leave
control-api on an empty or drifted schema.

## GFS after apply

`provision-gfs-runtime.sh` is post-overlay. Production-like context names need
`--allow-prod` **and** a human yes. Do not skip auth-key sync unless the script
flag says so.

## HCC before WRC

WorkflowRecipe external egress waits on HCC `ExternalEgressReady` at the
current generation. Roll HCC to Ready, then WRC. Mixed-version
`control-api` + `control-ui` breaks recipe-secret namespace routing — roll
those two together.

## `CLERUM_DEV_MODE`

Never `true` on a real cluster. It weakens the security model and is not "easier
install".

## WorkflowRecipe `spec.dryRun`

Unimplemented. Kubernetes `kubectl apply --dry-run=server` is the only dry-run.
`spec.dryRun` on a recipe would deploy for real if it were honored later — do
not tell the customer it is a safe no-op.

## Bedrock / AWS identity

Documented Bedrock credentials are static `aws-access-key-id` +
`aws-secret-access-key` in a Secret, plus `AWS_REGION`. IRSA / Pod Identity for
platform ServiceAccounts is **not** a documented Evenfire install path. Do not
invent it as required.

## Do not copy these from Evenfire's GKE overlay

- Artifact Registry `us-central1-docker.pkg.dev/...` image names
- GKE `standard-rwo` unless that class exists on this EKS cluster
- NodeLocal DNS CIDR from another cluster
- Tunnel UUID, HMAC key id, tenant id
- gcp-dev HCC netpol resync intervals
- GFS Upload v2 enabled (prod keeps it off until a separate review)
- `WEBHOOK_PUBLIC_BASE_URL` pointing at someone else's domain
