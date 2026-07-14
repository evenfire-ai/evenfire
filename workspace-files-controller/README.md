# Workspace Files Controller

Per-[SharedFileSystem](../docs/crds/sharedfilesystem.md) HTTP file API. Each SharedFileSystem (SFS) gets its own workspace-files-controller (wfc) instance that mounts the SFS PVC at `/workspace` and exposes list/stat/download plus upload/replace/mkdir/move/delete over HTTP. It is the **write path** for a team workspace: host-context-controller mounts the same PVC **read-only** into the mcp-host pods that reference it, so agents read the workspace but never mutate it — humans and admins write through this service (via control-api).

## How It Works

- host-context-controller's SharedFileSystem reconciler provisions, per SFS: a PVC (`sfs-<hash>-files`, default `20Gi`, default access mode `ReadWriteOnce`), a single-replica `Recreate` Deployment (`wfc-<hash>`), a ClusterIP Service on the wfc port, and ingress/egress NetworkPolicies. All `WSF_*` env below is injected by that reconciler, except `WSF_JWT_ISSUER` and `WSF_JWT_AUDIENCE`, which are never injected — the service uses its in-code defaults.
- The wfc pod's root init container seeds `spec.directories[]` and chowns the fresh PVC to the configured UID/GID (default 1000:1000); the serving container then runs non-root with a read-only root filesystem, all capabilities dropped, and `automountServiceAccountToken: false`.
- With the default RWO PVC, the wfc is single-node; mcp-host consumer pods co-locate with it via podAffinity. Multi-node `ReadWriteMany` requires an RWX-capable StorageClass set explicitly via `spec.accessModes`.
- Stack: Express 5, multer (in-memory multipart uploads), jose (JWT verification), pino/pino-http logging.

## API

All non-streaming responses use the envelope `{ ok: true, data }` / `{ ok: false, error: { code, message } }` with stable `error.code` values.

| Route                                   | Scope         | Behavior                                                            |
| --------------------------------------- | ------------- | ------------------------------------------------------------------- |
| `GET /v1/files?path=<rel>`              | `files:read`  | List directory entries (capped, `truncated` flag)                   |
| `GET /v1/files/stat?path=<rel>`         | `files:read`  | File/directory metadata                                             |
| `GET /v1/files/download?path=<rel>`     | `files:read`  | Stream file contents as attachment                                  |
| `POST /v1/files/upload` (multipart)     | `files:write` | Create new file — `409 already_exists` if present                   |
| `PUT /v1/files/replace` (multipart)     | `files:write` | Whole-file replace — `404` if missing                               |
| `POST /v1/files/mkdir` `{path}`         | `files:write` | `mkdir -p`; idempotent on existing directories                      |
| `POST /v1/files/move` `{from, to}`      | `files:write` | Rename within the mount; refuses to clobber                         |
| `DELETE /v1/files?path=<rel>&recursive` | `files:write` | Delete file or directory (`409 not_empty` without `recursive=true`) |
| `GET /healthz`, `GET /readyz`           | none          | Liveness / readiness (mount present and writable)                   |

`/healthz` and `/readyz` are registered **before** auth — kubelet probes are unauthenticated. Everything under `/v1` requires a valid browsing JWT.

## Configuration

| Variable                          | Explanation                                                                     | Default                      |
| --------------------------------- | ------------------------------------------------------------------------------- | ---------------------------- |
| `WSF_PORT`                        | HTTP listen port.                                                               | `8086`                       |
| `WSF_MOUNT_PATH`                  | Absolute path of the mounted SFS PVC.                                           | `/workspace`                 |
| `WSF_SHARED_FILESYSTEM_NAME`      | SFS identity this instance serves; the JWT `sharedFileSystem` claim must match. | required                     |
| `WSF_SHARED_FILESYSTEM_NAMESPACE` | SFS namespace; the JWT `sharedFileSystemNamespace` claim must match.            | required                     |
| `WSF_JWT_PUBLIC_KEY`              | PEM-encoded RSA public key for verifying browsing JWTs.                         | required                     |
| `WSF_JWT_ISSUER`                  | Required JWT `iss` claim.                                                       | `control-api`                |
| `WSF_JWT_AUDIENCE`                | Required JWT `aud` claim.                                                       | `workspace-files-controller` |
| `WSF_MAX_UPLOAD_BYTES`            | Per-file upload cap; larger uploads get `413 payload_too_large`.                | `104857600` (100 MiB)        |
| `WSF_MAX_LIST_ENTRIES`            | Max entries returned by a single directory listing.                             | `5000`                       |
| `WSF_MAX_PATH_DEPTH`              | Max path depth (segments) accepted from clients.                                | `32`                         |

## Security Model

**Auth.** Browsing JWTs are short-lived RS256 tokens minted by control-api (signed with the same keypair as RPC tokens; audience separation keeps the token kinds apart). The wfc rejects any token unless **all** of: `iss` matches, `aud` matches, `sharedFileSystem` and `sharedFileSystemNamespace` claims equal **this** instance's SFS, and `scopes` contains only entries from the closed set `files:read` / `files:write` (unknown or duplicate scopes are rejected outright). Scopes are then enforced per route. Audience or SFS mismatch is `403`; signature/expiry failures are `401`.

**Path safety.** Every client path is validated lexically (reject `..`, backslash, ASCII control chars, excess depth; resolve under the mount root) and physically (each existing segment is `lstat`ed — symlinks are rejected or omitted everywhere: directory listings silently skip symlink entries, and every other operation (listing roots, move sources, delete targets, …) hard-rejects with `path_invalid` — with a `realpath` containment check). Writes re-validate the chain **after** `mkdir`/`rename` to defend against TOCTOU symlink swaps, uploads go to a temp sibling then rename atomically so partial writes never appear at the destination, and the mount root itself can never be written, replaced, moved, or deleted.

**Network.** The HCC-generated NetworkPolicies allow ingress only from control-api pods on the wfc port, and egress to DNS only — a compromised mcp-host pod cannot reach the writable side of its own workspace.

## Development

```bash
npm install
WSF_SHARED_FILESYSTEM_NAME=dev WSF_SHARED_FILESYSTEM_NAMESPACE=mcp-host \
WSF_JWT_PUBLIC_KEY="$(cat public.pem)" npm run dev
```

### Testing

```bash
npm test
```

Five vitest suites cover config loading, JWT verification, path safety, and the read/write route behavior (via supertest against the composed Express app).

## Deployment

There are no static manifests for this service: instances are created dynamically by host-context-controller when a SharedFileSystem CRD is applied. The image, port, JWT public key ConfigMap, and `WSF_MAX_*` limits are configured on HCC via `CONTEXT_MAPPER_WFC_*` env (see [deploy/base/control-plane/host-context-controller.yaml](../deploy/base/control-plane/host-context-controller.yaml) and [host-context-controller/src/config.ts](../host-context-controller/src/config.ts)). See the [SharedFileSystem CRD reference](../docs/crds/sharedfilesystem.md) for the resource that drives it.
