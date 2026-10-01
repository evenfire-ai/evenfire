import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import {
  SQLITE_NAMES,
  blocked,
  confined,
  fileHash,
  freshChallenge,
  measureSource,
  objectHash,
  readJson,
  regular,
  trustedCore,
  verifyPhysicalReceipt,
} from "./verify-inline.mjs";
function fingerprints(directory) {
  return SQLITE_NAMES.map((name) => {
    const file = path.join(directory, name);
    if (!fs.existsSync(file))
      return { name, present: false, size: 0, sha256: null };
    return {
      name,
      present: true,
      size: regular(file, { maximum: 64 * 1024 ** 3 }).size,
      sha256: fileHash(file),
    };
  });
}
function managedDirectory(root, directory) {
  const relative = path.relative(root, directory);
  if (
    relative === ".." ||
    relative.startsWith("../") ||
    path.isAbsolute(relative)
  )
    blocked("LayoutUnsafe");
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
  confined(root, directory);
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.mode & 0o077) blocked("LayoutUnsafe");
}
function atomic(directory, name, value) {
  const file = path.join(directory, name);
  if (fs.existsSync(file)) {
    if (objectHash(readJson(file)) !== objectHash(value))
      blocked("CandidateChangedDuringMigration");
    return;
  }
  const temporary = path.join(directory, `${name}.${process.pid}.tmp`);
  const descriptor = fs.openSync(
    temporary,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.linkSync(temporary, file);
  fs.unlinkSync(temporary);
  const parent = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(parent);
  } finally {
    fs.closeSync(parent);
  }
}
function retain(from, to) {
  regular(from, { maximum: 64 * 1024 ** 3 });
  if (fs.existsSync(to)) {
    if (fileHash(from) !== fileHash(to))
      blocked("CandidateChangedDuringMigration");
    return;
  }
  fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(to, 0o600);
  const descriptor = fs.openSync(to, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}
export async function bootstrapExport(
  pins,
  {
    core = trustedCore(),
    challenge = freshChallenge,
    measure = measureSource,
    scratchRoot = "/tmp",
  } = {},
) {
  if (process.getuid?.() !== 1001) blocked("RuntimeUidMismatch");
  const authorityRevision = await challenge(pins, "maintenance");
  const measured = await measure(pins, { core });
  if (
    path.basename(pins.sourcePath) !== "state.db" ||
    fs.realpathSync(pins.sourcePath) !== pins.sourcePath
  )
    blocked("LayoutUnsafe");
  const fence = core.acquireWriterFence({
    stateDir: pins.stateDir,
    timeoutMs: 1000,
  });
  let scratch;
  let scratchIdentity;
  try {
    fence.assertHeld();
    const original = fingerprints(path.dirname(pins.sourcePath));
    if (
      !original[0].present ||
      objectHash(original) !== measured.proof.sourceSnapshotHash
    )
      blocked("CandidateChangedDuringMigration");
    const backupNames = fs
      .readdirSync(path.dirname(pins.sourcePath))
      .filter((name) =>
        /^state\.db(?:-wal|-shm|-journal)?\.pre-[A-Za-z0-9][A-Za-z0-9_.-]{0,100}\.bak$/.test(
          name,
        ),
      )
      .sort();
    if (backupNames.length > 192) blocked("ManifestTooLarge");
    const sourceBackups = backupNames.map((name) => {
      const file = path.join(path.dirname(pins.sourcePath), name);
      return {
        name,
        size: regular(file, { maximum: 64 * 1024 ** 3 }).size,
        sha256: fileHash(file),
      };
    });
    const bytes =
      original.reduce((sum, file) => sum + file.size, 0) +
      sourceBackups.reduce((sum, file) => sum + file.size, 0);
    const available = fs.statfsSync(pins.root, { bigint: true });
    if (
      BigInt(bytes) * 10n + 64n * 1024n * 1024n >
      available.bsize * available.bavail
    )
      blocked("InsufficientSpace");
    const parent = path.join(pins.root, ".canonical-store-bootstrap");
    managedDirectory(pins.root, parent);
    const directory = path.join(parent, pins.exportId);
    managedDirectory(pins.root, directory);
    const sources = path.join(directory, "sources");
    managedDirectory(pins.root, sources);
    const backups = path.join(directory, "backups");
    managedDirectory(pins.root, backups);
    for (const file of original.filter((file) => file.present))
      retain(
        path.join(path.dirname(pins.sourcePath), file.name),
        path.join(sources, file.name),
      );
    for (const file of sourceBackups)
      retain(
        path.join(path.dirname(pins.sourcePath), file.name),
        path.join(backups, file.name),
      );
    atomic(directory, "runtime-closure.json", measured.report);
    atomic(directory, "closed-facts.json", measured.facts);
    const temporary = fs.realpathSync(scratchRoot);
    if (
      temporary === pins.root ||
      temporary.startsWith(`${pins.root}${path.sep}`)
    )
      blocked("LayoutUnsafe");
    scratch = fs.mkdtempSync(path.join(temporary, "canonical-bootstrap-"));
    fs.chmodSync(scratch, 0o700);
    scratchIdentity = fs.lstatSync(scratch);
    for (const file of original.filter((file) => file.present)) {
      fs.copyFileSync(
        path.join(sources, file.name),
        path.join(scratch, file.name),
        fs.constants.COPYFILE_EXCL,
      );
      fs.chmodSync(path.join(scratch, file.name), 0o600);
    }
    // Reuse the same compiled engine/library. This does not invoke a new CLI,
    // install a package, checkpoint an original, or choose a lineage itself.
    const manifest = await core.exportCanonicalStore({
      root: pins.root,
      sourcePath: path.join(scratch, "state.db"),
      exportId: pins.exportId,
      binding: { hostUid: pins.hostUid, pvcUid: pins.pvcUid },
      maintenanceId: pins.maintenanceId,
      fence,
      timeoutMs: 120000,
    });
    if (manifest.catalogHash !== measured.proof.catalogHash)
      blocked("CandidateChangedDuringMigration");
    const receipt = {
      receiptVersion: 1,
      exportId: pins.exportId,
      requestId: pins.requestId,
      maintenanceId: pins.maintenanceId,
      hostUid: pins.hostUid,
      pvcUid: pins.pvcUid,
      sourcePodUid: pins.podUid,
      sourceMode: "sqlite",
      manifestHash: objectHash(manifest),
      catalogHash: manifest.catalogHash,
      sourceSchemaVersion: manifest.sourceSchemaVersion,
      sourceFiles: original,
      sourceSnapshotHash: objectHash(original),
      sourceBackups,
      backupSnapshotHash: objectHash(sourceBackups),
      closedWriter: measured.facts.process,
      closedWitnessHash: measured.proof.closedWitnessHash,
      runtimeClosureHash: measured.proof.runtimeClosureHash,
    };
    if (
      objectHash(fingerprints(path.dirname(pins.sourcePath))) !==
      receipt.sourceSnapshotHash
    )
      blocked("CandidateChangedDuringMigration");
    for (const file of sourceBackups)
      if (
        fileHash(path.join(path.dirname(pins.sourcePath), file.name)) !==
        file.sha256
      )
        blocked("CandidateChangedDuringMigration");
    fence.assertHeld();
    if ((await challenge(pins, "maintenance")) !== authorityRevision)
      blocked("AdoptBindingMismatch");
    atomic(directory, "receipt.json", receipt);
    return receipt;
  } finally {
    try {
      if (scratch) {
        const current = fs.lstatSync(scratch);
        if (
          !current.isDirectory() ||
          current.isSymbolicLink() ||
          current.dev !== scratchIdentity.dev ||
          current.ino !== scratchIdentity.ino
        )
          blocked("LayoutUnsafe");
        for (const name of fs.readdirSync(scratch)) {
          const file = confined(scratch, path.join(scratch, name));
          regular(file, { maximum: 64 * 1024 ** 3 });
          fs.unlinkSync(file);
        }
        fs.rmdirSync(scratch);
      }
    } finally {
      fence.close();
    }
  }
}
const invoked =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const { positionals, values } = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      strict: true,
      options: Object.fromEntries(
        [
          "host-name",
          "namespace",
          "host-uid",
          "pvc-uid",
          "pod-uid",
          "request-id",
          "maintenance-id",
          "export-id",
          "manifest-hash",
          "root",
          "state-dir",
          "source-path",
          "scratch-root",
        ].map((name) => [name, { type: "string" }]),
      ),
    });
    const pins = {
      hostName: values["host-name"],
      namespace: values.namespace,
      hostUid: values["host-uid"],
      pvcUid: values["pvc-uid"],
      podUid: values["pod-uid"],
      requestId: values["request-id"],
      maintenanceId: values["maintenance-id"],
      exportId: values["export-id"],
      manifestHash: values["manifest-hash"],
      sourceClass: "sqlite-external-exported",
      root: values.root ? path.resolve(values.root) : "",
      stateDir: values["state-dir"],
      sourcePath: values["source-path"],
    };
    for (const name of [
      "hostName",
      "namespace",
      "hostUid",
      "pvcUid",
      "podUid",
      "requestId",
      "maintenanceId",
      "exportId",
      "root",
      "stateDir",
      "sourcePath",
    ])
      if (!pins[name]) blocked("JournalInvalid");
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        pins.exportId,
      ) ||
      !path.isAbsolute(pins.stateDir) ||
      !path.isAbsolute(pins.sourcePath) ||
      positionals.length !== 1
    )
      blocked("JournalInvalid");
    let result;
    if (positionals[0] === "export")
      result = await bootstrapExport(pins, {
        scratchRoot: values["scratch-root"] ?? "/tmp",
      });
    else if (positionals[0] === "verify-receipt") {
      const revision = await freshChallenge(pins, "prepare");
      result = await verifyPhysicalReceipt(pins);
      if ((await freshChallenge(pins, "prepare")) !== revision)
        blocked("AdoptBindingMismatch");
    } else blocked("JournalInvalid");
    process.stdout.write(`${JSON.stringify({ outcome: "ok", result })}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ outcome: "blocked", reason: error.reason ?? "LegacyShutdownUnsupported" })}\n`,
    );
    process.exitCode = 1;
  }
}
