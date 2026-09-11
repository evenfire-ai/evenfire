#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import process from "node:process";

const EXIT_TIMEOUT = 124;
const EXIT_COMMAND_CANNOT_EXECUTE = 126;
const EXIT_COMMAND_NOT_FOUND = 127;
const HANDLED_SIGNALS = ["SIGHUP", "SIGQUIT", "SIGINT", "SIGTERM"];

function usage(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write(
    "usage: run-with-deadline.mjs --timeout-seconds N [--heartbeat-seconds N] " +
      "[--kill-grace-seconds N] --label LABEL -- command [args...]\n",
  );
  process.exit(2);
}

function positiveInteger(flag, raw, maximum) {
  if (!/^[1-9][0-9]*$/.test(raw ?? "")) {
    usage(`${flag} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) {
    usage(`${flag} must be no greater than ${maximum}`);
  }
  return value;
}

let timeoutSeconds;
let heartbeatSeconds = 30;
let killGraceSeconds = 5;
let label;
let commandIndex = -1;

for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (arg === "--") {
    commandIndex = index + 1;
    break;
  }
  const value = process.argv[index + 1];
  switch (arg) {
    case "--timeout-seconds":
      timeoutSeconds = positiveInteger(arg, value, 86_400);
      index += 1;
      break;
    case "--heartbeat-seconds":
      heartbeatSeconds = positiveInteger(arg, value, 3_600);
      index += 1;
      break;
    case "--kill-grace-seconds":
      killGraceSeconds = positiveInteger(arg, value, 300);
      index += 1;
      break;
    case "--label":
      label = value;
      index += 1;
      break;
    default:
      usage(`unknown argument: ${arg}`);
  }
}

if (timeoutSeconds === undefined) usage("--timeout-seconds is required");
if (!label || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(label)) {
  usage("--label must use only A-Z, a-z, 0-9, dot, underscore, colon, or dash");
}
if (commandIndex < 0 || commandIndex >= process.argv.length) {
  usage("a command is required after --");
}

const command = process.argv[commandIndex];
const args = process.argv.slice(commandIndex + 1);
const startedAt = process.hrtime.bigint();
const elapsedMilliseconds = () =>
  Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
const report = (event, fields = "") => {
  const suffix = fields ? ` ${fields}` : "";
  process.stderr.write(`[HARNESS_DEADLINE] label=${label} event=${event}${suffix}\n`);
};
const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

report("start", `timeoutSeconds=${timeoutSeconds}`);

const child = spawn(command, args, {
  detached: process.platform !== "win32",
  env: process.env,
  stdio: "inherit",
});

let completionResolved = false;
const completion = new Promise((resolve) => {
  const finish = (result) => {
    if (completionResolved) return;
    completionResolved = true;
    resolve(result);
  };
  child.once("error", (error) => finish({ kind: "spawn-error", error }));
  child.once("exit", (code, signal) => finish({ kind: "exit", code, signal }));
});

function signalExitCode(signal) {
  const signalNumber = osConstants.signals[signal];
  return Number.isInteger(signalNumber) ? 128 + signalNumber : 1;
}

function spawnErrorExitCode(error) {
  if (error?.code === "ENOENT") return EXIT_COMMAND_NOT_FOUND;
  if (["EACCES", "EPERM", "ENOEXEC", "EISDIR"].includes(error?.code)) {
    return EXIT_COMMAND_CANNOT_EXECUTE;
  }
  return 1;
}

function killProcessGroup(signal) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function processGroupExists() {
  if (!child.pid) return false;
  if (process.platform === "win32") {
    return child.exitCode === null && child.signalCode === null;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function waitForProcessGroupExit(milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (processGroupExists() && Date.now() < deadline) {
    await wait(Math.min(25, Math.max(1, deadline - Date.now())));
  }
  return !processGroupExists();
}

const heartbeat = setInterval(() => {
  report("heartbeat", `elapsedSeconds=${Math.floor(elapsedMilliseconds() / 1_000)}`);
}, heartbeatSeconds * 1_000);
heartbeat.unref();

let timeoutHandle;
const timeout = new Promise((resolve) => {
  timeoutHandle = setTimeout(() => resolve({ kind: "timeout" }), timeoutSeconds * 1_000);
});

let resolveParentSignal;
let firstParentSignal = null;
let teardownStarted = false;
let signalEscalated = false;
const parentSignal = new Promise((resolve) => {
  resolveParentSignal = resolve;
});
const signalHandlers = new Map();
for (const signal of HANDLED_SIGNALS) {
  const handler = () => {
    if (firstParentSignal === null && !teardownStarted) {
      firstParentSignal = signal;
      resolveParentSignal({ kind: "parent-signal", signal });
      return;
    }

    if (!signalEscalated) {
      report("signal-escalated", `signal=${signal} action=SIGKILL`);
      signalEscalated = true;
    }
    teardownStarted = true;
    killProcessGroup("SIGKILL");
  };
  signalHandlers.set(signal, handler);
  process.on(signal, handler);
}

const first = await Promise.race([completion, timeout, parentSignal]);
clearInterval(heartbeat);
clearTimeout(timeoutHandle);
teardownStarted = first.kind === "timeout" || first.kind === "parent-signal";

let finalExitCode;

if (first.kind === "exit") {
  const durationMs = elapsedMilliseconds();
  if (first.signal) {
    finalExitCode = signalExitCode(first.signal);
    report(
      "exit",
      `durationMs=${durationMs} signal=${first.signal} exitCode=${finalExitCode}`,
    );
  } else {
    finalExitCode = first.code ?? 1;
    report("exit", `durationMs=${durationMs} exitCode=${finalExitCode}`);
  }
  // A bounded operation may not daemonize work behind the runner. If the
  // direct child exited while a helper remained in its process group, reap the
  // helper before returning the child's exact status.
  killProcessGroup("SIGKILL");
  await waitForProcessGroupExit(1_000);
} else if (first.kind === "spawn-error") {
  finalExitCode = spawnErrorExitCode(first.error);
  report("spawn-failed", `durationMs=${elapsedMilliseconds()} exitCode=${finalExitCode}`);
} else {
  const terminatingSignal = first.kind === "timeout" ? "SIGTERM" : first.signal;
  finalExitCode =
    first.kind === "timeout" ? EXIT_TIMEOUT : signalExitCode(first.signal);
  report(
    first.kind === "timeout" ? "timeout" : "interrupted",
    `durationMs=${elapsedMilliseconds()} signal=${terminatingSignal} exitCode=${finalExitCode}`,
  );

  if (!signalEscalated) killProcessGroup(terminatingSignal);
  await waitForProcessGroupExit(killGraceSeconds * 1_000);

  // Always address the original process group after graceful teardown. The
  // direct child may have exited while a credential-helper descendant ignored
  // the first signal; killing by negative PGID closes that otherwise invisible
  // orphan path. A repeated parent signal reaches this same action immediately
  // through the handlers above.
  killProcessGroup("SIGKILL");
  await waitForProcessGroupExit(1_000);
  report("terminated", `durationMs=${elapsedMilliseconds()} exitCode=${finalExitCode}`);
}

for (const [signal, handler] of signalHandlers) {
  process.removeListener(signal, handler);
}
process.exitCode = finalExitCode;
