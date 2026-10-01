import * as fs from "node:fs";
import * as path from "node:path";
import * as https from "node:https";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

export const SQLITE_NAMES = [
  "state.db",
  "state.db-wal",
  "state.db-shm",
  "state.db-journal",
];
export function blocked(reason) {
  const error = new Error(reason);
  error.reason = reason;
  throw error;
}
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
// Deliberately identical to canonicalStore/paths.objectHash; parity is tested.
export const objectHash = (value) =>
  createHash("sha256").update(stableJson(value)).digest("hex");
export function regular(
  file,
  { owner, readonly = false, maximum = 8 * 1024 * 1024 } = {},
) {
  const stat = fs.lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > maximum ||
    (owner !== undefined && stat.uid !== owner) ||
    (readonly && stat.mode & 0o022)
  )
    blocked("LayoutUnsafe");
  return stat;
}
export function confined(root, file) {
  const base = fs.realpathSync(root);
  const relative = path.relative(base, path.resolve(file));
  if (
    relative === ".." ||
    relative.startsWith("../") ||
    path.isAbsolute(relative)
  )
    blocked("LayoutUnsafe");
  let current = base;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) blocked("LayoutUnsafe");
  }
  return current;
}
export function readJson(file, options = {}) {
  regular(file, options);
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    blocked("JournalInvalid");
  return value;
}
export function fileHash(file) {
  regular(file, { maximum: 64 * 1024 ** 3 });
  const descriptor = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  const buffer = Buffer.alloc(1024 * 1024);
  const digest = createHash("sha256");
  try {
    let count;
    while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null)))
      digest.update(buffer.subarray(0, count));
  } finally {
    fs.closeSync(descriptor);
  }
  return digest.digest("hex");
}
export function processIdentity(pid, procRoot = "/proc") {
  if (!Number.isSafeInteger(pid) || pid < 1) blocked("WriterIdentityUnknown");
  const directory = path.join(procRoot, String(pid));
  try {
    const statText = fs.readFileSync(path.join(directory, "stat"), "utf8");
    const suffix = statText
      .slice(statText.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    const status = fs.readFileSync(path.join(directory, "status"), "utf8");
    const identities = status.match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m);
    const uid = Number(identities?.[1]);
    if (
      !identities ||
      identities.slice(1).some((value) => Number(value) !== uid)
    )
      blocked("WriterIdentityUnknown");
    const argv = fs
      .readFileSync(path.join(directory, "cmdline"))
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    if (
      !Number.isSafeInteger(uid) ||
      !/^\d+$/.test(suffix[19]) ||
      argv.length === 0
    )
      blocked("WriterIdentityUnknown");
    return {
      pid,
      uid,
      startTimeTicks: suffix[19],
      executable: fs.realpathSync(path.join(directory, "exe")),
      argv,
      argvHash: objectHash(argv),
    };
  } catch (error) {
    if (error.code === "ENOENT" && !fs.existsSync(directory)) return undefined;
    throw error;
  }
}
export function noSqliteHandles(sourcePaths, procRoot = "/proc") {
  const names = new Set(
    sourcePaths.flatMap((file) => [
      file,
      `${file}-wal`,
      `${file}-shm`,
      `${file}-journal`,
    ]),
  );
  for (const name of fs
    .readdirSync(procRoot)
    .filter((name) => /^\d+$/.test(name))) {
    const directory = path.join(procRoot, name, "fd");
    let descriptors;
    try {
      descriptors = fs.readdirSync(directory);
    } catch (error) {
      if (error.code === "ENOENT" && !fs.existsSync(path.join(procRoot, name)))
        continue;
      blocked("WriterIdentityUnknown");
    }
    for (const descriptor of descriptors) {
      let target;
      try {
        target = fs
          .readlinkSync(path.join(directory, descriptor))
          .replace(/ \(deleted\)$/, "");
      } catch (error) {
        if (error.code === "ENOENT") continue;
        blocked("WriterIdentityUnknown");
      }
      if (names.has(target)) blocked("WriterFenceBusy");
    }
  }
}
export function validateChallenge(host, subject, pins, operation) {
  const store = host?.status?.conversationStore;
  const request = store?.request;
  const result = store?.requestResult;
  const maintenance = store?.maintenance;
  const ownPod =
    subject?.status?.userInfo?.extra?.["authentication.kubernetes.io/pod-uid"];
  if (
    !Array.isArray(ownPod) ||
    ownPod.length !== 1 ||
    ownPod[0] !== pins.podUid
  )
    blocked("PodIdentityUnknown");
  if (
    host.metadata?.uid !== pins.hostUid ||
    host.metadata?.name !== pins.hostName ||
    host.metadata?.namespace !== pins.namespace ||
    !request ||
    request.schemaVersion !== 1 ||
    request.operation !== operation ||
    request.requestId !== pins.requestId ||
    request.hostUid !== pins.hostUid ||
    request.pvcUid !== pins.pvcUid ||
    request.maintenanceId !== pins.maintenanceId ||
    request.principal?.kind !== "control-admin" ||
    typeof request.principal.subject !== "string" ||
    !request.principal.subject ||
    !result ||
    result.requestId !== pins.requestId ||
    result.hostUid !== pins.hostUid ||
    result.pvcUid !== pins.pvcUid ||
    !["accepted", "completed"].includes(result.state) ||
    !maintenance ||
    maintenance.hostUid !== pins.hostUid ||
    maintenance.pvcUid !== pins.pvcUid ||
    maintenance.maintenanceId !== pins.maintenanceId ||
    !["quiescing", "fenced", "migrating", "completing", "completed"].includes(
      maintenance.phase,
    )
  )
    blocked("MigrationMaintenanceRequired");
  if (
    operation === "prepare" &&
    (request.sourceClass !== pins.sourceClass ||
      request.exportId !== pins.exportId ||
      request.manifestHash !== pins.manifestHash)
  )
    blocked("AdoptBindingMismatch");
  return objectHash(request);
}
export async function freshChallenge(pins, operation) {
  const address = process.env.KUBERNETES_SERVICE_HOST;
  const port = Number(
    process.env.KUBERNETES_SERVICE_PORT_HTTPS ??
      process.env.KUBERNETES_SERVICE_PORT,
  );
  if (!address || !Number.isSafeInteger(port) || port < 1 || port > 65535)
    blocked("HostAuthorityUnavailable");
  const serviceDirectory = "/var/run/secrets/kubernetes.io/serviceaccount";
  const ca = fs.readFileSync(path.join(serviceDirectory, "ca.crt"));
  const authBytes = fs
    .readFileSync(path.join(serviceDirectory, "token"), "utf8")
    .trim();
  if (!authBytes) blocked("HostAuthorityUnavailable");
  async function requestJson(route, body) {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : undefined;
      const request = https.request(
        {
          hostname: address,
          port,
          path: route,
          method: body ? "POST" : "GET",
          ca,
          rejectUnauthorized: true,
          signal: AbortSignal.timeout(10000),
          headers: {
            Authorization: `Bearer ${authBytes}`,
            ...(body
              ? {
                  "Content-Type": "application/json",
                  "Content-Length": Buffer.byteLength(payload),
                }
              : {}),
          },
        },
        (response) => {
          const chunks = [];
          let size = 0;
          response.on("data", (chunk) => {
            size += chunk.length;
            if (size > 1024 * 1024)
              request.destroy(new Error("HostAuthorityUnavailable"));
            else chunks.push(chunk);
          });
          response.on("end", () => {
            try {
              if (response.statusCode !== 200 && response.statusCode !== 201)
                blocked("HostAuthorityUnavailable");
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch {
              reject(new Error("HostAuthorityUnavailable"));
            }
          });
          response.on("error", () =>
            reject(new Error("HostAuthorityUnavailable")),
          );
        },
      );
      request.setTimeout(10000, () =>
        request.destroy(new Error("HostAuthorityUnavailable")),
      );
      request.on("error", () => reject(new Error("HostAuthorityUnavailable")));
      request.end(payload);
    });
  }
  const host = await requestJson(
    `/apis/clerum.io/v1alpha1/namespaces/${encodeURIComponent(pins.namespace)}/hosts/${encodeURIComponent(pins.hostName)}`,
  );
  const subject = await requestJson(
    "/apis/authentication.k8s.io/v1/selfsubjectreviews",
    { apiVersion: "authentication.k8s.io/v1", kind: "SelfSubjectReview" },
  );
  return validateChallenge(host, subject, pins, operation);
}
export function validateRuntimeClosure(report, pins) {
  const fields = [
    "schemaVersion",
    "contractVersion",
    "hostUid",
    "pvcUid",
    "maintenanceId",
    "podUid",
    "process",
    "source",
    "closure",
    "observedAt",
  ];
  if (
    Object.keys(report).some((key) => !fields.includes(key)) ||
    report.schemaVersion !== 1 ||
    report.contractVersion !== 1 ||
    report.closure !== "acknowledged-worker-exit" ||
    report.hostUid !== pins.hostUid ||
    report.pvcUid !== pins.pvcUid ||
    report.podUid !== pins.podUid ||
    report.maintenanceId !== pins.maintenanceId ||
    report.source?.mode !== "sqlite" ||
    !path.isAbsolute(report.source.dbPath ?? "") ||
    !Number.isFinite(Date.parse(report.observedAt))
  )
    blocked("MigrationMaintenanceRequired");
  if (
    Object.keys(report.process ?? {}).some(
      (key) =>
        !["pid", "uid", "startTimeTicks", "executable", "script"].includes(key),
    ) ||
    Object.keys(report.source ?? {}).some(
      (key) => !["mode", "dbPath"].includes(key),
    )
  )
    blocked("JournalInvalid");
  return report;
}
export function verifyLiveProcess(
  report,
  { procRoot = "/proc", expectedUid = 1001 } = {},
) {
  const measured = processIdentity(report.process.pid, procRoot);
  if (
    !measured ||
    measured.uid !== expectedUid ||
    report.process.uid !== expectedUid ||
    measured.startTimeTicks !== report.process.startTimeTicks ||
    measured.executable !== report.process.executable
  )
    blocked("WriterIdentityChanged");
  const cwd = fs.realpathSync(path.join(procRoot, String(measured.pid), "cwd"));
  const script = measured.argv[1]
    ? fs.realpathSync(path.resolve(cwd, measured.argv[1]))
    : "";
  if (
    script !== report.process.script ||
    script !== "/app/mcp-host/dist/main.js"
  )
    blocked("ImageFloorMissing");
  const allowed = [
    "CLERUM_SESSION_STORE",
    "CLERUM_SESSION_DB_DIR",
    "CLERUM_SESSION_DB_PATH",
  ];
  const environment = Object.fromEntries(
    fs
      .readFileSync(path.join(procRoot, String(measured.pid), "environ"))
      .toString("utf8")
      .split("\0")
      .map((entry) => {
        const separator = entry.indexOf("=");
        return [entry.slice(0, separator), entry.slice(separator + 1)];
      })
      .filter(([name]) => allowed.includes(name)),
  );
  if (environment.CLERUM_SESSION_STORE !== "sqlite")
    blocked("StoreModeUnknown");
  const configured = environment.CLERUM_SESSION_DB_DIR
    ? path.join(environment.CLERUM_SESSION_DB_DIR, "state.db")
    : environment.CLERUM_SESSION_DB_PATH;
  if (
    !configured ||
    !path.isAbsolute(configured) ||
    path.resolve(configured) !== report.source.dbPath
  )
    blocked("SourceExportRequired");
  return { ...measured, script, mainSha256: fileHash(script) };
}
export function immutableCodeTree(
  directory,
  { ownerUid = 0, maximum = 512 } = {},
) {
  let count = 0;
  function visit(file) {
    if (++count > maximum) blocked("ImageFloorMissing");
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || stat.uid !== ownerUid || stat.mode & 0o022)
      blocked("ImageFloorMissing");
    if (stat.isDirectory())
      for (const name of fs.readdirSync(file)) visit(path.join(file, name));
    else
      regular(file, {
        owner: ownerUid,
        readonly: true,
        maximum: 32 * 1024 * 1024,
      });
  }
  visit(directory);
}
export function trustedCore(appRoot = "/app/mcp-host") {
  for (const directory of [
    appRoot,
    path.join(appRoot, "dist"),
    path.join(appRoot, "node_modules"),
  ]) {
    const stat = fs.lstatSync(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== 0 ||
      stat.mode & 0o022
    )
      blocked("ImageFloorMissing");
  }
  for (const directory of [
    "dist/db/canonicalStore",
    "dist/db/migrations",
    "node_modules/better-sqlite3",
    "node_modules/bindings",
    "node_modules/file-uri-to-path",
  ])
    immutableCodeTree(path.join(appRoot, directory));
  for (const file of [
    "dist/main.js",
    "dist/db/migrate.js",
    "dist/runtime/canonicalStoreMaintenance.js",
  ])
    regular(path.join(appRoot, file), { owner: 0, readonly: true });
  const require = createRequire(path.join(appRoot, "package.json"));
  const core = require(path.join(appRoot, "dist/db/canonicalStore/index.js"));
  if (
    typeof core.acquireWriterFence !== "function" ||
    typeof core.inspectCandidate !== "function"
  )
    blocked("ImageFloorMissing");
  return core;
}
export async function measureSource(
  pins,
  {
    core = trustedCore(),
    procRoot = "/proc",
    expectedUid = 1001,
    scratchRoot = "/tmp",
    readProcess = verifyLiveProcess,
  } = {},
) {
  const reportPath = path.join(
    pins.stateDir,
    ".canonical-store",
    "maintenance",
    pins.maintenanceId,
    `${pins.podUid}.json`,
  );
  const report = validateRuntimeClosure(
    readJson(confined(pins.stateDir, reportPath)),
    pins,
  );
  const process = readProcess(report, { procRoot, expectedUid });
  if (report.source.dbPath !== pins.sourcePath) blocked("SourceExportRequired");
  noSqliteHandles([pins.sourcePath], procRoot);
  // A writable same-PVC EXCLUSIVE fence is an actual contention test. Report
  // ownership/booleans cannot grant this capability or prove an empty store.
  const fence = core.acquireWriterFence({
    stateDir: pins.stateDir,
    timeoutMs: 1000,
  });
  let inspection;
  try {
    fence.assertHeld();
    inspection = await core.inspectCandidate(path.dirname(pins.sourcePath), {
      root: path.dirname(pins.sourcePath),
      scratchRoot,
      scratchDir: path.join(scratchRoot, ".canonical-store-proof"),
      binding: { hostUid: pins.hostUid, pvcUid: pins.pvcUid },
      fence,
      timeoutMs: 120000,
    });
    const after = readProcess(report, { procRoot, expectedUid });
    if (objectHash(after) !== objectHash(process))
      blocked("WriterIdentityChanged");
    noSqliteHandles([pins.sourcePath], procRoot);
    fence.assertHeld();
    const writer = {
      pid: process.pid,
      startTimeTicks: process.startTimeTicks,
      uid: expectedUid,
      argvHash: process.argvHash,
      executable: process.executable,
      script: process.script,
      mainSha256: process.mainSha256,
    };
    const facts = {
      factVersion: 1,
      hostUid: pins.hostUid,
      pvcUid: pins.pvcUid,
      podUid: pins.podUid,
      maintenanceId: pins.maintenanceId,
      process: writer,
      source: {
        mode: "sqlite",
        dbPath: pins.sourcePath,
        sourceSnapshotHash: inspection.sourceHash,
        catalogHash: inspection.catalogHash,
      },
      fence: "sqlite-exclusive",
    };
    const proof = {
      proofVersion: 1,
      outcome: "ok",
      hostUid: pins.hostUid,
      pvcUid: pins.pvcUid,
      sourcePodUid: pins.podUid,
      requestId: pins.requestId,
      maintenanceId: pins.maintenanceId,
      sourceClass: pins.sourceClass,
      sourceMode: "sqlite",
      sourcePath: pins.sourcePath,
      writerStopped: true,
      sourceSnapshotHash: inspection.sourceHash,
      catalogHash: inspection.catalogHash,
      sourceSchemaVersion: inspection.schemaVersion,
      closedWitnessHash: objectHash(facts),
      runtimeClosureHash: objectHash(report),
      ...writer,
    };
    return { proof, facts, report, sourceFiles: inspection.sourceFiles };
  } finally {
    try {
      inspection?.dispose();
    } finally {
      fence.close();
    }
  }
}
export function readBootstrapReceipt(root, exportId) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      exportId,
    )
  )
    blocked("JournalInvalid");
  const directory = path.join(root, ".canonical-store-bootstrap", exportId);
  return {
    directory,
    receipt: readJson(confined(root, path.join(directory, "receipt.json"))),
  };
}
export async function verifyPhysicalReceipt(pins, options = {}) {
  const measured = await measureSource(pins, options);
  if (pins.sourceClass === "sqlite-pvc") return measured.proof;
  const { directory, receipt } = readBootstrapReceipt(pins.root, pins.exportId);
  if (
    receipt.receiptVersion !== 1 ||
    receipt.exportId !== pins.exportId ||
    receipt.hostUid !== pins.hostUid ||
    receipt.pvcUid !== pins.pvcUid ||
    receipt.sourcePodUid !== pins.podUid ||
    receipt.maintenanceId !== pins.maintenanceId ||
    receipt.sourceMode !== "sqlite" ||
    receipt.manifestHash !== pins.manifestHash ||
    receipt.sourceSnapshotHash !== measured.proof.sourceSnapshotHash ||
    receipt.catalogHash !== measured.proof.catalogHash ||
    receipt.closedWitnessHash !== measured.proof.closedWitnessHash ||
    receipt.runtimeClosureHash !== measured.proof.runtimeClosureHash ||
    objectHash(receipt.closedWriter) !== objectHash(measured.facts.process)
  )
    blocked("AdoptBindingMismatch");
  const retained = readJson(
    confined(pins.root, path.join(directory, "runtime-closure.json")),
  );
  const facts = readJson(
    confined(pins.root, path.join(directory, "closed-facts.json")),
  );
  if (
    objectHash(retained) !== receipt.runtimeClosureHash ||
    objectHash(facts) !== receipt.closedWitnessHash
  )
    blocked("JournalInvalid");
  return {
    ...measured.proof,
    exportId: pins.exportId,
    manifestHash: receipt.manifestHash,
  };
}
export function parsedPins(argv) {
  const names = [
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
    "source-class",
    "state-dir",
    "source-path",
  ];
  const { values } = parseArgs({
    args: argv,
    options: Object.fromEntries(
      names.map((name) => [name, { type: "string" }]),
    ),
    strict: true,
  });
  for (const name of [
    "host-name",
    "namespace",
    "host-uid",
    "pvc-uid",
    "pod-uid",
    "request-id",
    "maintenance-id",
    "state-dir",
    "source-path",
    "source-class",
  ])
    if (!values[name]) blocked("JournalInvalid");
  if (
    !["sqlite-pvc", "sqlite-external-exported"].includes(values["source-class"])
  )
    blocked("StoreModeUnknown");
  if (values["source-class"] === "sqlite-external-exported")
    for (const name of ["root", "export-id", "manifest-hash"])
      if (!values[name]) blocked("JournalInvalid");
  for (const name of ["state-dir", "source-path"])
    if (!path.isAbsolute(values[name])) blocked("LayoutUnsafe");
  return {
    hostName: values["host-name"],
    namespace: values.namespace,
    hostUid: values["host-uid"],
    pvcUid: values["pvc-uid"],
    podUid: values["pod-uid"],
    requestId: values["request-id"],
    maintenanceId: values["maintenance-id"],
    exportId: values["export-id"],
    manifestHash: values["manifest-hash"],
    sourceClass: values["source-class"],
    stateDir: path.resolve(values["state-dir"]),
    sourcePath: path.resolve(values["source-path"]),
    root: values.root ? path.resolve(values.root) : undefined,
  };
}
const invoked =
  process.argv[1] === "-"
    ? import.meta.url.endsWith("/[eval1]")
    : process.argv[1] &&
      path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const pins = parsedPins(process.argv.slice(2));
    const revision = await freshChallenge(pins, "prepare");
    const proof = await verifyPhysicalReceipt(pins);
    if ((await freshChallenge(pins, "prepare")) !== revision)
      blocked("AdoptBindingMismatch");
    process.stdout.write(`${JSON.stringify(proof)}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ proofVersion: 1, outcome: "blocked", reason: error.reason ?? "HostAuthorityUnavailable" })}\n`,
    );
    process.exitCode = 1;
  }
}
