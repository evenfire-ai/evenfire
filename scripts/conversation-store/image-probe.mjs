import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { objectHash, blocked } from "./verify-inline.mjs";
// Synthetic image-only data; never point this probe at a business volume.
export async function probeImage(
  appRoot,
  root,
  { expectedUid = 1001, expectedGid = 1001 } = {},
) {
  if (
    process.getuid?.() !== expectedUid ||
    process.getgid?.() !== expectedGid ||
    !process.version.startsWith("v24.")
  )
    blocked("RuntimeUidMismatch");
  if (fs.readdirSync(root).length !== 0) blocked("ImageProbeRootNotEmpty");
  const require = createRequire(path.join(appRoot, "package.json"));
  const Database = require("better-sqlite3");
  const core = require(path.join(appRoot, "dist/db/canonicalStore/index.js"));
  const { runMigrations } = require(path.join(appRoot, "dist/db/migrate.js"));
  const source = new Database(path.join(root, "state.db"));
  runMigrations(source);
  for (let index = 1; index <= 3; index++)
    source
      .prepare(
        "INSERT INTO sessions(id,session_key,source,user_id,team_id,started_at,title) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        `image-session-${index}`,
        `image-key-${index}`,
        "control-ui",
        "image-user",
        "image-team",
        index,
        `Image fixture ${index}`,
      );
  for (let index = 1; index <= 5; index++)
    source
      .prepare(
        "INSERT INTO messages(id,session_id,ordinal,role,content,content_parts,tool_calls,timestamp) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(
        index,
        "image-session-1",
        index,
        index % 2 ? "user" : "assistant",
        `Image message ${index}`,
        JSON.stringify([{ type: "text", text: `part-${index}` }]),
        JSON.stringify([
          { id: `call-${index}`, name: "fixture-tool", arguments: { index } },
        ]),
        index,
      );
  source
    .prepare(
      "INSERT INTO pending_approvals(request_id,session_id,task_id,tool_name,tool_call_id,parameters,description,context_snapshot,registered_at,expires_at,task_budget) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      "image-approval",
      "image-session-1",
      "image-task",
      "fixture-tool",
      "image-call",
      '{"fixture":true}',
      "Image gate approval",
      '{"state":"preserved"}',
      1,
      9999999999,
      '{"remaining":3}',
    );
  const before = core.catalogFingerprint(source);
  source.close();
  const binding = { hostUid: "image-probe-host", pvcUid: "image-probe-pvc" };
  const cli = path.join(appRoot, "dist/db/canonicalStore/cli.js");
  const args = [
    "inspect",
    "--root",
    root,
    "--host-uid",
    binding.hostUid,
    "--pvc-uid",
    binding.pvcUid,
  ];
  const inspected = spawnSync(process.execPath, [cli, ...args], {
    timeout: 120000,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (inspected.status !== 0 || inspected.signal) blocked("ImageFloorMissing");
  const diagnostic = JSON.parse(inspected.stdout.trim());
  if (
    diagnostic.outcome !== "ok" ||
    diagnostic.candidates?.length !== 1 ||
    diagnostic.candidates[0].catalogHash !== before.catalogHash
  )
    blocked("ImageCatalogMismatch");
  // Offline image fixtures exercise the shared migration engine; the real
  // operator CLI keeps its fresh Kubernetes authorization requirement.
  const floor = await core.runMigration(root, { binding, writer: "layout-precheck" });
  if (floor.outcome !== "ok" || floor.storageContract !== "legacy-floor" || floor.storeId)
    blocked("ImageFloorMissing");
  const floorBoot = spawnSync(process.execPath, [cli, "boot-check", "--root", root,
    "--host-uid", binding.hostUid, "--pvc-uid", binding.pvcUid, "--storage-contract", "legacy-floor"],
    { timeout: 120000, encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (floorBoot.status !== 0 || floorBoot.signal || JSON.parse(floorBoot.stdout.trim()).reason !== "AlreadyLegacy")
    blocked("ImageBootCheckFailed");
  const floorDatabase = new Database(path.join(root, "state/state.db"), { readonly: true, fileMustExist: true });
  let floorCatalogHash;
  try {
    floorCatalogHash = core.catalogFingerprint(floorDatabase).catalogHash;
    if (floorCatalogHash !== before.catalogHash || floorDatabase.prepare("SELECT COUNT(*) AS count FROM canonical_store_identity").get().count !== 0)
      blocked("ImageCatalogMismatch");
  } finally { floorDatabase.close(); }
  const outcome = await core.runMigration(root, { binding });
  if (outcome.outcome !== "ok" || !outcome.storeId)
    blocked("ImageFloorMissing");
  const boot = spawnSync(
    process.execPath,
    [
      cli,
      "boot-check",
      "--root",
      root,
      "--host-uid",
      binding.hostUid,
      "--pvc-uid",
      binding.pvcUid,
    ],
    { timeout: 120000, encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
  if (boot.status !== 0 || JSON.parse(boot.stdout.trim()).outcome !== "ok")
    blocked("ImageBootCheckFailed");
  const file = path.join(root, "state/state.db");
  const checked = new Database(file, { fileMustExist: true });
  const after = core.catalogFingerprint(checked);
  if (
    before.catalogHash !== after.catalogHash ||
    after.counts.sessions !== 3 ||
    after.counts.messages !== 5 ||
    after.counts.pending_approvals !== 1
  )
    blocked("ImageCatalogMismatch");
  checked.close();
  const worker = new Worker(path.join(appRoot, "dist/db/worker/dbWorker.js"), {
    workerData: {
      dbPath: file,
      canonicalStore: { stateDir: path.dirname(file), binding, required: true },
      barrierMode: true,
      heartbeatMs: 5000,
      checkpointEveryWrites: 100,
    },
    stdout: true,
    stderr: true,
  });
  worker.stdout.resume();
  worker.stderr.resume();
  async function operation(id, kind) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.terminate();
        reject(new Error("ImageWorkerDeadline"));
      }, 10000);
      const onMessage = (message) => {
        if (message.id !== id && message.id !== "__fatal__") return;
        clearTimeout(timer);
        worker.off("message", onMessage);
        if (message.ok) resolve(message.result);
        else reject(new Error("ImageWorkerRejected"));
      };
      worker.on("message", onMessage);
      worker.once("error", () => {
        clearTimeout(timer);
        reject(new Error("ImageWorkerFailed"));
      });
      worker.postMessage({ id, op: { kind } });
    });
  }
  try {
    await operation("image-ping", "ping");
    let busy = false;
    try {
      core
        .acquireWriterFence({ stateDir: path.dirname(file), timeoutMs: 10 })
        .close();
    } catch (error) {
      if (error.reason === "WriterFenceBusy") busy = true;
      else throw error;
    }
    if (!busy) blocked("ImageFenceNotHeld");
    const closed = await operation("image-shutdown", "shutdown");
    if (closed?.closed !== true) blocked("ImageWorkerNotClosed");
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("ImageWorkerDeadline")),
        10000,
      );
      worker.once("exit", (code) => {
        clearTimeout(timer);
        code === 0 ? resolve() : reject(new Error("ImageWorkerFailed"));
      });
    });
  } finally {
    if (worker.threadId !== -1) await worker.terminate();
  }
  const fence = core.acquireWriterFence({
    stateDir: path.dirname(file),
    timeoutMs: 1000,
  });
  try {
    const identity = core.validateCanonicalStore({
      stateDir: path.dirname(file),
      binding,
    });
    const written = new Database(file, { fileMustExist: true });
    written
      .prepare(
        "INSERT INTO messages(session_id,ordinal,role,content,timestamp) VALUES (?,?,?,?,?)",
      )
      .run("image-session-1", 6, "user", "Post-cutover fixture write", 6);
    if (
      written.prepare("SELECT COUNT(*) AS count FROM messages").get().count !==
      6
    )
      blocked("ImageWriteMissing");
    written.close();
    if (identity.storeId !== outcome.storeId) blocked("ImageIdentityChanged");
  } finally {
    fence.close();
  }
  const stable = await core.runMigration(root, { binding });
  if (stable.reason !== "AlreadyCanonical") blocked("ImageStableBootFailed");
  return {
    proofVersion: 1,
    outcome: "ok",
    uid: process.getuid(),
    gid: process.getgid(),
    nodeVersion: process.version,
    sessions: 3,
    messagesBefore: 5,
    messagesAfter: 6,
    approvals: 1,
    sourceCatalogHash: before.catalogHash,
    preservedCatalogHash: after.catalogHash,
    floorCatalogHash,
    floorMigrationId: floor.migrationId,
    storeId: outcome.storeId,
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
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const proof = await probeImage("/app/mcp-host", "/inspect-root");
    process.stdout.write(`${JSON.stringify(proof)}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ proofVersion: 1, outcome: "blocked", reason: error.reason ?? "ImageProbeFailed" })}\n`,
    );
    process.exitCode = 1;
  }
}
