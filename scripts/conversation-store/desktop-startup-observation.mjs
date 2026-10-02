// Development-only image-entrypoint observation. No bootstrap or service readiness proof.
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

function categoriesFrom(text) {
  const categories = [];
  for (const [category, pattern] of [
    ["S6RuntimePermission", /s6-[^\n]*fatal:[^\n]*(?:\/run|[Pp]ermission denied|[Oo]peration not permitted)/],
    ["S6InitFailure", /s6-[^\n]*fatal:|s6-overlay[^\n]*(?:error|fatal)/],
    ["MissingAuthentication", /enableAuth=true but[^\n]*is not set|runtime authentication is required|runtime token vars missing/],
    ["MissingConfiguration", /Missing required environment variable:|CanonicalStore(?:RuntimeContract|StateDir)Missing/],
    ["SupervisorBlocked", /desktop-supervisor-blocked|mcp-host-start-blocked/],
  ]) if (pattern.test(text)) categories.push(category);
  return categories;
}

function launchCategoryFrom(text) {
  for (const [category, pattern] of [
    ["DockerLoggingFailed", /failed to initialize logging driver|unknown log opt|invalid log opt/i],
    ["DockerMountFailed", /invalid mount config|error (?:while )?mounting|failed to mount/i],
    ["DockerPolicyRejected", /invalid security (?:option|opt)|invalid capability|(?:no-new-privileges|seccomp|apparmor)[^\n]*(?:invalid|denied|failed|not supported)/i],
    ["OciCreateFailed", /OCI runtime (?:create|start) failed|failed to create (?:shim )?task|runc (?:create|start) failed/i],
    ["DockerLaunchConfigurationFailed", /invalid argument|invalid (?:size|value|reference format)|unknown (?:shorthand )?flag/i],
    ["DockerDaemonUnavailable", /cannot connect to[^\n]*docker daemon|error during connect/i],
  ]) if (pattern.test(text)) return category;
  return "UnknownLaunchFailure";
}

function readLimited(file, maximum = 65536) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("NotRegular");
    const buffer = Buffer.alloc(Math.min(stat.size, maximum));
    fs.readSync(descriptor, buffer, 0, buffer.length, Math.max(0, stat.size - buffer.length));
    return buffer.toString("utf8");
  } finally { fs.closeSync(descriptor); }
}

function processFacts(pid) {
  const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const values = (name) => status.match(new RegExp(`^${name}:\\s+(.+)$`, "m"))?.[1].trim().split(/\s+/);
  return {
    pid, ppid: Number(fields[1]), startTime: fields[19], state: fields[0],
    uid: values("Uid")?.map(Number), gid: values("Gid")?.map(Number),
    noNewPrivs: Number(values("NoNewPrivs")?.[0]),
    caps: Object.fromEntries(["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"].map((name) => [name, values(name)?.[0]])),
  };
}

function factsValid(fact) {
  return fact && Number.isSafeInteger(fact.pid) && fact.pid > 0 &&
    Number.isSafeInteger(fact.ppid) && fact.ppid >= 0 && /^\d+$/.test(fact.startTime ?? "") &&
    ["R", "S", "D", "I"].includes(fact.state) &&
    [fact.uid, fact.gid].every((ids) => Array.isArray(ids) && ids.length === 4 && ids.every((id) => Number.isSafeInteger(id) && id >= 0 && id <= 4294967295)) &&
    [0, 1].includes(fact.noNewPrivs) && ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"].every((name) => /^[0-9a-f]{16}$/.test(fact.caps?.[name] ?? ""));
}
function policyMatches(fact) {
  return factsValid(fact) && [fact.uid, fact.gid].every((ids) => ids.every((id) => id === 1001)) &&
    fact.noNewPrivs === 1 && Object.values(fact.caps).every((value) => value === "0000000000000000");
}

function snapshot() {
  const result = { init: processFacts(1), supervisors: [], children: [], childExitRecorded: false, categories: [] };
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^[1-9]\d*$/.test(entry)) continue;
    try {
      const argv = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").filter(Boolean);
      if (!/(?:^|\/)node$/.test(fs.readlinkSync(`/proc/${entry}/exe`)) || argv.length !== 2) continue;
      const destination = argv[1] === "/app/mcp-host/ops/desktop-supervisor.mjs" ? result.supervisors :
        argv[1] === "/app/mcp-host/dist/main.js" ? result.children : null;
      if (destination) {
        const fact = processFacts(Number(entry));
        if (!["Z", "X"].includes(fact.state)) destination.push(fact);
      }
    } catch { /* A process disappearing during this read is absent, never live. */ }
  }
  try { result.childExitRecorded = JSON.parse(readLimited("/config/.mcp-host-supervisor/exit.json", 8192)).phase === "exited"; } catch {}
  try { result.categories = categoriesFrom(readLimited("/config/.mcp-host.log")); } catch {}
  return result;
}

async function observe() {
  const deadline = performance.now() + 30000;
  const supervisorIdentities = new Set(), childIdentities = new Set();
  let last, singleChildEntered = false, reason = "MissingSupervisor", windowCompleted = false;
  try {
    while (true) {
      last = snapshot();
      for (const [facts, identities] of [[last.supervisors, supervisorIdentities], [last.children, childIdentities]])
        for (const fact of facts) identities.add(`${fact.pid}:${fact.startTime}`);
      const directChild = last.supervisors.length === 1 && last.children.length === 1 && last.children[0].ppid === last.supervisors[0].pid;
      if (directChild) singleChildEntered = true;
      if (!policyMatches(last.init) || [...last.supervisors, ...last.children].some((fact) => !policyMatches(fact))) { reason = "ProcessPolicyMismatch"; break; }
      if (supervisorIdentities.size > 1 || childIdentities.size > 1 || last.supervisors.length > 1 || last.children.length > 1) { reason = "MultipleProcesses"; break; }
      if (last.childExitRecorded || (singleChildEntered && last.children.length === 0)) { reason = "ChildExited"; break; }
      if (supervisorIdentities.size > 0 && last.supervisors.length === 0) { reason = "SupervisorExited"; break; }
      if (last.categories.includes("MissingAuthentication") || last.categories.includes("MissingConfiguration")) { reason = "ChildConfigurationFailure"; break; }
      const remaining = deadline - performance.now();
      if (remaining <= 0) { windowCompleted = true; reason = directChild ? "EntryObserved" : "MissingSupervisorOrChild"; break; }
      // Poll against the monotonic deadline; this never substitutes a sleep for a condition.
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, remaining)));
    }
  } catch { reason = "ObservationUnavailable"; }
  process.stdout.write(`${JSON.stringify({ proofVersion: 1, reason, singleChildEntered, windowCompleted, distinctSupervisors: supervisorIdentities.size, distinctChildren: childIdentities.size, last })}\n`);
}

function summarize(args) {
  const [proofFile, observedStateFile, finalStateFile, categoriesFile, transportRaw, termination] = args;
  const state = (file) => {
    const match = fs.readFileSync(file, "utf8").trim().match(/^(created|running|paused|restarting|removing|exited|dead) ([0-9]{1,3}) (true|false)$/);
    if (!match || Number(match[2]) > 255) throw new Error("StateInvalid");
    return { status: match[1], exitCode: Number(match[2]), oomKilled: match[3] === "true" };
  };
  const transportExit = Number(transportRaw);
  if (!Number.isSafeInteger(transportExit) || transportExit < 0 || transportExit > 255 || !["probe-stop", "already-exited"].includes(termination)) throw new Error("ProofInvalid");
  const observed = state(observedStateFile), final = state(finalStateFile);
  let proof = null;
  if (transportExit === 0) proof = JSON.parse(fs.readFileSync(proofFile, "utf8"));
  const allowed = ["S6RuntimePermission", "S6InitFailure", "MissingAuthentication", "MissingConfiguration", "SupervisorBlocked"];
  const categories = [...new Set([...JSON.parse(fs.readFileSync(categoriesFile, "utf8")), ...(proof?.last?.categories ?? [])])];
  if (categories.some((category) => !allowed.includes(category))) throw new Error("CategoriesInvalid");
  const last = proof?.last;
  const live = proof?.proofVersion === 1 && proof.reason === "EntryObserved" && proof.singleChildEntered === true &&
    proof.windowCompleted === true && proof.distinctSupervisors === 1 && proof.distinctChildren === 1 &&
    last?.supervisors?.length === 1 && last?.children?.length === 1 && last.childExitRecorded === false &&
    last.children[0].ppid === last.supervisors[0].pid && [last.init, ...last.supervisors, ...last.children].every(policyMatches);
  const entered = proof?.singleChildEntered === true;
  let category = "ObservationTransportFailed";
  if (proof) category = ["EntryObserved", "ProcessPolicyMismatch", "MultipleProcesses", "ChildExited", "SupervisorExited", "ChildConfigurationFailure", "MissingSupervisorOrChild", "ObservationUnavailable"].includes(proof.reason) ? proof.reason : "ObservationInvalid";
  if (proof && category === "EntryObserved" && !live) {
    category = last?.supervisors?.length > 1 || last?.children?.length > 1 || proof.distinctSupervisors > 1 || proof.distinctChildren > 1 ? "MultipleProcesses" :
      last?.supervisors?.length !== 1 || last?.children?.length !== 1 ? "MissingSupervisorOrChild" :
      [last.init, ...last.supervisors, ...last.children].some((fact) => !policyMatches(fact)) ? "ProcessPolicyMismatch" : "ObservationInvalid";
  }
  if (observed.oomKilled || final.oomKilled) category = "OutOfMemory";
  else if (!entered && categories.includes("S6RuntimePermission")) category = "S6RuntimePermission";
  else if (!entered && categories.includes("S6InitFailure")) category = "S6InitFailure";
  else if (categories.includes("MissingAuthentication")) category = "MissingAuthentication";
  else if (categories.includes("MissingConfiguration")) category = "MissingConfiguration";
  else if (observed.status !== "running") category = "ContainerExited";
  const success = live && category === "EntryObserved" && observed.status === "running" && final.status === "exited" && termination === "probe-stop";
  // Project only fixed fields. Neither child records nor log text are authority.
  const identity = (fact) => factsValid(fact) ? { pid: fact.pid, ppid: fact.ppid, uid: fact.uid, gid: fact.gid, noNewPrivs: fact.noNewPrivs, caps: Object.fromEntries(["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"].map((name) => [name, fact.caps[name]])) } : null;
  process.stdout.write(`${JSON.stringify({ status: success ? "EntryObserved" : "Failed", category, scope: "image-entrypoint-policy-only", singleChildEntered: entered ? "observed" : "not-observed", windowCompleted: proof?.windowCompleted === true, transportTimedOut: transportExit === 124, transportExit, observed, final, termination, init: identity(last?.init), supervisor: identity(last?.supervisors?.[0]), child: identity(last?.children?.[0]), categories })}\n`);
  process.exitCode = success ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    switch (process.argv[2]) {
      case "--remote-source":
        process.stdout.write(`import * as fs from "node:fs";\n${[categoriesFrom, readLimited, processFacts, factsValid, policyMatches, snapshot, observe].map((fn) => fn.toString()).join("\n")}\nawait observe();\n`);
        break;
      case "--logs":
      case "--launch-output": {
        let tail = "";
        for await (const chunk of process.stdin) tail = (tail + chunk.toString("utf8")).slice(-65536);
        if (process.argv[2] === "--launch-output") {
          const ids = [...new Set(tail.split(/\r?\n/).filter((line) => /^[0-9a-f]{64}$/.test(line)))];
          // Only a full container ID and one fixed category leave this stream.
          process.stdout.write(`${ids.length === 1 ? ids[0] : "unknown"}\n${launchCategoryFrom(tail)}\n`);
        } else process.stdout.write(`${JSON.stringify(categoriesFrom(tail))}\n`);
        break;
      }
      case "--summarize": summarize(process.argv.slice(3)); break;
      default: throw new Error("ArgumentInvalid");
    }
  } catch {
    process.stdout.write('{"status":"Failed","category":"ObservationInvalid","scope":"image-entrypoint-policy-only"}\n');
    process.exitCode = 1;
  }
}
