// Preloaded with `node --import` by test-run-with-deadline-reap.sh.
//
// On macOS, kill(-pgid, SIGKILL) returns EPERM when the only processes left in
// the group are already exiting, so the runner's final reap can be refused
// after the wrapped command has exited. That race is not reproducible on
// demand, so this preload makes every SIGKILL addressed to a process group fail
// the same way. Signal 0 still reaches the real kill(), so the runner's
// liveness probe reports whether the group is actually gone.
import { appendFileSync } from "node:fs";
import process from "node:process";

const log = process.env.DENY_GROUP_SIGKILL_LOG;
if (!log) throw new Error("DENY_GROUP_SIGKILL_LOG is required");

const realKill = process.kill.bind(process);
process.kill = (pid, signal) => {
  if (pid < 0 && signal === "SIGKILL") {
    appendFileSync(log, `denied pgid=${-pid}\n`);
    throw Object.assign(new Error("kill EPERM"), {
      code: "EPERM",
      errno: -1,
      syscall: "kill",
    });
  }
  return realKill(pid, signal);
};
