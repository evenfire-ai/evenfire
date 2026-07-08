# Desktop Observation — Manual Smoke Test

This checklist validates the three layers of the desktop observation auth
flow end-to-end. Run after deploying changes to minikube.

## Prerequisites

- [ ] Minikube running: `make minikube-setup ARGS="--skip-build"` (or setup from scratch)
- [ ] `chatllm` pod running in `mcp-host` namespace with desktop enabled (`spec.desktop.x11: true`)
- [ ] Port-forwards active:
  ```bash
  kubectl port-forward -n rpc-proxy svc/rpc-proxy 8094:8094 &
  kubectl port-forward -n mcp-host svc/chatllm 3000:3000 &
  kubectl port-forward -n control-plane svc/host-context-controller-api-gateway 8081:8081 &
  ```
- [ ] Desktop app built: `cd desktop-app && npm run build`

## Layer 1 — Proxy Hop (manual)

Goal: prove that with a valid cookie, rpc-proxy correctly forwards HTTP + WebSocket to KasmVNC.

1. Generate a JWT + cookie via curl (replace `$TOKEN` with a minted JWT):
   ```bash
   curl -i -X POST "http://localhost:8094/api/v1/desktop/chatllm/session" \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{}'
   ```
   - Expect: `200 OK`, `Set-Cookie: clerum_desktop_session=...; Path=/api/v1/desktop/chatllm; HttpOnly; SameSite=Strict; Max-Age=3600`

2. Load the desktop in a browser:
   - Open DevTools → Application → Cookies → http://localhost:8094
   - Add cookie: `clerum_desktop_session` with the value from step 1, Path `/api/v1/desktop/chatllm`
   - Navigate to `http://localhost:8094/api/v1/desktop/chatllm/view/`
   - Expect: KasmVNC HTML loads, all static assets return 200 in Network tab
   - Expect: WebSocket connection to `/websockify` upgrades (101) and binary frames flow
   - Expect: XFCE desktop renders and responds to input

## Layer 2 — Auth Flow (automated)

```bash
cd tests/e2e && npx vitest run mcp-host/desktop-auth-flow-e2e.test.ts
```

Expected: 6 tests pass (1 happy path + 5 negative cases).

## Layer 1 — Proxy Hop (automated)

```bash
cd tests/e2e && npx vitest run mcp-host/desktop-proxy-hop-e2e.test.ts
```

Expected: 4 tests pass + 1 skip (cross-host test requires `E2E_HOST_REF_ALT`).

## Layer 3 — Full Stack (manual, desktop app)

1. Start port-forwards for the desktop app:
   ```bash
   make minikube-pf-desktop
   ```

2. Launch desktop app:
   ```bash
   cd desktop-app && npm start
   ```

3. Log in with dev credentials (`dev@clerum.local`).

4. Select the `chatllm` agent in the sidebar.

5. Verify button states:
   - [ ] If desktop is not running: "Retry Desktop" visible with error tooltip
   - [ ] If desktop is starting: "Starting..." disabled
   - [ ] If desktop is running: both "Open Desktop" and "Close Desktop" visible

6. Click **Open Desktop**:
   - [ ] A new Electron window opens titled "Desktop — chatllm"
   - [ ] XFCE desktop renders inside the window
   - [ ] Mouse and keyboard interact with the desktop (move cursor, click menu)
   - [ ] No token visible in the URL (should be just `/view/`)

7. Click **Close Desktop**:
   - [ ] The window closes
   - [ ] Status returns to `inactive` or `running` (depending on HCC polling)

8. Click **Open Desktop** again:
   - [ ] A fresh window opens (new session exchange)

## Negative Scenarios

9. Disable desktop on Host CRD temporarily (`kubectl edit host chatllm -n mcp-host`, remove `spec.desktop`), wait for HCC to reconcile, then click "Open Desktop":
   - [ ] Button shows "Retry Desktop" with error message

10. Revoke the JWT's `desktop:view` scope (edit user) and retry:
    - [ ] 403 surfaces as an error state

## Cleanup

```bash
pkill -f "port-forward.*svc/rpc-proxy"
pkill -f "port-forward.*svc/chatllm"
pkill -f "port-forward.*host-context-controller"
```
