"""Run one interactive Claude session in a private PTY with a local model and rejecting HTTP proxy."""

import errno
import fcntl
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

run_dir = Path(sys.argv[1])
claude = sys.argv[2]
session_id = sys.argv[3]
config = run_dir / "config"
repo = run_dir / "repo"
env = {
    "HOME": str(run_dir / "home"),
    "CLAUDE_CONFIG_DIR": str(config),
    "PATH": os.environ["PATH"],
    "TMPDIR": os.environ.get("TMPDIR", "/tmp"),
    "LANG": "en_US.UTF-8",
    "TERM": "xterm-256color",
    "SHELL": "/bin/sh",
    "ANTHROPIC_BASE_URL": sys.argv[4],
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "DISABLE_AUTOUPDATER": "1",
    "DISABLE_ERROR_REPORTING": "1",
    "DISABLE_TELEMETRY": "1",
    "ENABLE_TOOL_SEARCH": "false",
    "CFFIXED_USER_HOME": str(run_dir / "home"),
    "HTTP_PROXY": sys.argv[4],
    "HTTPS_PROXY": sys.argv[4],
    "ALL_PROXY": sys.argv[4],
    "NO_PROXY": "127.0.0.1,localhost,::1",
    "GIT_SSH_COMMAND": "/usr/bin/false",
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_CONFIG_GLOBAL": "/dev/null",
    "GIT_CONFIG_COUNT": "2",
    "GIT_CONFIG_KEY_0": "http.proxy",
    "GIT_CONFIG_VALUE_0": sys.argv[4],
    "GIT_CONFIG_KEY_1": "protocol.allow",
    "GIT_CONFIG_VALUE_1": "never",
}
env["ANTHROPIC_API_KEY"] = sys.argv[5]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(repo)
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 48, 128, 0, 0))
    args = [claude, "--model", "claude-sonnet-4-6", "--permission-mode", "default",
            "--tools", "AskUserQuestion", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
            "--setting-sources", "user", "--session-id", session_id,
            "--debug-file", str(run_dir / "debug.log"), "--system-prompt", "This session exercises a local test fixture.",
            "--", "Run the local break delegate acceptance fixture."]
    os.execve(args[0], args, env)

deadline = time.monotonic() + 65
ansi = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[=>]")
with (run_dir / "terminal.txt").open("w", encoding="utf-8") as log:
    try:
        while time.monotonic() < deadline and not (run_dir / "stop").exists():
            if not select.select([fd], [], [], 0.1)[0]:
                continue
            try:
                data = os.read(fd, 65536)
            except OSError as e:
                if e.errno == errno.EIO:
                    break
                raise
            if not data:
                break
            # Answer the terminal's cursor position query. Never type into a question card.
            if b"\x1b[6n" in data:
                os.write(fd, b"\x1b[1;1R")
            clean = ansi.sub("", data.decode("utf-8", errors="replace")).replace("\r", "\n")
            log.write(clean)
            log.flush()
    finally:
        # A macOS PTY can keep an exiting process pinned until its master is drained or closed.
        # Close descriptors before the final wait. Each fallback is bounded to this test's child.
        try:
            os.write(fd, b"/exit")
            time.sleep(0.1)
            os.write(fd, b"\r")
        except OSError:
            pass
        exited = False
        for _ in range(25):
            if os.waitpid(pid, os.WNOHANG)[0]:
                exited = True
                break
            if select.select([fd], [], [], 0.06)[0]:
                try:
                    os.read(fd, 65536)
                except OSError:
                    break
        os.close(fd)
        for sig in (signal.SIGTERM, signal.SIGKILL):
            if exited:
                break
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                pass
            for _ in range(30):
                if os.waitpid(pid, os.WNOHANG)[0]:
                    exited = True
                    break
                time.sleep(0.05)
        if not exited:
            raise RuntimeError("The isolated Claude child did not exit.")
