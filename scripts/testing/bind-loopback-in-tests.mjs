// Vitest setup file: give an ephemeral test bind exclusive ownership of the
// IPv4 loopback address its clients actually dial.
//
// THE DEFECT
//
// `server.listen(0)` with no host binds the dual-stack wildcard `[::]:0`, while
// clients in tests connect to `127.0.0.1`. Those are different addresses, and an
// IPv4-only `127.0.0.1` listener is not a bind conflict for a `[::]` bind, so
// the sequential ephemeral allocator on macOS can hand the test server a port
// another process already holds. The kernel then delivers the client's IPv4
// connection to that more specific listener instead of to the test server.
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
// (`supertest/lib/test.js:63`). The bind is not theirs to pass a host to.
//
// WHY THE NAME-RESOLUTION HOP IS COLLAPSED
//
// Asking for the host is not enough on its own, and the first revision of this
// file shipped exactly that mistake. `listen(port, host)` routes through
// `lookupAndListen` -> `dns.lookup(host, { all: true }, doListen)`, which is
// asynchronous even for an IP literal, so `server.address()` is null when
// `listen()` returns -- and supertest reads `app.address().port` on the very
// next line (`supertest/lib/test.js:67`). Every supertest suite failed with
// `TypeError: Cannot read properties of null (reading 'port')`.
//
// The bind itself is synchronous; only the resolution in front of it is not. So
// for the duration of a single `listen()` call -- installed and removed inside
// one synchronous window, where no other code can observe it -- `dns.lookup`
// answers an IP literal inline. `doListen` then runs within `listen()`, the
// handle is bound before it returns, and `address()` reads the port.
// `'listening'` is still emitted on `nextTick`, so handlers attached after
// `listen()` returns still arrive in time.
//
// That calling convention (`{ all: true }`, answered with an array of
// `{ address, family }`) is Node's internal contract, not public API. Were a
// Node upgrade to change it, an inline answer Node no longer understands sends
// it back to the wildcard bind -- the defect this file exists to remove,
// reinstated silently. The bind is therefore asserted before `listen()`
// returns, so a changed contract fails the run instead.
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
import dns from 'node:dns'
import net from 'node:net'

const LOOPBACK = '127.0.0.1'
const INSTALLED = Symbol.for('evenfire.bindLoopbackInTests')

/** True when the argument list carries no host, so the kernel would pick `[::]`. */
function hostIsAbsent(args) {
  // listen(port, host?, backlog?, callback?) -- the host, if given, is a string
  // in position 1. Anything else there (a backlog number, a callback) means no
  // host was passed.
  return typeof args[1] !== 'string'
}

/**
 * The argument list to bind loopback instead, or `null` to leave the call alone.
 */
function withLoopbackHost(args) {
  const [first] = args

  if (first === 0 && hostIsAbsent(args)) {
    return [0, LOOPBACK, ...args.slice(1)]
  }

  if (
    first !== null &&
    typeof first === 'object' &&
    first.port === 0 &&
    first.host === undefined &&
    first.path === undefined
  ) {
    return [{ ...first, host: LOOPBACK }, ...args.slice(1)]
  }

  return null
}

/**
 * Answer an IP literal without leaving the current tick, so the bind Node
 * queues behind the lookup happens inside `listen()`.
 */
function lookupResolvingLiteralsInline(realLookup) {
  return function lookupInline(address, ...rest) {
    const callback = rest[rest.length - 1]
    const family = net.isIP(address)

    if (family === 0 || typeof callback !== 'function') {
      return realLookup.call(this, address, ...rest)
    }

    const options = rest.length > 1 ? rest[0] : undefined
    if (options !== null && typeof options === 'object' && options.all === true) {
      callback(null, [{ address, family }])
    } else {
      callback(null, address, family)
    }
    return undefined
  }
}

function assertBoundOnLoopback(server) {
  const address = server.address()
  if (address === null || typeof address === 'string' || address.address !== LOOPBACK) {
    throw new Error(
      `bind-loopback-in-tests: expected an ephemeral listen to be bound on ${LOOPBACK} ` +
        `by the time listen() returned, but address() reported ${JSON.stringify(address)}. ` +
        "Node's host resolution for listen() no longer matches the dns.lookup contract " +
        'this setup file collapses, so the bind fell back to the dual-stack wildcard. ' +
        'Fix scripts/testing/bind-loopback-in-tests.mjs rather than removing it: the ' +
        'wildcard bind is the defect it exists to prevent.'
    )
  }
}

if (net.Server.prototype.listen[INSTALLED] !== true) {
  const originalListen = net.Server.prototype.listen

  function listenOnLoopbackWhenEphemeral(...args) {
    const loopbackArgs = withLoopbackHost(args)
    if (loopbackArgs === null) {
      return originalListen.apply(this, args)
    }

    const realLookup = dns.lookup
    dns.lookup = lookupResolvingLiteralsInline(realLookup)
    try {
      const result = originalListen.apply(this, loopbackArgs)
      assertBoundOnLoopback(this)
      return result
    } finally {
      dns.lookup = realLookup
    }
  }

  listenOnLoopbackWhenEphemeral[INSTALLED] = true
  net.Server.prototype.listen = listenOnLoopbackWhenEphemeral
}
