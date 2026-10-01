import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  objectHash,
  validateChallenge,
  validateRuntimeClosure,
  noSqliteHandles,
  parsedPins,
  measureSource,
} from "../conversation-store/verify-inline.mjs";
import { probeImage } from "../conversation-store/image-probe.mjs";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const require = createRequire(path.join(root, "mcp-host/package.json"));
const core = require(
  path.join(root, "mcp-host/dist/db/canonicalStore/paths.js"),
);
const pins = {
  hostName: "fixture-host",
  namespace: "mcp-host",
  hostUid: "fixture-host-uid",
  pvcUid: "fixture-pvc-uid",
  podUid: "fixture-pod-uid",
  requestId: "fixture-request",
  maintenanceId: "fixture-maintenance",
  sourceClass: "sqlite-pvc",
};
function challenge() {
  return {
    metadata: {
      name: pins.hostName,
      namespace: pins.namespace,
      uid: pins.hostUid,
    },
    status: {
      conversationStore: {
        request: {
          schemaVersion: 1,
          operation: "prepare",
          sourceClass: pins.sourceClass,
          requestId: pins.requestId,
          hostUid: pins.hostUid,
          pvcUid: pins.pvcUid,
          maintenanceId: pins.maintenanceId,
          principal: { kind: "control-admin", subject: "fixture-operator" },
        },
        requestResult: {
          requestId: pins.requestId,
          hostUid: pins.hostUid,
          pvcUid: pins.pvcUid,
          state: "completed",
        },
        maintenance: {
          maintenanceId: pins.maintenanceId,
          hostUid: pins.hostUid,
          pvcUid: pins.pvcUid,
          phase: "quiescing",
        },
      },
    },
  };
}
const subject = {
  status: {
    userInfo: {
      extra: { "authentication.kubernetes.io/pod-uid": [pins.podUid] },
    },
  },
};
test("canonical JSON hash matches the engine for nested measured facts", () =>
  assert.equal(
    objectHash({ z: [1, null, { b: "x", a: true }], a: undefined }),
    core.objectHash({ z: [1, null, { b: "x", a: true }], a: undefined }),
  ));
test("completed maintenance intent stays latched and fresh challenge accepts it", () =>
  validateChallenge(challenge(), subject, pins, "prepare"));
test("tenant principal, release, stale binding, missing pod identity and rejected intent block", () => {
  for (const mutate of [
    (host) => (host.status.conversationStore.request.principal.kind = "tenant"),
    (host) => (host.status.conversationStore.maintenance.phase = "released"),
    (host) => (host.metadata.uid = "another-host"),
    (host) => (host.status.conversationStore.requestResult.state = "rejected"),
  ]) {
    const host = challenge();
    mutate(host);
    assert.throws(() => validateChallenge(host, subject, pins, "prepare"));
  }
  assert.throws(() =>
    validateChallenge(
      challenge(),
      { status: { userInfo: { extra: {} } } },
      pins,
      "prepare",
    ),
  );
});
test("ACK-shaped booleans and memory/unknown data never become closure", () => {
  const report = {
    schemaVersion: 1,
    contractVersion: 1,
    hostUid: pins.hostUid,
    pvcUid: pins.pvcUid,
    podUid: pins.podUid,
    maintenanceId: pins.maintenanceId,
    process: {
      pid: 1,
      uid: 1001,
      startTimeTicks: "99",
      executable: "/usr/local/bin/node",
      script: "/app/mcp-host/dist/main.js",
    },
    source: { mode: "sqlite", dbPath: "/state/state.db" },
    closure: "acknowledged-worker-exit",
    observedAt: new Date().toISOString(),
  };
  validateRuntimeClosure(report, pins);
  for (const bad of [
    { ...report, closed: true },
    { ...report, source: { mode: "memory", dbPath: "/state/state.db" } },
    {
      ...report,
      source: {
        mode: "sqlite",
        dbPath: "/state/state.db",
        transcript: "forbidden fixture field",
      },
    },
    { ...report, closure: "SIGSTOP" },
  ])
    assert.throws(() => validateRuntimeClosure(bad, pins));
});
test("physical FD inventory detects original and sidecar handles, not JSON ownership", () => {
  const proc = fs.mkdtempSync(
    path.join(os.tmpdir(), "conversation-proc-fixture-"),
  );
  try {
    fs.mkdirSync(path.join(proc, "42/fd"), { recursive: true });
    fs.symlinkSync("/state/state.db-wal", path.join(proc, "42/fd/3"));
    assert.throws(
      () => noSqliteHandles(["/state/state.db"], proc),
      /WriterFenceBusy/,
    );
    fs.unlinkSync(path.join(proc, "42/fd/3"));
    noSqliteHandles(["/state/state.db"], proc);
  } finally {
    fs.rmSync(proc, { recursive: true, force: true });
  }
});
test("source CLI cannot choose new-empty or silently omit the physical mount pins", () => {
  assert.throws(() => parsedPins(["--source-class", "new-host"]));
  assert.throws(() => parsedPins(["--source-class", "sqlite-pvc"]));
});
test("HCC inline program is byte-identical to the reviewed standalone verifier", () => {
  const text = fs.readFileSync(
    path.join(
      root,
      "host-context-controller/src/conversationStoreBootstrapProgram.ts",
    ),
    "utf8",
  );
  const lines = text
    .split("\n")
    .filter((line) => line.startsWith("  "))
    .map((line) => JSON.parse(line.trim().replace(/,$/, "")))
    .join("");
  assert.equal(
    lines,
    fs.readFileSync(
      path.join(root, "scripts/conversation-store/verify-inline.mjs"),
      "utf8",
    ),
  );
});
test("real local SQLite/CLI/worker fixture preserves the complete catalog and new write", async () => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "conversation-image-fixture-")),
  );
  try {
    const proof = await probeImage(path.join(root, "mcp-host"), directory, {
      expectedUid: process.getuid(),
      expectedGid: process.getgid(),
    });
    assert.equal(proof.sessions, 3);
    assert.equal(proof.messagesBefore, 5);
    assert.equal(proof.messagesAfter, 6);
    assert.equal(proof.approvals, 1);
    assert.equal(proof.sourceCatalogHash, proof.preservedCatalogHash);
    assert.equal(proof.sourceCatalogHash, proof.floorCatalogHash);
    assert.match(proof.floorMigrationId, /^[0-9a-f-]{36}$/i);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a forged UID1001 closure report cannot pass a real held SQLite writer fence", async () => {
  const fixture = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "conversation-held-fence-")),
  );
  const state = path.join(fixture, "state");
  fs.mkdirSync(state, { mode: 0o700 });
  const proc = path.join(fixture, "proc");
  fs.mkdirSync(proc);
  const scratch = path.join(fixture, "scratch");
  fs.mkdirSync(scratch, { mode: 0o700 });
  const loaded = require(
    path.join(root, "mcp-host/dist/db/canonicalStore/index.js"),
  );
  const Database = require("better-sqlite3");
  const { runMigrations } = require(
    path.join(root, "mcp-host/dist/db/migrate.js"),
  );
  const dbPath = path.join(state, "state.db");
  const db = new Database(dbPath);
  runMigrations(db);
  db.close();
  const identity = {
    pid: 77,
    uid: 1001,
    startTimeTicks: "900",
    executable: "/usr/local/bin/node",
    script: "/app/mcp-host/dist/main.js",
    argvHash: "a".repeat(64),
    mainSha256: "b".repeat(64),
  };
  const report = {
    schemaVersion: 1,
    contractVersion: 1,
    hostUid: pins.hostUid,
    pvcUid: pins.pvcUid,
    maintenanceId: pins.maintenanceId,
    podUid: pins.podUid,
    process: {
      pid: identity.pid,
      uid: 1001,
      startTimeTicks: identity.startTimeTicks,
      executable: identity.executable,
      script: identity.script,
    },
    source: { mode: "sqlite", dbPath },
    closure: "acknowledged-worker-exit",
    observedAt: new Date().toISOString(),
  };
  const held = loaded.acquireWriterFence({ stateDir: state, timeoutMs: 10 });
  const reportDir = path.join(
    state,
    ".canonical-store",
    "maintenance",
    pins.maintenanceId,
  );
  fs.mkdirSync(reportDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(reportDir, `${pins.podUid}.json`),
    JSON.stringify(report),
    { mode: 0o600 },
  );
  try {
    await assert.rejects(
      measureSource(
        {
          ...pins,
          stateDir: state,
          sourcePath: dbPath,
          sourceClass: "sqlite-pvc",
        },
        {
          core: loaded,
          procRoot: proc,
          scratchRoot: scratch,
          readProcess: () => identity,
        },
      ),
      /WriterFenceBusy/,
    );
    held.close();
    const measured = await measureSource(
      {
        ...pins,
        stateDir: state,
        sourcePath: dbPath,
        sourceClass: "sqlite-pvc",
      },
      {
        core: loaded,
        procRoot: proc,
        scratchRoot: scratch,
        readProcess: () => identity,
      },
    );
    assert.equal(measured.proof.uid, 1001);
    assert.equal(measured.proof.writerStopped, true);
    assert.equal(measured.proof.closedWitnessHash, objectHash(measured.facts));
  } finally {
    held.close();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("same request ID does not authorize another source class or export manifest", () => {
  const host = challenge();
  assert.throws(
    () =>
      validateChallenge(
        host,
        subject,
        {
          ...pins,
          sourceClass: "sqlite-external-exported",
          exportId: "fixture-export",
          manifestHash: "a".repeat(64),
        },
        "prepare",
      ),
    /AdoptBindingMismatch/,
  );
  const revision = validateChallenge(host, subject, pins, "prepare");
  host.status.conversationStore.request.targetImage = "another-fixture-image";
  assert.notEqual(validateChallenge(host, subject, pins, "prepare"), revision);
});

test("image output requires UID/GID1001, Node24, complete checks, full hashes and nonzero fixture counts", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "conversation-image-output-"),
  );
  const file = path.join(directory, "proof.json");
  const proof = {
    proofVersion: 1,
    outcome: "ok",
    uid: 1001,
    gid: 1001,
    nodeVersion: "v24.18.0",
    sessions: 3,
    messagesBefore: 5,
    messagesAfter: 6,
    approvals: 1,
    sourceCatalogHash: "a".repeat(64),
    preservedCatalogHash: "a".repeat(64),
    floorCatalogHash: "a".repeat(64),
    floorMigrationId: "22222222-2222-4222-8222-222222222222",
    storeId: "11111111-1111-4111-8111-111111111111",
    checks: [
      "sqlite-load",
      "compiled-cli",
      "floor-migration",
      "floor-boot-check",
      "floor-catalog",
      "compiled-boot-check",
      "full-catalog",
      "worker-start",
      "writer-fence",
      "worker-close",
      "post-cutover-write",
      "stable-boot",
    ],
  };
  const run = (value) => {
    fs.writeFileSync(file, JSON.stringify(value));
    return spawnSync(
      process.execPath,
      [
        path.join(root, "scripts/conversation-store/verify-image-output.mjs"),
        file,
      ],
      { encoding: "utf8" },
    );
  };
  try {
    assert.equal(run(proof).status, 0);
    for (const value of [
      {},
      { ...proof, uid: 0 },
      { ...proof, gid: 0 },
      { ...proof, nodeVersion: "v26.7.0" },
      { ...proof, sessions: 0 },
      { ...proof, floorCatalogHash: "b".repeat(64) },
      { ...proof, floorMigrationId: undefined },
      {
        ...proof,
        sourceCatalogHash: undefined,
        preservedCatalogHash: undefined,
      },
      { ...proof, checks: ["sqlite-load"] },
    ])
      assert.notEqual(run(value).status, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test("image driver is lease-bound, offline, UID1001 and invokes fixed inspected image IDs", () => {
  const driver = fs.readFileSync(
    path.join(root, "scripts/conversation-store/verify-images.sh"),
    "utf8",
  );
  assert.match(driver, /require-t2-mutation-lock\.sh/);
  assert.match(driver, /--pull=never/);
  assert.match(driver, /--user 1001:1001/);
  assert.match(driver, /--network=none/);
  assert.match(driver, /"\$image_id" \/app\/mcp-host\/ops\/image-probe\.mjs/);
  assert.match(driver, /IMAGE_MISSING/);
  assert.match(driver, /count.*-gt 0/);
  const launcher = fs
    .readFileSync(path.join(root, "mcp-host/50-mcp-host-service"), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
  assert.doesNotMatch(launcher, /chown.*\/app/);
  assert.doesNotMatch(launcher, /\|\| true/);
  assert.doesNotMatch(launcher, /newest-source-wins|state-migrate/);
});
