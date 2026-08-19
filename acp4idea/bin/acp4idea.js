#!/usr/bin/env node
/**
 * acp4idea — launcher for IntelliJ IDEA (and any ACP v1 client).
 *
 * A thin wrapper that boots dsh's `acp` profile as a child process and
 * inherits stdio, so the ACP server's JSON-RPC stream passes straight through
 * to whatever launched it. IDEA's AI Assistant ACP-agent command can point at
 * this file directly (or at `dsh --profile acp`).
 *
 * stdio is `inherit`, never `pipe`: the child owns the real stdin/stdout and
 * this wrapper adds nothing to the protocol stream.
 */
import { spawn } from "node:child_process";

const PROFILE = process.env.DSH_ACP_PROFILE ?? "acp";
const DSH_BIN = process.env.DSH_BIN ?? "dsh";

// On Windows the dsh shim is a .ps1/.cmd script, which CreateProcess (and
// Node's spawn without a shell) cannot execute directly. Wrapping through
// cmd.exe /c lets PATHEXT resolve the real .cmd shim.
const isWindows = process.platform === "win32";
const child = isWindows
  ? spawn("cmd.exe", ["/c", DSH_BIN, "--profile", PROFILE], { stdio: "inherit", env: process.env })
  : spawn(DSH_BIN, ["--profile", PROFILE], { stdio: "inherit", env: process.env });

child.on("error", (error) => {
  process.stderr.write("acp4idea: failed to start " + DSH_BIN + " --profile " + PROFILE + ": " + error.message + "\n");
  process.exit(1);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (!child.killed) child.kill(sig);
  });
}

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
