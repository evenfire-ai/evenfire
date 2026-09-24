// Preloaded with `node --import` by test-run-with-deadline-reap.sh.
//
// On macOS, kill(-pgid, SIGKILL) returns EPERM when the only processes left in
// the group are already exiting, so the runner's final reap can be refused
// after the wrapped command has exited. That race is not reproducible on
// demand, so this preload makes every signal in DENY_GROUP_SIGNALS (default
// SIGKILL) addressed to a process group fail the same way. Signal 0 still
// reaches the real kill(), so the runner's liveness probe reports the group's
// real state; zombie-group-member.py covers the zombie-only state, where the
// real probe answers EPERM on macOS.
//
// Each denial is logged with the group's real state just before it
// (before=alive|ESRCH|EPERM from a real kill(pid, 0)), so a test can tell
// whether the injected refusal hit a live group or an empty one.
//
// DENY_GROUP_CLOCK_STEP_MS, when set, steps the wall clock (Date.now) forward
// by that amount at the first liveness probe after a denial, i.e. inside the
// runner's reap wait, the way an NTP step would. The step is logged as
// `clock-step ms=<n>` so a test can prove it happened.
import { appendFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import process from "node:process";

const log = process.env.DENY_GROUP_SIGKILL_LOG;
if (!log) throw new Error("DENY_GROUP_SIGKILL_LOG is required");

const denied = new Set((process.env.DENY_GROUP_SIGNALS ?? "SIGKILL").split(","));
for (const name of denied) {
  if (!Number.isInteger(osConstants.signals[name])) {
    throw new Error(`DENY_GROUP_SIGNALS has an unknown signal: ${name}`);
  }
}

// process.kill accepts a signal name or number; compare by name.
function signalName(signal) {
  if (typeof signal === "string") return signal;
  return Object.keys(osConstants.signals).find(
    (name) => osConstants.signals[name] === signal,
  );
}

const clockStep = Number(process.env.DENY_GROUP_CLOCK_STEP_MS ?? 0);
if (!Number.isInteger(clockStep) || clockStep < 0) {
  throw new Error("DENY_GROUP_CLOCK_STEP_MS must be a non-negative integer");
}
const realNow = Date.now.bind(Date);
let clockOffset = 0;
let clockStepPending = false;
if (clockStep > 0) Date.now = () => realNow() + clockOffset;

const realKill = process.kill.bind(process);

function groupState(pid) {
  try {
    realKill(pid, 0);
    return "alive";
  } catch (error) {
    return error.code;
  }
}

process.kill = (pid, signal = "SIGTERM") => {
  if (pid < 0 && signal === 0 && clockStepPending) {
    clockStepPending = false;
    clockOffset = clockStep;
    appendFileSync(log, `clock-step ms=${clockStep}\n`);
  }
  const name = signalName(signal);
  if (pid < 0 && denied.has(name)) {
    appendFileSync(log, `denied pgid=${-pid} signal=${name} before=${groupState(pid)}\n`);
    if (clockStep > 0 && clockOffset === 0) clockStepPending = true;
    throw Object.assign(new Error("kill EPERM"), {
      code: "EPERM",
      errno: -1,
      syscall: "kill",
    });
  }
  return realKill(pid, signal);
};
