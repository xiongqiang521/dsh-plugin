#!/usr/bin/env node
/**
 * acp-tee — 抓包代理：把 IDEA 的 ACP 命令指向本脚本，它会透传 stdio 到 dsh，
 * 并把双向字节记录到 C:\code\web\dsh-plugins\acp4idea\acp-traffic.log。
 */
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const LOG = "C:\\code\\web\\dsh-plugins\\acp4idea\\acp-traffic.log";
const PROFILE = process.env.DSH_ACP_PROFILE ?? "acp";
const DSH_BIN = process.env.DSH_BIN ?? "dsh";
appendFileSync(LOG, "=== acp-tee start " + new Date().toISOString() + " ===\n");

const child = spawn("cmd.exe", ["/c", DSH_BIN, "--profile", PROFILE], { stdio: ["pipe", "pipe", "inherit"] });

child.stdout.on("data", (d) => { appendFileSync(LOG, "[agent->client] " + d.toString()); process.stdout.write(d); });
child.stderr.on("data", (d) => { appendFileSync(LOG, "[agent-stderr] " + d.toString()); process.stderr.write(d); });

process.stdin.on("data", (d) => { appendFileSync(LOG, "[client->agent] " + d.toString()); child.stdin.write(d); });
process.stdin.on("end", () => { appendFileSync(LOG, "[stdin-end]\n"); child.stdin.end(); });
process.stdin.on("error", (e) => appendFileSync(LOG, "[stdin-error] " + e.message + "\n"));

child.on("error", (e) => { appendFileSync(LOG, "[spawn-error] " + e.message + "\n"); process.exit(1); });
child.on("exit", (code) => { appendFileSync(LOG, "[exit] " + code + "\n"); process.exit(code ?? 0); });
