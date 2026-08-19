// Interactive ACP client simulation: keep stdin open, log both directions.
import { spawn } from "node:child_process";

const child = spawn("cmd.exe", ["/c", "dsh --profile acp"], { stdio: ["pipe", "pipe", "pipe"] });

child.stdout.on("data", (d) => process.stdout.write("<< " + d.toString()));
child.stderr.on("data", (d) => process.stderr.write("[dsh-stderr] " + d.toString()));
child.on("exit", (code) => { console.log("\n[dsh exited] " + code); process.exit(0); });
child.on("error", (e) => { console.error("spawn error:", e); process.exit(1); });

const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Stage 1: initialize (like JetBrains)
send({ jsonrpc: "2.0", id: 0, method: "initialize", params: {
  protocolVersion: 1,
  clientCapabilities: {
    fs: { readTextFile: true, writeTextFile: true },
    terminal: false,
    auth: { gateway: true },
  },
} });
await sleep(3000);

// Stage 2: session/new
send({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "C:\\code\\web\\dsh-plugins\\acp4idea" } });
await sleep(8000);

// Stage 3: session/set_model (JetBrains probes this)
send({ jsonrpc: "2.0", id: 2, method: "session/set_model", params: { sessionId: "x", modelId: "deepseek-v4-flash" } });
await sleep(2000);

// Stage 4: session/set_mode
send({ jsonrpc: "2.0", id: 3, method: "session/set_mode", params: { sessionId: "x", modeId: "primary" } });
await sleep(2000);

console.log("\n[closing stdin]");
child.stdin.end();
await sleep(3000);
console.log("[done]");
