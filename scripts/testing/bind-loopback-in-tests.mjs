// Vitest setup file: make an ephemeral bind with no host bind IPv4 loopback.
//
// THE DEFECT
//
// `server.listen(0)` with no host binds the dual-stack wildcard `[::]:0`, while
// clients in tests connect to `127.0.0.1`. Those are different addresses. On
// macOS the sequential ephemeral allocator can hand the dual-stack socket a
// port that an IPv4-only `127.0.0.1` listener already holds, because such a
// listener is not a conflict for a `[::]` bind. The kernel then delivers the
// client's IPv4 connection to that more specific listener instead of to the
// test server.
//
// A developer host running Docker Desktop with minikube holds one such listener
// per mapped port per profile, all inside the ephemeral range, so the test talks
// to Docker and parses whatever it answers:
//
//   port 22 mapping    -> an SSH banner -> `Parse Error: Expected HTTP/, RTSP/ or ICE/`
//   8443/2376 mappings -> an HTTP 400   -> a status assertion fails for no reason
//   5000/32443         -> a reset       -> `socket hang up`
//
// Whichever request draws the occupied port is the one that fails, so the
// symptom moves between runs and between cases and reads as flakiness. It
// aborted T2 run10 in `codex-llm-proxy` test (e).
//
// WHY A SHIM RATHER THAN CALL-SITE EDITS
//
// 174 test files across seven packages reach this through `supertest`, whose
// `request(app)` performs the host-less `listen(0)` itself
// (`supertest/lib/test.js:63`). Fixing those at the call site means giving every
// one of them an explicit server lifecycle; the bind is not ours to pass a host
// to. Patching the one primitive they all funnel through fixes every call site,
// including supertest's own.
//
// WHAT IS AND IS NOT REWRITTEN
//
// Only the case where the caller expressed no preference at all: port 0 with no
// host. An explicit host is honoured, a fixed port is left alone (a fixed port
// cannot be mis-allocated), and IPC/pipe listens are untouched. Binding a test
// server on loopback is also what a test means: nothing in this repository
// tests reachability from another host.
//
// This runs only under vitest, through `setupFiles`. No production code path
// loads it.
import net from 'node:net'

const LOOPBACK = '127.0.0.1'
const originalListen = net.Server.prototype.listen

/** True when the argument list carries no host, so the kernel would pick `[::]`. */
function hostIsAbsent(args) {
  // listen(port, host?, backlog?, callback?) — the host, if given, is a string
  // in position 1. Anything else there (a backlog number, a callback) means no
  // host was passed.
  return typeof args[1] !== 'string'
}

net.Server.prototype.listen = function listenOnLoopbackWhenEphemeral(...args) {
  const [first] = args

  if (first === 0 && hostIsAbsent(args)) {
    return originalListen.call(this, 0, LOOPBACK, ...args.slice(1))
  }

  if (
    first !== null &&
    typeof first === 'object' &&
    first.port === 0 &&
    first.host === undefined &&
    first.path === undefined
  ) {
    return originalListen.call(this, { ...first, host: LOOPBACK }, ...args.slice(1))
  }

  return originalListen.apply(this, args)
}
