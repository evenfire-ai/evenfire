// Preloaded with `node --import` by test-run-with-deadline-reap.sh.
//
// On macOS, kill(-pgid, SIGKILL) returns EPERM when the only processes left in
// the group are already exiting, so the runner's final reap can be refused
// after the wrapped command has exited. That race is not reproducible on
// demand, so this preload makes every signal in DENY_GROUP_SIGNALS (default
// SIGKILL) addressed to a process group fail the same way. Signal 0 still
// reaches the real kill(), so the runner's liveness probe reports whether the
// group is actually gone.
//
// Each denial is logged with the group's real state just before it
// (before=alive|ESRCH|EPERM from a real kill(pid, 0)), so a test can tell
// whether the injected refusal hit a live group or an empty one.
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
  const name = signalName(signal);
  if (pid < 0 && denied.has(name)) {
    appendFileSync(log, `denied pgid=${-pid} signal=${name} before=${groupState(pid)}\n`);
    throw Object.assign(new Error("kill EPERM"), {
      code: "EPERM",
      errno: -1,
      syscall: "kill",
    });
  }
  return realKill(pid, signal);
};
