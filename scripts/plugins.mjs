#!/usr/bin/env node
/**
 * dsh-plugins: discover every dsh plugin under the repo root and install it
 * into dsh profile(s).
 *
 *   node scripts/plugins.mjs list                     list plugins + target profiles
 *   node scripts/plugins.mjs install                  install all plugins (default)
 *   node scripts/plugins.mjs install --dry-run        preview, change nothing
 *   node scripts/plugins.mjs install --profile <name> install everything into one profile
 *
 * Discovery: subdirectories of the repo root whose package.json declares a
 * `dsh` field — `dsh.bundle.patch` (a bundle) or `dsh.plugin` (a plugin).
 *
 * Target profiles come from plugins.json at the repo root, keyed by the
 * plugin's directory name, e.g.
 *   { "acp4idea": ["acp"] }
 * A plugin without an entry falls back to the `default` profile.
 *
 * Installation delegates to `dsh plugin --profile <name> add link:<abs-dir>`:
 * dsh forwards the call to pnpm inside the profile directory and then
 * reconciles the profile's `dsh.profile.bundles` layer list. The `link:`
 * protocol keeps the profile pointing at this live checkout, so changes to
 * the plugin source take effect after rebuilding without a re-install.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = join(ROOT, "plugins.json");
const DEFAULT_PROFILES = ["default"];

const HELP = `dsh-plugins — install every plugin in this repo into dsh profiles

Usage:
  node scripts/plugins.mjs list
      List discovered plugins and the dsh profiles they would be installed into.

  node scripts/plugins.mjs install
      Install all plugins into their configured profiles (default command).

  node scripts/plugins.mjs install --dry-run
      Print the dsh commands that would run, without changing anything.

  node scripts/plugins.mjs install --profile <name>
      Install every plugin into one profile, ignoring plugins.json.

Plugin discovery: subdirectories whose package.json declares a "dsh" field
(dsh.bundle.patch = bundle, dsh.plugin = plugin).

Target profiles: plugins.json at the repo root maps a plugin directory to the
dsh profile(s) it should be installed into:
    { "<plugin-dir>": ["<profile>", ...] }
Unconfigured plugins fall back to the "default" profile (created on first use).`;

function toPosix(path) {
  return process.platform === "win32" ? path.replaceAll("\\", "/") : path;
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function discoverPlugins() {
  const entries = await readdir(ROOT, { withFileTypes: true });
  const plugins = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const pkg = await readJson(join(ROOT, entry.name, "package.json"));
    if (!pkg?.dsh) continue;
    const isBundle = typeof pkg.dsh.bundle?.patch === "string";
    if (!isBundle && !pkg.dsh.plugin) continue;
    plugins.push({
      dir: entry.name,
      name: pkg.name ?? entry.name,
      version: pkg.version ?? "0.0.0",
      kind: isBundle ? "bundle" : "plugin",
      spec: `link:${toPosix(join(ROOT, entry.name))}`,
    });
  }
  return plugins.sort((a, b) => a.dir.localeCompare(b.dir));
}

function readConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (error) {
    console.warn(`warning: cannot read ${CONFIG_PATH} (${error.message}) — using empty config`);
    return {};
  }
}

function profilesFor(plugin, config, override) {
  if (override) return [override];
  const entry = config[plugin.dir] ?? config[plugin.name];
  const list = typeof entry === "string" ? [entry] : entry;
  if (Array.isArray(list) && list.length > 0) return [...new Set(list)];
  return [...DEFAULT_PROFILES];
}

function runDsh(args) {
  // `dsh` is a .ps1/.cmd shim on Windows; shell:true lets cmd.exe resolve it.
  const result = spawnSync("dsh", args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) {
    console.error(`error: failed to launch dsh: ${result.error.message}`);
    process.exit(1);
  }
  return result.status ?? 1;
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? "install";
  const dryRun = argv.includes("--dry-run");
  const overrideIndex = argv.indexOf("--profile");
  const profileOverride = overrideIndex >= 0 && argv[overrideIndex + 1] ? argv[overrideIndex + 1] : null;

  if (command === "--help" || command === "-h" || command === "help") {
    console.log(HELP);
    return;
  }
  if (!["list", "install"].includes(command)) {
    console.error(`error: unknown command "${command}" (expected "list" or "install")`);
    console.error(HELP);
    process.exit(1);
  }

  const plugins = await discoverPlugins();
  const config = readConfig();

  if (plugins.length === 0) {
    console.log('no dsh plugins found under the repo root (a directory with a package.json declaring a "dsh" field)');
    return;
  }

  const jobs = [];
  for (const plugin of plugins) {
    for (const profile of profilesFor(plugin, config, profileOverride)) {
      jobs.push({ plugin, profile });
    }
  }

  if (command === "list") {
    console.log(`found ${plugins.length} dsh plugin(s) under ${ROOT}:\n`);
    for (const plugin of plugins) {
      const profiles = profilesFor(plugin, config, profileOverride);
      const fallback = profiles.length === 1 && profiles[0] === "default" && !config[plugin.dir] && !config[plugin.name];
      const note = fallback ? "  (fallback default — add an entry to plugins.json to override)" : "";
      console.log(`  ${plugin.dir.padEnd(20)} ${plugin.name}@${plugin.version}  ${plugin.kind}  ->  ${profiles.join(", ")}${note}`);
    }
    return;
  }

  for (const { plugin, profile } of jobs) {
    const args = ["plugin", "--profile", profile, "add", plugin.spec];
    if (dryRun) {
      console.log(`[dry-run] dsh ${args.join(" ")}`);
      continue;
    }
    console.log(`\n==> ${plugin.name} (${plugin.dir}) -> dsh profile "${profile}"`);
    const code = runDsh(args);
    if (code !== 0) {
      console.error(`error: installation failed for ${plugin.dir} -> profile "${profile}" (exit ${code})`);
      process.exit(code);
    }
  }
  console.log(`\ndone: ${dryRun ? "would install" : "installed"} ${jobs.length} plugin/profile combination(s)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
