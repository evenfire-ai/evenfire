import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  blocked,
  fileHash,
  processIdentity,
  regular,
} from "./verify-inline.mjs";
function publish(directory, name, value) {
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
  fs.renameSync(temporary, path.join(directory, name));
}
export async function superviseDesktop() {
  if (
    process.getuid?.() !== 1001 ||
    process.platform !== "linux" ||
    !process.version.startsWith("v24.")
  )
    blocked("DesktopSupervisorUnsupported");
  const appRoot = "/app/mcp-host";
  const script = fs.realpathSync(path.join(appRoot, "dist/main.js"));
  const ownScript = fs.realpathSync(fileURLToPath(import.meta.url));
  for (const file of [script, ownScript])
    regular(file, { owner: 0, readonly: true });
  for (const directory of [
    "/app",
    appRoot,
    path.join(appRoot, "dist"),
    path.dirname(ownScript),
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
  const directory = "/config/.mcp-host-supervisor";
  if (fs.existsSync(directory)) blocked("SupervisorAlreadyStarted");
  fs.mkdirSync(directory, { mode: 0o700 });
  const output = fs.openSync(
    "/config/.mcp-host.log",
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_TRUNC |
      fs.constants.O_NOFOLLOW,
    0o600,
  );
  const child = spawn(process.execPath, [script], {
    cwd: appRoot,
    env: { ...process.env, DISPLAY: ":1" },
    stdio: ["ignore", output, output],
  });
  const result = new Promise((resolve) => {
    child.once("error", () => resolve({ code: 1, signal: null }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const identity = processIdentity(child.pid);
  if (!identity || identity.uid !== 1001) {
    child.kill("SIGTERM");
    blocked("WriterIdentityUnknown");
  }
  // These records are diagnostics, never authority: UID1001 can alter them.
  // Trusted HCC code recomputes kernel/process/fence/source facts independently.
  const started = {
    supervisorVersion: 1,
    phase: "running",
    process: identity,
    mainSha256: fileHash(script),
    supervisorSha256: fileHash(ownScript),
  };
  publish(directory, "started.json", started);
  let done = false;
  let terminating = false;
  const terminate = () => {
    terminating = true;
    if (!done) child.kill("SIGTERM");
    else process.exit(0);
  };
  process.on("SIGTERM", terminate);
  process.on("SIGINT", terminate);
  process.on("SIGHUP", () => {});
  const exited = await result;
  done = true;
  fs.fsyncSync(output);
  fs.closeSync(output);
  publish(directory, "exit.json", { ...started, ...exited, phase: "exited" });
  // One child per Pod. Maintenance never relaunches it. Exit zero is not a
  // drain/SQLite ACK; only the runtime protocol plus physical checks prove that.
  if (terminating)
    process.exit(exited.code === 0 && exited.signal === null ? 0 : 1);
  setInterval(() => {}, 60000);
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await superviseDesktop();
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ event: "desktop-supervisor-blocked", reason: error.reason ?? "ImageFloorMissing" })}\n`,
    );
    process.exitCode = 1;
  }
}
