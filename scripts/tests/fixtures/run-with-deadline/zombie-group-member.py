# Run in the background by the wrapped command of test-run-with-deadline-reap.sh.
#
# Leaves the wrapped command's process group holding only an unreaped zombie,
# with the real kernel and no injected errors: this process forks a member,
# moves itself to a new session (so it is no longer in the group), and keeps
# the member unreaped until the group leader has exited and been reaped by the
# runner. It then records what kill(-pgid, 0), the runner's liveness probe,
# answers in that state (macOS: EPERM, Linux: ok), holds the state across
# several of the runner's 25 ms polls, and reaps the member.
#
# Log lines: `zombie member=<pid>`, `probe=<ok|errno name>`, `reaped member=<pid>`.
import errno
import os
import sys
import time

log = sys.argv[1]


def record(line):
    with open(log, "a", encoding="utf-8") as handle:
        handle.write(line + "\n")


leader = os.getpgid(0)
member = os.fork()
if member == 0:
    os._exit(0)

os.setsid()
# Wait for the member to exit without reaping it.
os.waitid(os.P_PID, member, os.WEXITED | os.WNOWAIT)
record(f"zombie member={member}")

deadline = time.monotonic() + 5
while True:
    try:
        os.kill(leader, 0)
    except ProcessLookupError:
        break
    except PermissionError:
        # macOS answers EPERM for the leader while it is a zombie the runner
        # has not reaped yet; it is still there.
        pass
    if time.monotonic() >= deadline:
        record(f"leader-not-reaped leader={leader}")
        sys.exit(1)
    time.sleep(0.01)

try:
    os.kill(-leader, 0)
    record("probe=ok")
except OSError as error:
    assert error.errno is not None, error
    record(f"probe={errno.errorcode[error.errno]}")

time.sleep(0.2)
os.waitpid(member, 0)
record(f"reaped member={member}")
