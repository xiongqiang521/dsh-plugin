import { spawn } from "node:child_process";
const exe = "C:\\code\\web\\dsh-plugins\\acp4idea\\bin\\acp4idea.exe";
const child = spawn(exe, [], { stdio: ["pipe", "pipe", "pipe"] });
child.stdout.on("data", (d) => process.stdout.write("<< " + d.toString()));
child.stderr.on("data", (d) => process.stderr.write("[err] " + d.toString()));
child.on("exit", (c) => { console.log("\n[exe exited] " + c); process.exit(0); });
child.on("error", (e) => { console.error("[spawn error]", e); process.exit(1); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(4000); // let dsh boot
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } }) + "\n");
await sleep(4000);
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "C:\\code\\web\\dsh-plugins\\acp4idea" } }) + "\n");
await sleep(8000);
console.log("[closing stdin]");
child.stdin.end();
await sleep(4000);
console.log("[done]");
